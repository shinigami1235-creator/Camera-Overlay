'use strict';
/*
 * Camera Overlay — Cygnus Solutions
 *
 * Ghost-overlay alignment camera for consistent before/after clinical
 * photography. No server, no account, no internal photo storage — photos
 * come from and go back to the device's own camera roll.
 *
 * Tilt reference data is embedded into the EXIF ImageDescription tag of
 * every photo this app captures (see META_TAG below), so a photo captured
 * by this app can later be re-picked as a "before" reference and its tilt
 * read back out. Photos NOT captured by this app (older photos, imports)
 * simply have no tilt reference — the app says so rather than guessing.
 * Lighting comparison does not depend on this: it's computed live from
 * pixels, so it works for any before-photo.
 */

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------
const TILT_GREEN_DEG = 2;      // combined beta/gamma delta, degrees
const TILT_YELLOW_DEG = 5;
const LUM_GREEN_PCT = 10;      // % luminance delta vs before photo
const LUM_YELLOW_PCT = 25;
const METER_INTERVAL_MS = 400;
const SAMPLE_W = 64, SAMPLE_H = 48; // downsample size for luminance sampling
const META_TAG = 'COV1:';      // marks our EXIF ImageDescription payload
const LS_KEY = 'camoverlay.settings.v1';
const COMPOSITE_TARGET_H = 900;

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
const state = {
  stream: null,
  videoDevices: [],
  currentDeviceId: null,
  facingMode: 'environment',
  isFrontFacing: false,
  before: { dataUrl: null, lum: null, tilt: null, hasFile: false },
  pin: { xPct: 50, yPct: 50 },
  // Manual correction for the ghost overlay, since the live camera stream
  // and an arbitrary uploaded before-photo can have different native
  // aspect ratios — object-fit:cover crops each to fill the same box
  // differently, so even a perfectly re-framed shot can look offset.
  // Drag/pinch on the stage lets the user compensate.
  ghost: { offsetXPct: 0, offsetYPct: 0, scale: 1, flipped: false },
  tilt: { available: null, live: null, permissionNeeded: false },
  liveLum: null,
  settings: { readout: 'both', opacity: 45 },
  meterTimer: null,
  tiltProbeTimer: null,
  lastCaptured: null, // { afterDataUrl, compositeDataUrl }
};

// ---------------------------------------------------------------------
// DOM cache
// ---------------------------------------------------------------------
let dom = {};

function cacheDom() {
  const id = (x) => document.getElementById(x);
  dom = {
    startOverlay: id('start-overlay'),
    startCameraBtn: id('start-camera-btn'),
    startError: id('start-error'),

    settingsBtn: id('settings-btn'),

    tiltBadge: id('tilt-badge'),
    lightingBadge: id('lighting-badge'),
    enableTiltBtn: id('enable-tilt-btn'),

    stage: id('stage'),
    video: id('video'),
    ghostImg: id('ghost-img'),
    pin: id('pin'),
    meterCanvas: id('meter-canvas'),
    captureCanvas: id('capture-canvas'),

    opacitySlider: id('opacity-slider'),
    opacityPct: id('opacity-pct'),
    loadBeforeBtn: id('load-before-btn'),
    beforeFileInput: id('before-file-input'),
    shutterBtn: id('shutter-btn'),
    flipCamBtn: id('flip-cam-btn'),

    sheetScrim: id('sheet-scrim'),

    settingsSheet: id('settings-sheet'),
    settingsClose: id('settings-close'),
    readoutButtons: Array.from(document.querySelectorAll('#settings-sheet .segmented button')),
    cameraSelect: id('camera-select'),
    flipGhostBtn: id('flip-ghost-btn'),
    resetGhostBtn: id('reset-ghost-btn'),

    reviewSheet: id('review-sheet'),
    reviewClose: id('review-close'),
    reviewAfterImg: id('review-after-img'),
    reviewCompositeWrap: id('review-composite-wrap'),
    reviewCompositeImg: id('review-composite-img'),
    saveAfterBtn: id('save-after-btn'),
    saveCompositeBtn: id('save-composite-btn'),
    saveBothBtn: id('save-both-btn'),
    retakeBtn: id('retake-btn'),

    toast: id('toast'),
  };
}

// ---------------------------------------------------------------------
// Settings persistence (UI prefs only — never photos)
// ---------------------------------------------------------------------
function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch (e) { /* private mode / unavailable — fall back to defaults */ }
}

function saveSettings() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state.settings)); } catch (e) { /* ignore */ }
}

function applySettingsToUI() {
  dom.opacitySlider.value = state.settings.opacity;
  dom.opacityPct.textContent = state.settings.opacity + '%';
  dom.readoutButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.value === state.settings.readout));
}

// ---------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------
function cameraErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Camera permission was denied. Allow camera access in your browser/app settings and try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera was found on this device.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The camera is already in use by another app.';
  }
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    return 'Camera access needs HTTPS. Open this app from its https:// address.';
  }
  return 'Could not start the camera (' + (name || 'unknown error') + ').';
}

function showStartOverlay(message) {
  dom.startOverlay.classList.remove('is-hidden');
  dom.startError.textContent = message || '';
}
function hideStartOverlay() {
  dom.startOverlay.classList.add('is-hidden');
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
}

function setMirror(mirrored) {
  dom.video.style.transform = mirrored ? 'scaleX(-1)' : 'none';
  applyGhostTransform(); // ghost's own mirror follows the same facingMode change
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

// Combines the automatic front-camera mirror with the user's manual
// drag/pinch/flip correction into the ghost image's one transform.
function applyGhostTransform() {
  const mirror = state.isFrontFacing ? -1 : 1;
  const flip = state.ghost.flipped ? -1 : 1;
  const scaleX = mirror * flip * state.ghost.scale;
  dom.ghostImg.style.transform =
    'translate(' + state.ghost.offsetXPct + '%, ' + state.ghost.offsetYPct + '%) scale(' + scaleX + ', ' + state.ghost.scale + ')';
}

function resetGhostTransform() {
  state.ghost.offsetXPct = 0;
  state.ghost.offsetYPct = 0;
  state.ghost.scale = 1;
  applyGhostTransform();
}

async function startCamera(constraintsOverride) {
  stopCamera();
  const constraints = constraintsOverride || {
    // Bias toward a 3:4-ish shape rather than 16:9 widescreen — closer to
    // what most phone camera apps shoot stills in by default, which
    // narrows (but can't fully close) the aspect-ratio gap against an
    // arbitrary uploaded before-photo. No fixed width/height ideal here on
    // purpose — that would fight the aspectRatio hint.
    video: { facingMode: { ideal: state.facingMode }, aspectRatio: { ideal: 3 / 4 } },
    audio: false,
  };
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.stream = stream;
    dom.video.srcObject = stream;
    await dom.video.play();
    const track = stream.getVideoTracks()[0];
    const settings = (track.getSettings && track.getSettings()) || {};
    state.isFrontFacing = settings.facingMode === 'user';
    setMirror(state.isFrontFacing);
    state.currentDeviceId = settings.deviceId || state.currentDeviceId;
    await refreshDeviceList();
    hideStartOverlay();
    startMetering();
  } catch (err) {
    console.warn('getUserMedia failed', err);
    showStartOverlay(cameraErrorMessage(err));
  }
}

async function refreshDeviceList() {
  if (!navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.videoDevices = devices.filter((d) => d.kind === 'videoinput');
    dom.cameraSelect.innerHTML = '';
    state.videoDevices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || ('Camera ' + (i + 1));
      if (d.deviceId === state.currentDeviceId) opt.selected = true;
      dom.cameraSelect.appendChild(opt);
    });
    dom.flipCamBtn.hidden = state.videoDevices.length < 2;
  } catch (e) { /* enumerateDevices can fail before permission — ignore */ }
}

function flipCamera() {
  state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
  startCamera();
}

function switchToDevice(deviceId) {
  startCamera({ video: { deviceId: { exact: deviceId }, aspectRatio: { ideal: 3 / 4 } }, audio: false });
}

// ---------------------------------------------------------------------
// Before-photo loading (ghost overlay + lighting/tilt reference)
// ---------------------------------------------------------------------
function pickBeforePhoto(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => loadBeforeFromDataUrl(reader.result);
  reader.onerror = () => showToast('Could not read that photo');
  reader.readAsDataURL(file);
}

function loadBeforeFromDataUrl(dataUrl) {
  const img = new Image();
  img.onload = () => {
    dom.ghostImg.src = dataUrl;
    dom.ghostImg.classList.add('is-active');
    applyGhostOpacity();
    resetGhostTransform(); // a new photo starts centered/unscaled — old nudges shouldn't carry over
    state.ghost.flipped = false;
    applyGhostTransform();

    state.before.dataUrl = dataUrl;
    state.before.hasFile = true;
    state.before.lum = computeLuminanceFromImage(img);
    state.before.tilt = tryExtractTiltReference(dataUrl);

    updateTiltBadge();
    updateLightingBadge();
    showToast(state.before.tilt
      ? 'Before photo loaded — tilt reference found'
      : 'Before photo loaded — no tilt reference (lighting comparison still works)');
  };
  img.onerror = () => showToast('Could not read that photo');
  img.src = dataUrl;
}

function applyGhostOpacity() {
  dom.ghostImg.style.opacity = state.before.hasFile ? (state.settings.opacity / 100) : 0;
}

function computeLuminance(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data;
  let sum = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    count++;
  }
  return count ? sum / count : null;
}

function computeLuminanceFromImage(img) {
  const c = document.createElement('canvas');
  c.width = SAMPLE_W; c.height = SAMPLE_H;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, SAMPLE_W, SAMPLE_H);
  try {
    return computeLuminance(ctx, SAMPLE_W, SAMPLE_H);
  } catch (e) {
    return null; // extremely unlikely (tainted canvas) since source is a local file
  }
}

function tryExtractTiltReference(dataUrl) {
  if (!dataUrl.startsWith('data:image/jpeg') || typeof piexif === 'undefined') return null;
  try {
    const exif = piexif.load(dataUrl);
    const desc = exif['0th'] && exif['0th'][piexif.ImageIFD.ImageDescription];
    if (!desc || desc.indexOf(META_TAG) !== 0) return null;
    const parsed = JSON.parse(desc.slice(META_TAG.length));
    if (typeof parsed.beta !== 'number' || typeof parsed.gamma !== 'number') return null;
    return parsed;
  } catch (e) {
    return null; // no EXIF, or not a photo this app captured
  }
}

// ---------------------------------------------------------------------
// Live lighting metering
// ---------------------------------------------------------------------
function startMetering() {
  stopMetering();
  state.meterTimer = setInterval(meterTick, METER_INTERVAL_MS);
}
function stopMetering() {
  if (state.meterTimer) clearInterval(state.meterTimer);
  state.meterTimer = null;
}
function meterTick() {
  if (!state.stream || !dom.video.videoWidth) return;
  dom.meterCanvas.width = SAMPLE_W;
  dom.meterCanvas.height = SAMPLE_H;
  const ctx = dom.meterCanvas.getContext('2d');
  ctx.drawImage(dom.video, 0, 0, SAMPLE_W, SAMPLE_H);
  try {
    state.liveLum = computeLuminance(ctx, SAMPLE_W, SAMPLE_H);
  } catch (e) {
    state.liveLum = null;
  }
  updateLightingBadge();
}

// ---------------------------------------------------------------------
// Tilt tracking
// ---------------------------------------------------------------------
function initTiltUI() {
  if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
    // iOS 13+: must be requested from a user gesture.
    state.tilt.permissionNeeded = true;
    dom.enableTiltBtn.hidden = false;
  } else if ('DeviceOrientationEvent' in window) {
    attachTiltListener();
    // Desktops/laptops often expose the event constructor with no real
    // sensor behind it — if nothing fires shortly, treat tilt as unavailable.
    state.tiltProbeTimer = setTimeout(() => {
      if (state.tilt.available === null) {
        state.tilt.available = false;
        updateTiltBadge();
      }
    }, 1500);
  } else {
    state.tilt.available = false;
    updateTiltBadge();
  }
}

async function requestTiltPermission() {
  try {
    const res = await DeviceOrientationEvent.requestPermission();
    if (res === 'granted') {
      attachTiltListener();
      dom.enableTiltBtn.hidden = true;
    } else {
      state.tilt.available = false;
      dom.enableTiltBtn.hidden = true;
      updateTiltBadge();
    }
  } catch (e) {
    state.tilt.available = false;
    dom.enableTiltBtn.hidden = true;
    updateTiltBadge();
  }
}

function attachTiltListener() {
  window.addEventListener('deviceorientation', onDeviceOrientation, true);
}

function onDeviceOrientation(e) {
  if (e.beta === null && e.gamma === null) return;
  clearTimeout(state.tiltProbeTimer);
  state.tilt.available = true;
  state.tilt.live = { beta: e.beta, gamma: e.gamma };
  updateTiltBadge();
}

// ---------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------
function setBadge(el, status, label, numericText) {
  el.classList.remove('status-green', 'status-yellow', 'status-red', 'status-na');
  el.classList.add('status-' + status, 'is-visible');
  el.querySelector('.label').textContent = label;
  el.querySelector('.num').textContent = numericText;
  applyReadoutStyleToBadge(el);
}

function applyReadoutStyleToBadge(el) {
  el.classList.toggle('hide-indicator', state.settings.readout === 'numeric');
  el.classList.toggle('hide-numeric', state.settings.readout === 'indicator');
}

function updateTiltBadge() {
  if (state.tilt.available === false) {
    setBadge(dom.tiltBadge, 'na', 'Tilt', 'Not available on this device');
    return;
  }
  if (state.tilt.available !== true) return; // still probing, stay hidden
  if (!state.before.tilt) {
    setBadge(dom.tiltBadge, 'na', 'Tilt', 'No reference on this photo');
    return;
  }
  const live = state.tilt.live;
  if (!live) return;
  const db = live.beta - state.before.tilt.beta;
  const dg = live.gamma - state.before.tilt.gamma;
  const delta = Math.sqrt(db * db + dg * dg);
  let status = 'green';
  if (delta > TILT_YELLOW_DEG) status = 'red';
  else if (delta > TILT_GREEN_DEG) status = 'yellow';
  setBadge(dom.tiltBadge, status, 'Tilt', 'Δ' + delta.toFixed(1) + '°');
}

function updateLightingBadge() {
  if (!state.before.hasFile) {
    setBadge(dom.lightingBadge, 'na', 'Lighting', 'Load a before photo to compare');
    return;
  }
  const before = state.before.lum;
  const live = state.liveLum;
  if (before == null || live == null) return;
  const pctDiff = ((live - before) / before) * 100;
  const abs = Math.abs(pctDiff);
  let status = 'green';
  if (abs > LUM_YELLOW_PCT) status = 'red';
  else if (abs > LUM_GREEN_PCT) status = 'yellow';
  const sign = pctDiff >= 0 ? '+' : '';
  setBadge(dom.lightingBadge, status, 'Lighting', sign + pctDiff.toFixed(0) + '% vs before');
}

// ---------------------------------------------------------------------
// Landmark pin
// ---------------------------------------------------------------------
function applyPinPosition() {
  dom.pin.style.left = state.pin.xPct + '%';
  dom.pin.style.top = state.pin.yPct + '%';
}

function initPinDrag() {
  let dragging = false;
  dom.pin.addEventListener('pointerdown', (e) => {
    dragging = true;
    dom.pin.classList.add('is-dragging');
    try { dom.pin.setPointerCapture(e.pointerId); } catch (err) { /* best-effort; drag tracking below still works without capture */ }
    e.preventDefault();
  });
  dom.pin.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = dom.stage.getBoundingClientRect();
    let xPct = ((e.clientX - rect.left) / rect.width) * 100;
    let yPct = ((e.clientY - rect.top) / rect.height) * 100;
    xPct = Math.min(96, Math.max(4, xPct));
    yPct = Math.min(96, Math.max(4, yPct));
    state.pin = { xPct, yPct };
    applyPinPosition();
  });
  const end = () => { dragging = false; dom.pin.classList.remove('is-dragging'); };
  dom.pin.addEventListener('pointerup', end);
  dom.pin.addEventListener('pointercancel', end);
  dom.pin.addEventListener('dblclick', () => {
    state.pin = { xPct: 50, yPct: 50 };
    applyPinPosition();
  });
}

// ---------------------------------------------------------------------
// Ghost overlay drag-to-reposition / pinch-to-scale
//
// The live camera stream and an arbitrary uploaded before-photo can have
// different native aspect ratios, so object-fit:cover crops each to fill
// the stage differently — even a perfectly re-framed shot can look
// offset. This lets the user drag the ghost into place and pinch it to
// match scale, compensating for whatever the automatic fit couldn't.
// ---------------------------------------------------------------------
function initGhostGestures() {
  const activePointers = new Map(); // pointerId -> {x, y}
  let panStart = null;   // {x, y, offX, offY}
  let pinchStart = null; // {dist, scale}

  function isPinEvent(e) {
    return e.target === dom.pin || dom.pin.contains(e.target);
  }

  dom.stage.addEventListener('pointerdown', (e) => {
    if (isPinEvent(e) || !state.before.hasFile) return;
    try { dom.stage.setPointerCapture(e.pointerId); } catch (err) { /* best-effort; tracking below still works without capture */ }
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 1) {
      panStart = { x: e.clientX, y: e.clientY, offX: state.ghost.offsetXPct, offY: state.ghost.offsetYPct };
      pinchStart = null;
    } else if (activePointers.size === 2) {
      const pts = Array.from(activePointers.values());
      pinchStart = { dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), scale: state.ghost.scale };
      panStart = null;
    }
  });

  dom.stage.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 2 && pinchStart) {
      const pts = Array.from(activePointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchStart.dist > 0) {
        state.ghost.scale = clamp(pinchStart.scale * (dist / pinchStart.dist), 0.5, 3);
        applyGhostTransform();
      }
      return;
    }
    if (activePointers.size === 1 && panStart) {
      const rect = dom.stage.getBoundingClientRect();
      state.ghost.offsetXPct = clamp(panStart.offX + ((e.clientX - panStart.x) / rect.width) * 100, -50, 50);
      state.ghost.offsetYPct = clamp(panStart.offY + ((e.clientY - panStart.y) / rect.height) * 100, -50, 50);
      applyGhostTransform();
    }
  });

  const endPointer = (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchStart = null;
    if (activePointers.size === 0) panStart = null;
  };
  dom.stage.addEventListener('pointerup', endPointer);
  dom.stage.addEventListener('pointercancel', endPointer);
}

// ---------------------------------------------------------------------
// Capture + composite
// ---------------------------------------------------------------------
function round1(n) { return Math.round(n * 10) / 10; }

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function buildComposite(beforeUrl, afterUrl) {
  if (!beforeUrl) return null;
  const [beforeImg, afterImg] = await Promise.all([loadImg(beforeUrl), loadImg(afterUrl)]);
  const targetH = COMPOSITE_TARGET_H;
  const bw = Math.round(beforeImg.width * (targetH / beforeImg.height));
  const aw = Math.round(afterImg.width * (targetH / afterImg.height));
  const gap = 6;
  const labelH = 44;
  const canvas = document.createElement('canvas');
  canvas.width = bw + aw + gap;
  canvas.height = targetH + labelH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101C2B';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(beforeImg, 0, labelH, bw, targetH);
  ctx.drawImage(afterImg, bw + gap, labelH, aw, targetH);
  ctx.fillStyle = '#F7F8FA';
  ctx.font = '600 26px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('BEFORE', bw / 2, 31);
  ctx.fillText('AFTER', bw + gap + aw / 2, 31);
  return canvas.toDataURL('image/jpeg', 0.9);
}

async function capturePhoto() {
  const vw = dom.video.videoWidth, vh = dom.video.videoHeight;
  if (!vw || !vh) { showToast('Camera not ready yet'); return; }

  dom.captureCanvas.width = vw;
  dom.captureCanvas.height = vh;
  const ctx = dom.captureCanvas.getContext('2d');
  if (state.isFrontFacing) {
    // Un-mirror so the saved file matches real-world orientation even
    // though the live preview is mirrored for natural framing.
    ctx.translate(vw, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(dom.video, 0, 0, vw, vh);
  let afterDataUrl = dom.captureCanvas.toDataURL('image/jpeg', 0.92);

  if (state.tilt.available && state.tilt.live && typeof piexif !== 'undefined') {
    try {
      const meta = { beta: round1(state.tilt.live.beta), gamma: round1(state.tilt.live.gamma), ts: Date.now() };
      const exifObj = { '0th': {}, Exif: {}, GPS: {} };
      exifObj['0th'][piexif.ImageIFD.ImageDescription] = META_TAG + JSON.stringify(meta);
      const exifBytes = piexif.dump(exifObj);
      afterDataUrl = piexif.insert(exifBytes, afterDataUrl);
    } catch (e) {
      console.warn('EXIF embed failed', e); // capture still proceeds without the reference
    }
  }

  let compositeDataUrl = null;
  try {
    compositeDataUrl = await buildComposite(state.before.dataUrl, afterDataUrl);
  } catch (e) {
    console.warn('composite build failed', e);
  }

  state.lastCaptured = { afterDataUrl, compositeDataUrl };
  showReviewSheet();
}

function showReviewSheet() {
  const { afterDataUrl, compositeDataUrl } = state.lastCaptured;
  dom.reviewAfterImg.src = afterDataUrl;
  if (compositeDataUrl) {
    dom.reviewCompositeWrap.hidden = false;
    dom.reviewCompositeImg.src = compositeDataUrl;
  } else {
    dom.reviewCompositeWrap.hidden = true;
  }
  openSheet(dom.reviewSheet);
}

// ---------------------------------------------------------------------
// Saving (camera roll via Web Share on iOS, plain download everywhere
// else). iOS's share sheet has a built-in "Save Image" action baked into
// the OS, so Web Share genuinely helps there. Android's share sheet has no
// equivalent — it just lists whatever apps are installed (Messenger, a
// vault app, etc.), none of which reliably saves to the actual gallery —
// and desktop share dialogs are app-to-app with no save option at all. So
// Android and desktop both get a direct download instead, which lands
// predictably in the Downloads folder without asking the user to guess
// which app in a share list will do the right thing.
// ---------------------------------------------------------------------
function isIOSDevice() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS 13+ Safari reports itself as desktop Safari by default.
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
  return false;
}

function filename(kind) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  return 'cygnus-' + kind + '-' + stamp + '.jpg';
}

function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/data:(.*?);base64/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function saveImageDataUrl(dataUrl, name) {
  const blob = dataUrlToBlob(dataUrl);
  const file = new File([blob], name, { type: 'image/jpeg' });

  if (isIOSDevice() && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      showToast('Choose "Save Image" to add it to your photos');
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user cancelled the share sheet
      // otherwise fall through to a plain download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  showToast('Downloaded ' + name + ' — check your browser\'s downloads');
}

// ---------------------------------------------------------------------
// Sheets (settings / review)
// ---------------------------------------------------------------------
function openSheet(sheetEl) {
  dom.sheetScrim.classList.add('is-open');
  sheetEl.classList.add('is-open');
}
function closeSheets() {
  dom.sheetScrim.classList.remove('is-open');
  document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('is-open'));
}

// ---------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------
let toastTimer = null;
function showToast(msg) {
  dom.toast.textContent = msg;
  dom.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('is-visible'), 2800);
}

// ---------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------
function wireControls() {
  dom.startCameraBtn.addEventListener('click', () => startCamera());
  dom.enableTiltBtn.addEventListener('click', requestTiltPermission);

  dom.settingsBtn.addEventListener('click', () => openSheet(dom.settingsSheet));
  dom.settingsClose.addEventListener('click', closeSheets);
  dom.sheetScrim.addEventListener('click', closeSheets);

  dom.opacitySlider.addEventListener('input', () => {
    state.settings.opacity = Number(dom.opacitySlider.value);
    dom.opacityPct.textContent = state.settings.opacity + '%';
    applyGhostOpacity();
    saveSettings();
  });

  dom.loadBeforeBtn.addEventListener('click', () => dom.beforeFileInput.click());
  dom.beforeFileInput.addEventListener('change', () => {
    const file = dom.beforeFileInput.files && dom.beforeFileInput.files[0];
    pickBeforePhoto(file);
    dom.beforeFileInput.value = '';
  });

  dom.flipCamBtn.addEventListener('click', flipCamera);
  dom.shutterBtn.addEventListener('click', capturePhoto);

  dom.readoutButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.readout = btn.dataset.value;
      dom.readoutButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
      applyReadoutStyleToBadge(dom.tiltBadge);
      applyReadoutStyleToBadge(dom.lightingBadge);
      saveSettings();
    });
  });

  dom.cameraSelect.addEventListener('change', () => switchToDevice(dom.cameraSelect.value));

  dom.flipGhostBtn.addEventListener('click', () => {
    state.ghost.flipped = !state.ghost.flipped;
    applyGhostTransform();
    showToast(state.ghost.flipped ? 'Ghost flipped' : 'Ghost un-flipped');
  });
  dom.resetGhostBtn.addEventListener('click', () => {
    resetGhostTransform();
    showToast('Ghost position & zoom reset');
  });

  dom.reviewClose.addEventListener('click', closeSheets);
  dom.retakeBtn.addEventListener('click', closeSheets);
  dom.saveAfterBtn.addEventListener('click', () => saveImageDataUrl(state.lastCaptured.afterDataUrl, filename('photo')));
  dom.saveCompositeBtn.addEventListener('click', () => {
    if (state.lastCaptured.compositeDataUrl) saveImageDataUrl(state.lastCaptured.compositeDataUrl, filename('comparison'));
  });
  dom.saveBothBtn.addEventListener('click', async () => {
    await saveImageDataUrl(state.lastCaptured.afterDataUrl, filename('photo'));
    if (state.lastCaptured.compositeDataUrl) await saveImageDataUrl(state.lastCaptured.compositeDataUrl, filename('comparison'));
  });
}

function applyPlatformLabels() {
  const ios = isIOSDevice();
  dom.saveBothBtn.textContent = ios ? 'Save Both to Photos' : 'Download Both';
  dom.saveAfterBtn.textContent = ios ? 'Save Photo Only' : 'Download Photo Only';
  dom.saveCompositeBtn.textContent = ios ? 'Save Comparison Only' : 'Download Comparison Only';
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
    });
  }
}

function init() {
  cacheDom();
  loadSettings();
  applySettingsToUI();
  applyPinPosition();
  applyGhostOpacity();
  applyGhostTransform();
  initPinDrag();
  initGhostGestures();
  initTiltUI();
  updateLightingBadge();
  applyPlatformLabels();
  wireControls();
  registerServiceWorker();
}

document.addEventListener('DOMContentLoaded', init);
