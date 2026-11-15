const CACHE_NAME = 'achat-shell-v15';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.mjs',
  '/achat.ico',
  '/icon.svg',
  '/icon-192.png',
  '/manifest.webmanifest',
  '/vendor/marked.esm.js',
  '/vendor/purify.es.mjs',
  '/vendor/katex/katex.min.css',
  '/vendor/katex/katex.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/download/')) return;

  // Network-first so fresh UI updates take effect immediately, falling back to cache if offline
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, clone))
            .catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html')))
  );
});
