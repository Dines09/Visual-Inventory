const PREFIX = 'visual-inventory-';
const CACHE_NAME = PREFIX + 'v22';
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
// How long to wait for the network before answering from the cache. On a ship
// the connection is often "up" but dead, and a plain fetch() then hangs.
const NET_TIMEOUT = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Only our own old caches: dines09.github.io is shared with the other apps
  // (Month End, PMS, ...) and CacheStorage is per origin, so deleting every
  // other cache name wiped their offline copies too.
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first for the app shell so fixes/updates reach the device whenever it's online;
// after NET_TIMEOUT (or offline) it answers from the cache so the app still opens with no signal.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  const net = fetch(req).then(response => {
    if (response && response.status === 200 && response.type === 'basic') {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
    }
    return response;
  });
  event.waitUntil(net.catch(() => {}));
  const cached = () => caches.match(req, { ignoreSearch: true })
    .then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NET_TIMEOUT));
  event.respondWith(
    Promise.race([net, timeout]).catch(() => cached().then(hit => hit || net))
  );
});
