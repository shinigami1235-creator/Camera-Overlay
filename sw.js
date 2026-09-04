// Camera Overlay — Cygnus Solutions
//
// The app shell (HTML/CSS/JS/manifest) is served network-first: try the
// network so a fix pushed to GitHub Pages is picked up the very next time
// the page loads, and only fall back to the cached copy when actually
// offline. The rarely-changing binary assets (vendored EXIF library, icon
// PNGs) are served cache-first for instant loads, since they're large and
// essentially never change between deploys.
//
// Bump CACHE_NAME whenever APP_SHELL's file list itself changes (a file
// added/removed) — that forces a clean cache rebuild on next activate.
const CACHE_NAME = 'camera-overlay-v2';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './vendor/piexif.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-48.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

function isLongLivedAsset(pathname) {
  return pathname.includes('/vendor/') || pathname.includes('/icons/');
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Never cache Google Fonts CSS/woff2 — always try the network first so
  // font updates aren't stuck, but fall back silently if offline.
  if (url.origin.includes('fonts.g')) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  if (url.origin !== self.location.origin) return; // don't intercept anything else cross-origin

  if (isLongLivedAsset(url.pathname)) {
    // Cache-first: safe to serve instantly, these essentially never change.
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }))
    );
    return;
  }

  // Network-first for the app shell itself, so fixes actually reach
  // returning users instead of being stuck behind a stale cached copy.
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
