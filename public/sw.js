const CACHE_NAME = 'vencimentos-cache-v14';
const APP_SHELL = ['/', '/index.html', '/manifest.json', '/icon-512.png', '/icon-180.png', '/carteirinha-patch.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) {
    return;
  }
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }
  const ehPagina = event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  const buscarERegistrar = () => fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    }
    return response;
  });
  event.respondWith(
    ehPagina
      ? buscarERegistrar().catch(() => caches.match(event.request).then((c) => c || caches.match('/index.html')))
      : caches.match(event.request).then((cached) => cached || buscarERegistrar())
  );
});
