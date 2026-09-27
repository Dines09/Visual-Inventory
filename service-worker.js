const CACHE_NAME = 'visual-inventory-v20';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/db.js',
  './js/icons.js',
  './js/helpers.js',
  './js/pano-math.js',
  './js/pano-stitch.js',
  './js/pano-viewer.js',
  './js/pano-capture.js',
  './js/app.js',
  './js/location-view.js',
  './js/hotspot-modal.js',
  './js/export.js',
  './lib/minizip.js',
  './lib/xlsx-writer.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for the app shell so fixes/updates reach the device whenever it's online;
// falls back to cache so the app still works fully offline (e.g. no signal on a ship).
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).then(response => {
      if (response && response.status === 200 && response.type === 'basic') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
