// Speed + offline support: the app shell is served from cache so the
// dashboard opens instantly, even without signal. Map tiles are cached as you drive (up to a limit) so
// recently seen areas still show when coverage drops.

const VERSION = 'v5';
const SHELL = `carauto-shell-${VERSION}`;
const TILES = 'carauto-tiles';
const MAX_TILES = 1500;

const ASSETS = [
  './', 'index.html', 'car.html', 'phone.html',
  'css/app.css',
  'js/common.js', 'js/link.js',
  'js/car/app.js', 'js/car/nav.js', 'js/car/music.js', 'js/car/phone.js', 'js/car/voice.js', 'js/car/home.js', 'js/car/calls.js', 'js/car/vehicle.js',
  'js/phone/app.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png', 'vendor/leaflet/images/marker-shadow.png',
  'vendor/peerjs/peerjs.min.js', 'vendor/qrcode/qrcode.js',
  'manifest-car.webmanifest', 'manifest-phone.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('carauto-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles: network first, fall back to cache.
  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(TILES).then((c) => c.put(req, copy)).then(trimTiles);
        }
        return res;
      }).catch(() => caches.match(req).then((r) => r || Response.error())),
    );
    return;
  }

  // App files: served instantly from cache, refreshed in the background
  // (stale-while-revalidate). The next launch picks up any update.
  // App downloads (APKs) must always come fresh from the network, never from the cache.
  if (url.pathname.includes('/apk/') || url.pathname.endsWith('.apk')) return;

  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const cached = await cache.match(req, { ignoreSearch: true });
        const network = fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        });
        if (cached) {
          e.waitUntil(network.catch(() => {}));
          return cached;
        }
        return network.catch(() => cache.match('index.html'));
      }),
    );
  }
  // Everything else (search, routing, radio streams) goes straight to the network.
});
