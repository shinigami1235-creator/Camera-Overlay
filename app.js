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

// Capture shapes offered in Settings. null ("native") means no crop at
// all — the frame just fills the stage at whatever shape the screen is.
const ASPECT_RATIOS = {
  native: null,
  '1:1': 1,
  '3:4': 3 / 4,
  '4:3': 4 / 3,
  '9:16': 9 / 16,
  '16:9': 16 / 9,
};

// Ghost outline generation (edge-detected line-art version of the
// before-photo, for anyone who finds the translucent blend hard to
// focus on). Downsampled for speed — object-fit:cover scales the result
// back up, and slightly soft lines are fine, even helpful, for legibility.
const GHOST_OUTLINE_MAX_DIM = 480;
const GHOST_OUTLINE_THRESHOLD = 40;         // Sobel gradient magnitude cutoff (fixed — line density, not user-facing)
const DEFAULT_OUTLINE_COLOR = '#c89a3c';    // brand gold, matches the crosshair pin
const DEFAULT_OUTLINE_INTENSITY = 85;       // % opacity of the outline layer

// Focus mode: the user draws a loop around the subject on the live view,
// and everything outside that loop is blacked out.
const FOCUS_MASK_MAX_DIM = 640;  // px, longest side of the stored mask image
const FOCUS_MIN_LOOP_PX = 12;    // fewer touch points than this isn't a loop
const FOCUS_MIN_LOOP_SHARE = 0.04; // loop must cover at least this share of the frame's width and height
// Edge snapping: the drawn loop is pulled onto the nearest strong edge.
const SNAP_POINTS = 240;         // points along the loop
const SNAP_BANDS = [0.12, 0.05]; // how far a point may move, as a share of the photo's shorter side: a wide first pass, then a close one
const SNAP_STICK = 0.35;         // pull back toward the line you drew (higher = trusts your drawing more)
const SNAP_BEND = 0.1;          // cost of the contour bending between neighbouring points (higher = smoother)
const SNAP_EDGE_FULL = 160;      // Sobel strength treated as a full-strength edge
const BLACKOUT_OVERSIZE = 5;     // #blackout is this many times the frame (see styles.css)

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
const state = {
  stream: null,
  imageCapture: null,  // ImageCapture bound to the current track, where supported (see capturePhoto())
  pendingNativeTilt: null, // tilt reading captured at the moment "Take with Camera App" was tapped
  videoDevices: [],
  currentDeviceId: null,
  facingMode: 'environment',
  isFrontFacing: false,
  before: { dataUrl: null, img: null, lum: null, tilt: null, hasFile: false },
  pin: { xPct: 50, yPct: 50 },
  // Manual correction for the ghost overlay, since the live camera stream
  // and an arbitrary uploaded before-photo can have different native
  // aspect ratios — object-fit:cover crops each to fill the same box
  // differently, so even a perfectly re-framed shot can look offset.
  // Drag/pinch on the stage lets the user compensate.
  ghost: { offsetXPct: 0, offsetYPct: 0, scale: 1, flipped: false },
  tilt: { available: null, live: null, permissionNeeded: false },
  liveLum: null,
  settings: {
    readout: 'both', opacity: 45, captureAspect: '3:4', ghostStyle: 'both',
    outlineIntensity: DEFAULT_OUTLINE_INTENSITY, outlineColor: DEFAULT_OUTLINE_COLOR,
    matchZoomToGhost: false,
    preferHQStill: false,
  },
  focus: { on: false, drawing: false },
  focusHoleUrl: null, // PNG of the drawn area for the current before-photo (opaque inside, transparent outside), or null before one is drawn
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
    frame: id('frame'),
    previewCanvas: id('preview-canvas'),
    video: id('video'),
    ghostImg: id('ghost-img'),
    ghostOutlineImg: id('ghost-outline-img'),
    blackout: id('blackout'),
    focusBtn: id('focus-btn'),
    focusRedrawBtn: id('focus-redraw-btn'),
    lassoLayer: id('lasso-layer'),
    pin: id('pin'),
    meterCanvas: id('meter-canvas'),
    captureCanvas: id('capture-canvas'),

    opacitySlider: id('opacity-slider'),
    opacityPct: id('opacity-pct'),
    loadBeforeBtn: id('load-before-btn'),
    beforeFileInput: id('before-file-input'),
    shutterBtn: id('shutter-btn'),
    flipCamBtn: id('flip-cam-btn'),
    nativeCaptureBtn: id('native-capture-btn'),
    nativeCaptureInput: id('native-capture-input'),

    sheetScrim: id('sheet-scrim'),

    settingsSheet: id('settings-sheet'),
    settingsClose: id('settings-close'),
    readoutButtons: Array.from(document.querySelectorAll('#readout-picker button')),
    ghostStyleButtons: Array.from(document.querySelectorAll('#ghost-style-picker button')),
    aspectButtons: Array.from(document.querySelectorAll('#settings-sheet .aspect-picker button')),
    outlineIntensitySlider: id('outline-intensity-slider'),
    outlineIntensityPct: id('outline-intensity-pct'),
    outlineColorInput: id('outline-color-input'),
    outlineSwatches: Array.from(document.querySelectorAll('#outline-color-swatches .swatch')),
    matchZoomToggle: id('match-zoom-toggle'),
    zoomBadge: id('zoom-badge'),
    hqStillToggle: id('hq-still-toggle'),
    cameraSelect: id('camera-select'),
    flipGhostBtn: id('flip-ghost-btn'),
    resetGhostBtn: id('reset-ghost-btn'),

    reviewSheet: id('review-sheet'),
    reviewClose: id('review-close'),
    reviewAfterImg: id('review-after-img'),
    reviewCompositeWrap: id('review-composite-wrap'),
    reviewCompositeImg: id('review-composite-img'),
    saveGridBtn: id('save-grid-btn'),
    saveSingleBtn: id('save-single-btn'),
    retakeBtn: id('retake-btn'),

    toast: id('toast'),

    debugPanel: id('debug-panel'),
    reviewDebug: id('review-debug'),
  };
}

// ---------------------------------------------------------------------
// Diagnostic readout (?debug=1) — shows live video/frame/crop numbers so
// a real-device mismatch can be pinned down from a screenshot instead of
// guessed at. Off by default; adds no cost when not enabled.
// ---------------------------------------------------------------------
const DEBUG = /[?&]debug=1\b/.test(location.search);
let debugTimer = null;

function currentCaptureRatio() {
  return ASPECT_RATIOS[state.settings.captureAspect] || (dom.frame.clientWidth / dom.frame.clientHeight);
}

function debugSnapshot() {
  const vw = dom.video.videoWidth, vh = dom.video.videoHeight;
  const frameRect = dom.frame.getBoundingClientRect();
  const ratio = currentCaptureRatio();
  const crop = vw && vh ? computeCropRect(vw, vh, ratio) : null;
  const lines = [
    'aspect setting: ' + state.settings.captureAspect + '  ratio: ' + ratio.toFixed(4),
    'video native (raw source): ' + vw + 'x' + vh,
    'frame box (css px): ' + Math.round(frameRect.width) + 'x' + Math.round(frameRect.height),
    'preview canvas buffer (what is on screen): ' + dom.previewCanvas.width + 'x' + dom.previewCanvas.height,
    'isFrontFacing: ' + state.isFrontFacing,
    'ImageCapture.takePhoto() available: ' + !!state.imageCapture + '  prefer-HQ-still setting: ' + state.settings.preferHQStill,
    'ghost scale: ' + state.ghost.scale.toFixed(3) + '  match-zoom-to-ghost: ' + state.settings.matchZoomToGhost + '  effective zoom: ' + computeEffectiveZoom().toFixed(3),
  ];
  if (crop) {
    lines.push('crop of raw source used for preview AND capture: ' + [crop.sx, crop.sy, crop.sw, crop.sh].map((n) => Math.round(n)).join(', '));
  }
  lines.push('=> capture draws from the native video at full resolution using this same crop rect (framing matches; resolution is no longer capped by screen size)');
  return lines.join('\n');
}

function startDebugPanel() {
  if (!DEBUG || !dom.debugPanel) return;
  dom.debugPanel.hidden = false;
  clearInterval(debugTimer);
  debugTimer = setInterval(() => { dom.debugPanel.textContent = debugSnapshot(); }, 400);
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
  dom.aspectButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.aspect === state.settings.captureAspect));
  dom.ghostStyleButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.value === state.settings.ghostStyle));
  dom.outlineIntensitySlider.value = state.settings.outlineIntensity;
  dom.outlineIntensityPct.textContent = state.settings.outlineIntensity + '%';
  dom.outlineColorInput.value = state.settings.outlineColor;
  syncOutlineSwatches();
  dom.matchZoomToggle.setAttribute('aria-checked', String(state.settings.matchZoomToGhost));
  updateZoomBadge();
  dom.hqStillToggle.setAttribute('aria-checked', String(state.settings.preferHQStill));
}

function syncOutlineSwatches() {
  const c = (state.settings.outlineColor || '').toLowerCase();
  dom.outlineSwatches.forEach((s) => s.classList.toggle('is-active', s.dataset.color.toLowerCase() === c));
}

// ---------------------------------------------------------------------
// Frame sizing (capture shape / letterboxing)
// ---------------------------------------------------------------------
// Computed in JS rather than pure CSS aspect-ratio so the math is exactly
// the same "fit inside, preserve ratio" logic used for the capture crop
// below — the two need to agree pixel-for-pixel with what's on screen.
function applyFrameSize() {
  sizeFrame();
  updateBlackout(); // its mask size follows the frame size
}

function sizeFrame() {
  const ratio = ASPECT_RATIOS[state.settings.captureAspect];
  if (!ratio) {
    dom.frame.style.width = '100%';
    dom.frame.style.height = '100%';
    return;
  }
  const stageW = dom.stage.clientWidth, stageH = dom.stage.clientHeight;
  if (!stageW || !stageH) return;
  const stageRatio = stageW / stageH;
  let w, h;
  if (stageRatio > ratio) {
    h = stageH;
    w = h * ratio;
  } else {
    w = stageW;
    h = w / ratio;
  }
  dom.frame.style.width = Math.round(w) + 'px';
  dom.frame.style.height = Math.round(h) + 'px';
}

// Center-crop math shared by applyFrameSize() above (for on-screen
// letterboxing) and capturePhoto() below (for the actual saved pixels) —
// the two must agree exactly, or what the user framed on screen won't be
// what ends up in the file. Replicates object-fit:cover's crop logic
// against the raw source dimensions.
function computeCropRect(srcW, srcH, ratio) {
  if (!ratio) return { sx: 0, sy: 0, sw: srcW, sh: srcH };
  const srcRatio = srcW / srcH;
  let sw, sh;
  if (srcRatio > ratio) {
    sh = srcH;
    sw = sh * ratio;
  } else {
    sw = srcW;
    sh = sw / ratio;
  }
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
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
  state.imageCapture = null;
  stopPreviewLoop();
}

// ---------------------------------------------------------------------
// Live preview rendering
//
// The visible preview is a <canvas> that app.js repaints every animation
// frame with the SAME crop + mirror math capturePhoto() uses, instead of
// letting the browser render the raw <video> element with CSS
// object-fit:cover + a CSS mirror transform. On some GPU/driver
// combinations a mirrored, transformed <video> element can visually
// paint a different (more tightly cropped) region than the frame data it
// actually holds — the canvas.drawImage() capture path reads the correct
// underlying frame, but the human eye was never looking at that; it was
// looking at whatever the compositor painted, which could quietly drift
// out of sync. Painting the preview from the same drawImage() call that
// capture uses closes that gap by construction: there is no separate
// "what's displayed" code path left to disagree with "what's saved".
// ---------------------------------------------------------------------
let previewRAF = null;

function renderPreviewFrame() {
  previewRAF = requestAnimationFrame(renderPreviewFrame);
  const vw = dom.video.videoWidth, vh = dom.video.videoHeight;
  if (!vw || !vh) return;

  const cssW = dom.previewCanvas.clientWidth, cssH = dom.previewCanvas.clientHeight;
  if (!cssW || !cssH) return;
  const dpr = window.devicePixelRatio || 1;
  const bufW = Math.max(1, Math.round(cssW * dpr));
  const bufH = Math.max(1, Math.round(cssH * dpr));
  if (dom.previewCanvas.width !== bufW || dom.previewCanvas.height !== bufH) {
    dom.previewCanvas.width = bufW;
    dom.previewCanvas.height = bufH;
  }

  const ratio = currentCaptureRatio();
  const crop = computeCropRect(vw, vh, ratio);
  const pctx = dom.previewCanvas.getContext('2d');
  pctx.save();
  if (state.isFrontFacing) {
    pctx.translate(bufW, 0);
    pctx.scale(-1, 1);
  }
  pctx.drawImage(dom.video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, bufW, bufH);
  pctx.restore();
}

function startPreviewLoop() {
  stopPreviewLoop();
  previewRAF = requestAnimationFrame(renderPreviewFrame);
}
function stopPreviewLoop() {
  if (previewRAF) cancelAnimationFrame(previewRAF);
  previewRAF = null;
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

// Applies the user's manual drag/pinch/flip correction to the ghost
// image. Earlier this also auto-mirrored the ghost whenever the front
// camera was active, on the assumption that a before-photo captured by
// this app was always saved "real world" (un-mirrored) and so needed a
// matching mirror to line up with the mirrored live preview. That's no
// longer true: capture now saves exactly what was on screen — mirrored
// too, for a front camera — so a before-photo from this app already
// shares the live preview's orientation and needs no automatic flip.
// Flipping stays available as a manual control for the case that still
// needs it: a before-photo from somewhere else (an older capture, an
// imported gallery photo) that used the opposite convention.
function applyGhostTransform() {
  const flip = state.ghost.flipped ? -1 : 1;
  const scaleX = flip * state.ghost.scale;
  const t = 'translate(' + state.ghost.offsetXPct + '%, ' + state.ghost.offsetYPct + '%) scale(' + scaleX + ', ' + state.ghost.scale + ')';
  // Both ghost layers (blend + outline) always move together.
  dom.ghostImg.style.transform = t;
  dom.ghostOutlineImg.style.transform = t;
  // The blackout is BLACKOUT_OVERSIZE times the frame, and translate % is
  // relative to the element's own size, so the offset is divided to match.
  dom.blackout.style.transform = 'translate(' + (state.ghost.offsetXPct / BLACKOUT_OVERSIZE) + '%, '
    + (state.ghost.offsetYPct / BLACKOUT_OVERSIZE) + '%) scale(' + scaleX + ', ' + state.ghost.scale + ')';
  updateZoomBadge();
}

function resetGhostTransform() {
  state.ghost.offsetXPct = 0;
  state.ghost.offsetYPct = 0;
  state.ghost.scale = 1;
  applyGhostTransform();
}

// The ghost's manual pinch-to-scale (state.ghost.scale) is what a person
// naturally does to visually line up a before-photo that has a different
// effective field of view than this live camera (most commonly: the
// before-photo came from the phone's own camera app, which often frames a
// bit tighter or wider than a browser's raw camera stream at the same
// distance). Shrinking the ghost to align it means the before-photo was
// MORE zoomed in than the live view, so matching the actual saved output
// to it means cropping the live capture tighter by the inverse factor.
// There's no way to do the opposite (digitally "zoom out" past what the
// sensor already captured), so a ghost scaled UP has no effect here.
function computeEffectiveZoom() {
  if (!state.settings.matchZoomToGhost || !state.before.hasFile) return 1;
  if (!state.ghost.scale || state.ghost.scale <= 0) return 1;
  return Math.max(1, 1 / state.ghost.scale);
}

function updateZoomBadge() {
  const zoom = computeEffectiveZoom();
  const active = zoom > 1.001;
  dom.zoomBadge.classList.toggle('is-visible', active);
  dom.zoomBadge.querySelector('.num').textContent = active ? zoom.toFixed(2) + '×' : '—';
}

async function startCamera(constraintsOverride) {
  stopCamera();
  const constraints = constraintsOverride || {
    // Bias toward a 3:4-ish shape rather than 16:9 widescreen — closer to
    // what most phone camera apps shoot stills in by default, which
    // narrows (but can't fully close) the aspect-ratio gap against an
    // arbitrary uploaded before-photo. width/height are "ideal" hints too
    // (not exact:), so they combine with aspectRatio rather than fighting
    // it — the browser picks whichever supported camera mode best matches
    // all three together. Leaving width/height unset was the actual bug:
    // with no resolution hint at all, browsers commonly fall back to a low
    // default capture mode (sometimes well under 1MP) even on phones whose
    // camera can do far better, which is what made photos look grainy.
    video: {
      facingMode: { ideal: state.facingMode },
      aspectRatio: { ideal: 3 / 4 },
      width: { ideal: 3000 },
      height: { ideal: 4000 },
    },
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
    applyGhostTransform(); // re-apply in case a ghost was already loaded before switching cameras
    // Feature-detected: Chrome/Samsung Internet (Android + desktop) support
    // this; Safari and Firefox don't. capturePhoto() falls back to a video
    // frame automatically whenever this is null or takePhoto() fails.
    try {
      state.imageCapture = ('ImageCapture' in window) ? new ImageCapture(track) : null;
    } catch (e) {
      state.imageCapture = null;
    }
    state.currentDeviceId = settings.deviceId || state.currentDeviceId;
    await refreshDeviceList();
    hideStartOverlay();
    startMetering();
    startDebugPanel();
    startPreviewLoop();
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
  startCamera({
    video: {
      deviceId: { exact: deviceId },
      aspectRatio: { ideal: 3 / 4 },
      width: { ideal: 3000 },
      height: { ideal: 4000 },
    },
    audio: false,
  });
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
    // Set BEFORE any apply*() call below — applyGhostOpacity() reads
    // state.before.hasFile to decide whether the ghost should be visible
    // at all, so setting it after was making the overlay compute itself
    // as invisible (opacity 0) on a photo's first-ever load. It would
    // then only appear on a SECOND upload, because hasFile was already
    // left `true` from the first (silently-invisible) one.
    state.before.dataUrl = dataUrl;
    state.before.hasFile = true;
    state.before.img = img; // kept so the outline can be recolored later without re-decoding the photo

    dom.ghostImg.src = dataUrl;
    dom.ghostImg.classList.add('is-active');
    if (regenerateGhostOutline()) dom.ghostOutlineImg.classList.add('is-active');
    resetGhostTransform(); // a new photo starts centered/unscaled — old nudges shouldn't carry over
    state.ghost.flipped = false;
    applyGhostTransform();
    applyGhostOpacity();
    stopFocusDrawing();
    state.focus.on = false;
    state.focusHoleUrl = null; // the old photo's drawn area doesn't apply to a new photo
    updateBlackout();

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

// Traces just the edges of the before-photo into a transparent-background
// line drawing (classic Sobel gradient magnitude, thresholded), instead
// of blending the whole photo's color/detail translucently over the live
// view. Some people find a full translucent double-exposure hard to
// focus on or genuinely uncomfortable to look at; a clean outline gives
// the same alignment guidance with far less visual competition against
// the live camera feed.
// Converts a "#rrggbb" input into [r, g, b], falling back to the default
// gold if the string is somehow malformed (e.g. an empty color input).
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [200, 154, 60];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Sobel gradient magnitude of the downsampled photo. Shared by the visible
// outline and by Focus mode, so both always agree on where the lines are.
// The 1px border of the result stays 0.
function computeEdgeMagnitude(img) {
  const scale = Math.min(1, GHOST_OUTLINE_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  const sctx = src.getContext('2d');
  sctx.drawImage(img, 0, 0, w, h);
  const srcData = sctx.getImageData(0, 0, w, h).data;

  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < srcData.length; i += 4, p++) {
    gray[p] = 0.299 * srcData[i] + 0.587 * srcData[i + 1] + 0.114 * srcData[i + 2];
  }

  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -gray[i - w - 1] + gray[i - w + 1]
        - 2 * gray[i - 1] + 2 * gray[i + 1]
        - gray[i + w - 1] + gray[i + w + 1];
      const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1]
        + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      mag[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return { w, h, mag };
}

function computeGhostOutline(img, colorHex) {
  const { w, h, mag } = computeEdgeMagnitude(img);

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d');
  const outImg = octx.createImageData(w, h);
  const [r, g, b] = hexToRgb(colorHex);

  for (let i = 0; i < mag.length; i++) {
    if (mag[i] > GHOST_OUTLINE_THRESHOLD) {
      const o = i * 4;
      outImg.data[o] = r;
      outImg.data[o + 1] = g;
      outImg.data[o + 2] = b;
      outImg.data[o + 3] = Math.min(255, mag[i]);
    }
  }
  octx.putImageData(outImg, 0, 0);
  return out.toDataURL('image/png'); // needs an alpha channel, so PNG not JPEG
}

// Maps a screen point to a position on the before-photo, as fractions of its
// width and height (0..1). It undoes the ghost's drag, pinch and flip and the
// object-fit: cover crop, so a loop drawn on screen stays on the same part of
// the photo when the ghost is moved afterwards.
function screenPointToPhoto(clientX, clientY) {
  const rect = dom.frame.getBoundingClientRect();
  const fw = rect.width, fh = rect.height;
  const g = state.ghost;
  const sx = (g.flipped ? -1 : 1) * g.scale, sy = g.scale;
  const qx = (clientX - rect.left - fw / 2 - (g.offsetXPct / 100) * fw) / sx;
  const qy = (clientY - rect.top - fh / 2 - (g.offsetYPct / 100) * fh) / sy;
  const iw = state.before.img.naturalWidth, ih = state.before.img.naturalHeight;
  const s = Math.max(fw / iw, fh / ih);
  return { u: qx / (iw * s) + 0.5, v: qy / (ih * s) + 0.5 };
}

// Magnetic-lasso snapping. The drawn loop is resampled into SNAP_POINTS
// points. Each point may slide along the line perpendicular to the loop,
// up to a set share of the photo's shorter side either way (SNAP_BANDS). A dynamic-programming
// pass (Viterbi) picks one slide per point so that the contour sits on strong
// edges, stays close to what was drawn, and doesn't zigzag between neighbours.
// The loop goes around twice and the second lap is kept, so the start and end
// of the loop agree. Returns a loop of {u, v}, or the original loop if the
// photo has nothing usable. It runs twice, wide and then close, so a loose
// loop first lands near the subject and then settles onto its edge.
function snapLoopToEdges(loop, band) {
  const { w, h, mag } = computeEdgeMagnitude(state.before.img);
  const edgeAt = (x, y) => {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const v = mag[y0 * w + x0] * (1 - fx) * (1 - fy) + mag[y0 * w + x1] * fx * (1 - fy)
      + mag[y1 * w + x0] * (1 - fx) * fy + mag[y1 * w + x1] * fx * fy;
    return Math.min(1, v / SNAP_EDGE_FULL);
  };

  // Resample the loop to evenly spaced points, in edge-map pixels.
  const pts = loop.map((p) => ({ x: p.u * w, y: p.v * h }));
  const segLen = [];
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    segLen.push(d);
    total += d;
  }
  if (total < 1) return loop;
  const N = SNAP_POINTS;
  const even = [];
  let seg = 0, into = 0;
  for (let i = 0; i < N; i++) {
    const target = (i / N) * total;
    while (into + segLen[seg] < target && seg < pts.length - 1) { into += segLen[seg]; seg++; }
    const a = pts[seg], b = pts[(seg + 1) % pts.length];
    const t = segLen[seg] > 0 ? (target - into) / segLen[seg] : 0;
    even.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }

  // Normal at each point.
  const normals = even.map((p, i) => {
    const a = even[(i - 1 + N) % N], b = even[(i + 1) % N];
    const tx = b.x - a.x, ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    return { x: -ty / len, y: tx / len };
  });

  const K = Math.max(3, Math.round(band * Math.min(w, h)));
  const S = 2 * K + 1;
  const MAX_STEP = 3;
  const unary = new Float32Array(N * S);
  for (let i = 0; i < N; i++) {
    for (let s = 0; s < S; s++) {
      const off = s - K;
      const e = edgeAt(even[i].x + normals[i].x * off, even[i].y + normals[i].y * off);
      unary[i * S + s] = -e + SNAP_STICK * Math.abs(off) / K;
    }
  }

  const L = 2 * N;
  const back = new Int16Array(L * S);
  let prev = new Float32Array(S), cur = new Float32Array(S);
  for (let s = 0; s < S; s++) prev[s] = unary[s];
  for (let l = 1; l < L; l++) {
    const i = l % N;
    for (let s = 0; s < S; s++) {
      let best = Infinity, arg = s;
      for (let d = -MAX_STEP; d <= MAX_STEP; d++) {
        const p = s + d;
        if (p < 0 || p >= S) continue;
        const c = prev[p] + SNAP_BEND * Math.abs(d);
        if (c < best) { best = c; arg = p; }
      }
      cur[s] = best + unary[i * S + s];
      back[l * S + s] = arg;
    }
    const t = prev; prev = cur; cur = t;
  }
  let end = 0;
  for (let s = 1; s < S; s++) if (prev[s] < prev[end]) end = s;
  const slide = new Array(L);
  for (let l = L - 1, s = end; l >= 0; l--) {
    slide[l] = s - K;
    s = back[l * S + s];
  }

  // Keep the second lap, then smooth it a little.
  let off = slide.slice(N);
  for (let pass = 0; pass < 2; pass++) {
    off = off.map((v, i) => (off[(i - 1 + N) % N] + v + off[(i + 1) % N]) / 3);
  }
  return even.map((p, i) => ({
    u: (p.x + normals[i].x * off[i]) / w,
    v: (p.y + normals[i].y * off[i]) / h,
  }));
}

// Turns a loop (array of {u, v}) into the mask image updateBlackout() uses.
function buildFocusMask(loop) {
  const iw = state.before.img.naturalWidth, ih = state.before.img.naturalHeight;
  const k = Math.min(1, FOCUS_MASK_MAX_DIM / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.beginPath();
  loop.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.u * w, p.v * h); else ctx.lineTo(p.u * w, p.v * h);
  });
  ctx.closePath();
  ctx.fill();
  return c.toDataURL('image/png');
}

// Shows or hides the blackout and fits its mask to the photo as the ghost
// layers draw it (object-fit: cover inside the frame). Call after anything
// that changes the photo, the frame size or the Focus state. Dragging,
// pinching and flipping go through applyGhostTransform() instead.
function updateBlackout() {
  const active = !!(state.focus.on && state.before.hasFile && state.focusHoleUrl);
  dom.focusBtn.setAttribute('aria-pressed', String(active));
  dom.focusRedrawBtn.hidden = !state.focusHoleUrl;
  dom.blackout.style.display = active ? 'block' : 'none';
  if (!active) return;

  const fw = dom.frame.clientWidth, fh = dom.frame.clientHeight;
  const iw = state.before.img.naturalWidth, ih = state.before.img.naturalHeight;
  if (!fw || !fh || !iw || !ih) return;
  const s = Math.max(fw / iw, fh / ih);
  const size = Math.round(iw * s) + 'px ' + Math.round(ih * s) + 'px, 100% 100%';
  const image = 'url(' + state.focusHoleUrl + '), linear-gradient(#000, #000)';
  const st = dom.blackout.style;
  st.webkitMaskImage = image;      st.maskImage = image;
  st.webkitMaskSize = size;        st.maskSize = size;
  applyGhostTransform();
}

// Drawing the area. While it's on, #lasso-layer sits over the frame and
// takes the touches, so dragging doesn't move the ghost.
let lassoPoints = [];
let lassoPointerId = null;

function startFocusDrawing() {
  if (!state.before.hasFile) { showToast('Load a before photo first'); return; }
  state.focus.drawing = true;
  state.focus.on = false; // show the whole view while drawing
  updateBlackout();
  const layer = dom.lassoLayer;
  layer.width = dom.frame.clientWidth;
  layer.height = dom.frame.clientHeight;
  layer.getContext('2d').clearRect(0, 0, layer.width, layer.height);
  layer.classList.add('is-drawing');
  lassoPoints = [];
  showToast('Draw a loop around the subject');
}

function stopFocusDrawing() {
  state.focus.drawing = false;
  dom.lassoLayer.classList.remove('is-drawing');
  lassoPoints = [];
  lassoPointerId = null;
}

function drawLassoPath(closed) {
  const layer = dom.lassoLayer;
  const ctx = layer.getContext('2d');
  ctx.clearRect(0, 0, layer.width, layer.height);
  if (lassoPoints.length < 2) return;
  ctx.beginPath();
  lassoPoints.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
  if (closed) ctx.closePath();
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#C89A3C';
  ctx.stroke();
}

function finishFocusDrawing() {
  const layer = dom.lassoLayer;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  lassoPoints.forEach((p) => {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  });
  const tooSmall = lassoPoints.length < FOCUS_MIN_LOOP_PX
    || (maxX - minX) < layer.width * FOCUS_MIN_LOOP_SHARE
    || (maxY - minY) < layer.height * FOCUS_MIN_LOOP_SHARE;
  if (tooSmall) {
    lassoPoints = [];
    drawLassoPath(false);
    showToast('Draw a bigger loop around the subject');
    return;
  }
  const rect = dom.frame.getBoundingClientRect();
  let loop = lassoPoints.map((p) => screenPointToPhoto(p.x + rect.left, p.y + rect.top));
  try {
    SNAP_BANDS.forEach((band) => { loop = snapLoopToEdges(loop, band); });
  } catch (err) {
    console.warn('edge snapping failed, using the loop as drawn', err);
  }
  state.focusHoleUrl = buildFocusMask(loop);
  state.focus.on = true;
  stopFocusDrawing();
  updateBlackout();
}

function initLasso() {
  const layer = dom.lassoLayer;
  layer.addEventListener('pointerdown', (e) => {
    if (!state.focus.drawing || lassoPointerId !== null) return;
    e.stopPropagation(); // keep the stage's drag/pinch handler out of it
    lassoPointerId = e.pointerId;
    try { layer.setPointerCapture(e.pointerId); } catch (err) { /* drawing still works without capture */ }
    const rect = layer.getBoundingClientRect();
    lassoPoints = [{ x: e.clientX - rect.left, y: e.clientY - rect.top }];
  });
  layer.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lassoPointerId) return;
    e.stopPropagation();
    const rect = layer.getBoundingClientRect();
    lassoPoints.push({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    drawLassoPath(false);
  });
  const end = (e) => {
    if (e.pointerId !== lassoPointerId) return;
    e.stopPropagation();
    lassoPointerId = null;
    drawLassoPath(true);
    finishFocusDrawing();
  };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== lassoPointerId) return;
    lassoPointerId = null;
    lassoPoints = [];
    drawLassoPath(false);
  });
}

function toggleFocusMode() {
  if (state.focus.drawing) { stopFocusDrawing(); return; } // tapping Focus again cancels
  if (!state.before.hasFile) { showToast('Load a before photo first'); return; }
  if (state.focus.on) {
    state.focus.on = false;
    updateBlackout();
  } else if (state.focusHoleUrl) {
    state.focus.on = true;
    updateBlackout();
  } else {
    startFocusDrawing();
  }
}

// Re-runs edge detection against the cached before-photo Image using the
// CURRENT outline color setting. Cheap enough (the image is downsampled to
// GHOST_OUTLINE_MAX_DIM first) to call on every color change without any
// debouncing. Returns true on success so callers can decide whether to
// reveal the outline layer.
function regenerateGhostOutline() {
  if (!state.before.img) return false;
  try {
    dom.ghostOutlineImg.src = computeGhostOutline(state.before.img, state.settings.outlineColor);
    return true;
  } catch (e) {
    console.warn('ghost outline generation failed', e); // blend layer still works fine without it
    return false;
  }
}

// Controls both ghost layers' visibility together: whether there's a
// before-photo loaded at all, and which layer(s) the "Ghost style"
// setting says to show. Each layer has its own intensity control — the
// blend layer follows the main "Ghost" opacity slider, the outline layer
// follows its own "Outline intensity" slider (thin lines read fine much
// brighter than a full-photo blend would, so the two aren't tied together).
function applyGhostOpacity() {
  const hasFile = state.before.hasFile;
  const style = state.settings.ghostStyle;
  dom.ghostImg.style.opacity = (hasFile && style !== 'outline') ? (state.settings.opacity / 100) : 0;
  dom.ghostOutlineImg.style.opacity = (hasFile && style !== 'blend') ? (state.settings.outlineIntensity / 100) : 0;
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
    const rect = dom.frame.getBoundingClientRect();
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
      const rect = dom.frame.getBoundingClientRect();
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

  const captureDebugText = DEBUG
    ? 'AT CAPTURE — ' + debugSnapshot() + '\nisFrontFacing during capture: ' + state.isFrontFacing
    : '';

  dom.shutterBtn.disabled = true;
  try {
    // ImageCapture's takePhoto() (the browser's dedicated still-photo
    // pipeline) is OFF by default — "Sharper capture (experimental)" in
    // Settings turns it on. It was originally on by default on the
    // assumption that it's a strict upgrade: higher resolution, same
    // framing as the live preview, via the same crop rectangle. A
    // real-device before/after test disproved that — on at least one
    // Android phone, a shot taken this way came out visibly more zoomed
    // in than a shot of the exact same framing taken moments later,
    // because takePhoto() pulls from the phone's own still-photo camera
    // pipeline, which can silently use a different field of view (its
    // own stabilization/zoom crop) than the getUserMedia video track the
    // live preview and ghost alignment are actually based on. The video
    // frame draw below doesn't have this risk by construction: it's
    // always literally the same pixels the on-screen preview just
    // showed, so two shots of the same on-screen framing always agree.
    // That consistency matters more here than the sharper capture, so it
    // stays opt-in for anyone on hardware where it isn't an issue.
    let stillImg = null;
    let usedHQStill = false;
    if (state.settings.preferHQStill && state.imageCapture) {
      try {
        const blob = await state.imageCapture.takePhoto();
        stillImg = await blobToImage(blob);
        usedHQStill = true;
      } catch (e) {
        console.warn('ImageCapture.takePhoto() unavailable/failed, using live video frame instead', e);
      }
    }

    // Extra crop-in to match the before-photo's effective zoom, derived
    // from the ghost's own pinch-to-scale — see computeEffectiveZoom()'s
    // comment. Only meaningful here (the live-camera capture path); the
    // native-camera-app handoff isn't affected, since if the before-photo
    // ALSO came from the native app, there's no cross-pipeline mismatch to
    // correct for in the first place.
    const zoom = computeEffectiveZoom();
    if (stillImg) {
      drawCroppedToCaptureCanvas(stillImg, stillImg.naturalWidth, stillImg.naturalHeight, state.isFrontFacing, zoom);
    } else {
      drawCroppedToCaptureCanvas(dom.video, vw, vh, state.isFrontFacing, zoom);
    }

    const afterDataUrl = dom.captureCanvas.toDataURL('image/jpeg', 0.92);
    const debugText = captureDebugText + (DEBUG ? '\nused ImageCapture.takePhoto() still: ' + usedHQStill + '\nextra zoom to match before: ' + zoom.toFixed(3) : '');
    await finishCapture(afterDataUrl, state.tilt.available ? state.tilt.live : null, debugText);
  } finally {
    dom.shutterBtn.disabled = false;
  }
}

// Crops+draws a source (the live <video>, or a decoded still Image) into
// #capture-canvas using the app's one shared "fit inside, preserve ratio,
// center" crop math — the same computeCropRect() the live preview uses —
// so every capture path (live shutter, HQ still, native-camera-app
// handoff) ends up framed identically to what was on screen and shaped to
// the same "Photo shape" setting. `mirror` re-applies the front-camera
// flip that's baked into what the user was looking at live; a photo
// handed back from a native camera app is already in its final
// orientation and should be drawn with mirror=false. `extraZoom` (default
// 1, i.e. no-op) shrinks the crop rectangle around its own center by that
// factor before drawing — see computeEffectiveZoom() — so the final image
// is a tighter, more zoomed-in crop of the same source, not a resize.
function drawCroppedToCaptureCanvas(sourceEl, srcW, srcH, mirror, extraZoom) {
  const ratio = currentCaptureRatio();
  let crop = computeCropRect(srcW, srcH, ratio);
  const zoom = extraZoom && extraZoom > 1 ? extraZoom : 1;
  if (zoom > 1) {
    const cx = crop.sx + crop.sw / 2;
    const cy = crop.sy + crop.sh / 2;
    const zw = crop.sw / zoom;
    const zh = crop.sh / zoom;
    crop = { sx: cx - zw / 2, sy: cy - zh / 2, sw: zw, sh: zh };
  }
  const w = Math.max(1, Math.round(crop.sw));
  const h = Math.max(1, Math.round(crop.sh));
  dom.captureCanvas.width = w;
  dom.captureCanvas.height = h;
  const ctx = dom.captureCanvas.getContext('2d');
  ctx.save();
  if (mirror) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(sourceEl, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
  ctx.restore();
  return { w, h };
}

function blobToImage(blob) {
  const url = URL.createObjectURL(blob);
  return loadImg(url).finally(() => URL.revokeObjectURL(url));
}

// Shared tail for every capture path: embeds the tilt reading (if any) as
// EXIF, builds the before/after composite, and opens the review sheet.
async function finishCapture(afterDataUrlRaw, tiltForExif, debugText) {
  let afterDataUrl = afterDataUrlRaw;
  if (tiltForExif && typeof piexif !== 'undefined') {
    try {
      const meta = { beta: round1(tiltForExif.beta), gamma: round1(tiltForExif.gamma), ts: Date.now() };
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

  state.lastCaptured = { afterDataUrl, compositeDataUrl, debugText: debugText || '' };

  // No before-photo was loaded, so there's nothing to compare/retake
  // against — save straight to the camera roll with no prompt at all.
  // Once a before-photo IS loaded, a wrong shot is much costlier (the
  // whole point is matching it), so that case still stops at the review
  // sheet for a Retake option before anything is saved.
  if (!compositeDataUrl) {
    await saveImages([{ dataUrl: afterDataUrl, name: filename('photo') }]);
    return;
  }
  showReviewSheet();
}

// "Take with Camera App" handoff: hands framing off to the device's own
// native camera app (its actual best-quality capture pipeline — full
// sensor resolution, HDR/night-mode processing, whatever that phone's
// camera is capable of) via <input type="file" capture>, then treats the
// returned photo like any other capture. There's no way to show the ghost
// overlay during that native app's own viewfinder — it's a separate app —
// so this suits the case where the phone is already held in the aligned
// position from the live overlay and just needs the shutter press to
// happen in the higher-quality app instead of here.
function triggerNativeCapture() {
  // Read tilt now, before the native camera app takes over the screen —
  // once it does, this page is backgrounded and can't read live device
  // orientation any more.
  state.pendingNativeTilt = (state.tilt.available && state.tilt.live)
    ? { beta: state.tilt.live.beta, gamma: state.tilt.live.gamma }
    : null;
  dom.nativeCaptureInput.setAttribute('capture', state.isFrontFacing ? 'user' : 'environment');
  dom.nativeCaptureInput.click();
}

function handleNativeCaptureFile(file) {
  const tiltForExif = state.pendingNativeTilt;
  state.pendingNativeTilt = null;
  const reader = new FileReader();
  reader.onload = () => {
    loadImg(reader.result).then((img) => {
      const { w, h } = drawCroppedToCaptureCanvas(img, img.naturalWidth, img.naturalHeight, false);
      const afterDataUrl = dom.captureCanvas.toDataURL('image/jpeg', 0.92);
      const debugText = DEBUG
        ? 'AT CAPTURE (native camera app handoff)\nsource photo: ' + img.naturalWidth + 'x' + img.naturalHeight
          + '\ncropped to: ' + w + 'x' + h + '  aspect setting: ' + state.settings.captureAspect
        : '';
      finishCapture(afterDataUrl, tiltForExif, debugText);
    }).catch(() => showToast('Could not read that photo'));
  };
  reader.onerror = () => showToast('Could not read that photo');
  reader.readAsDataURL(file);
}

function showReviewSheet() {
  const { afterDataUrl, compositeDataUrl, debugText } = state.lastCaptured;
  dom.reviewAfterImg.src = afterDataUrl;
  if (compositeDataUrl) {
    dom.reviewCompositeWrap.hidden = false;
    dom.reviewCompositeImg.src = compositeDataUrl;
  } else {
    dom.reviewCompositeWrap.hidden = true;
  }
  if (DEBUG && dom.reviewDebug) {
    dom.reviewDebug.hidden = false;
    dom.reviewDebug.textContent = debugText;
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

function makeImageFile(dataUrl, name) {
  return new File([dataUrlToBlob(dataUrl)], name, { type: 'image/jpeg' });
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Saves one or more images with as few separate taps as possible. On iOS,
// ALL files are handed to a single Web Share call when the browser
// supports it, so saving a photo + comparison together still needs only
// one "Save Image" tap in the native share sheet, not two in a row. That
// one tap is unavoidable on iOS — Apple gives a website no way to write
// into Photos without it, share sheet or not, so it isn't something this
// app can remove. Android and desktop get a plain per-file download
// instead, which needs no tap at all (though see the note above: it lands
// in Downloads, not necessarily the same album as photos the phone's own
// camera app saves).
async function saveImages(items) {
  const files = items.map(({ dataUrl, name }) => makeImageFile(dataUrl, name));

  if (isIOSDevice() && navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      showToast(files.length > 1
        ? 'Choose "Save Image" to add both to your photos'
        : 'Choose "Save Image" to add it to your photos');
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user cancelled the share sheet
      // otherwise fall through to per-file downloads below
    }
  }
  files.forEach(downloadFile);
  showToast(files.length > 1
    ? 'Saved to your downloads'
    : 'Saved ' + files[0].name + ' to your downloads');
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

  dom.nativeCaptureBtn.addEventListener('click', triggerNativeCapture);
  dom.nativeCaptureInput.addEventListener('change', () => {
    const file = dom.nativeCaptureInput.files && dom.nativeCaptureInput.files[0];
    dom.nativeCaptureInput.value = '';
    if (file) handleNativeCaptureFile(file);
  });

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

  dom.aspectButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.captureAspect = btn.dataset.aspect;
      dom.aspectButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
      applyFrameSize();
      saveSettings();
    });
  });

  dom.ghostStyleButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.ghostStyle = btn.dataset.value;
      dom.ghostStyleButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
      applyGhostOpacity();
      saveSettings();
    });
  });

  dom.outlineIntensitySlider.addEventListener('input', () => {
    state.settings.outlineIntensity = Number(dom.outlineIntensitySlider.value);
    dom.outlineIntensityPct.textContent = state.settings.outlineIntensity + '%';
    applyGhostOpacity();
    saveSettings();
  });

  dom.outlineColorInput.addEventListener('input', () => {
    state.settings.outlineColor = dom.outlineColorInput.value;
    syncOutlineSwatches();
    regenerateGhostOutline();
    saveSettings();
  });

  dom.outlineSwatches.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.outlineColor = btn.dataset.color;
      dom.outlineColorInput.value = btn.dataset.color;
      syncOutlineSwatches();
      regenerateGhostOutline();
      saveSettings();
    });
  });

  dom.focusBtn.addEventListener('click', toggleFocusMode);
  dom.focusRedrawBtn.addEventListener('click', startFocusDrawing);

  dom.flipGhostBtn.addEventListener('click', () => {
    state.ghost.flipped = !state.ghost.flipped;
    applyGhostTransform();
    showToast(state.ghost.flipped ? 'Ghost flipped' : 'Ghost un-flipped');
  });
  dom.resetGhostBtn.addEventListener('click', () => {
    resetGhostTransform();
    showToast('Ghost position & zoom reset');
  });

  dom.matchZoomToggle.addEventListener('click', () => {
    state.settings.matchZoomToGhost = !state.settings.matchZoomToGhost;
    dom.matchZoomToggle.setAttribute('aria-checked', String(state.settings.matchZoomToGhost));
    updateZoomBadge();
    saveSettings();
  });

  dom.hqStillToggle.addEventListener('click', () => {
    state.settings.preferHQStill = !state.settings.preferHQStill;
    dom.hqStillToggle.setAttribute('aria-checked', String(state.settings.preferHQStill));
    saveSettings();
    showToast(state.settings.preferHQStill
      ? 'Sharper capture on — keep it on (or off) for a whole before/after series'
      : 'Sharper capture off — captures now always match the live preview exactly');
  });

  dom.reviewClose.addEventListener('click', closeSheets);
  dom.retakeBtn.addEventListener('click', closeSheets);
  // The grid is the before and after side by side; the single photo is the new shot alone.
  dom.saveGridBtn.addEventListener('click', async () => {
    const { compositeDataUrl } = state.lastCaptured;
    await saveImages([{ dataUrl: compositeDataUrl, name: filename('grid') }]);
    closeSheets();
  });
  dom.saveSingleBtn.addEventListener('click', async () => {
    const { afterDataUrl } = state.lastCaptured;
    await saveImages([{ dataUrl: afterDataUrl, name: filename('photo') }]);
    closeSheets();
  });
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
  applyFrameSize();
  applyPinPosition();
  applyGhostOpacity();
  applyGhostTransform();
  initPinDrag();
  initGhostGestures();
  initLasso();
  initTiltUI();
  updateLightingBadge();
  wireControls();
  registerServiceWorker();
  window.addEventListener('resize', applyFrameSize);
  window.addEventListener('orientationchange', applyFrameSize);
}

document.addEventListener('DOMContentLoaded', init);
