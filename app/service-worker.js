const CACHE_VERSION = 'eng-study-v4';
const SHELL_STATIC = [
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png'
];

// Files that should always be fresh from network
const NETWORK_FIRST = ['app.js', 'styles.css', 'index.html', 'manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache the Anthropic API
  if (url.hostname === 'api.anthropic.com') return;

  if (url.origin === self.location.origin) {
    const filename = url.pathname.split('/').pop() || 'index.html';
    const isNetworkFirst = NETWORK_FIRST.some((f) => filename === f || url.pathname.endsWith('/' + f) || url.pathname === url.pathname.replace(/[^/]*$/, '') );

    if (NETWORK_FIRST.some((f) => url.pathname.endsWith(f) || url.pathname.endsWith('/'))) {
      // Network-first: always try network, fall back to cache
      event.respondWith(
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
      );
    } else {
      // Cache-first for static assets (icons etc.)
      event.respondWith(
        caches.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
            return res;
          }).catch(() => caches.match('./index.html'));
        })
      );
    }
    return;
  }

  // Cross-origin (e.g. Google Fonts): stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
