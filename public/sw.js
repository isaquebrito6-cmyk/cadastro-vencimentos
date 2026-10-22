const CACHE_NAME = 'vencimentos-cache-v16';
const APP_SHELL = ['/', '/index.html', '/manifest.json', '/icon-512.png', '/icon-180.png', '/carteirinha-patch.js'];
const PATCH_TAG = '<script src="/carteirinha-patch.js"></script>';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL).catch(() => {}))
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

function injetarPatch(response) {
  if (!response || !response.ok) return response;
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return response;
  return response.text().then((html) => {
    if (!html.includes('carteirinha-patch.js')) {
      html = html.replace('</body>', PATCH_TAG + '\n</body>');
      if (!html.includes('carteirinha-patch.js')) {
        html = html + PATCH_TAG;
      }
    }
    const headers = new Headers(response.headers);
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.delete('content-length');
    return new Response(html, { status: response.status, statusText: response.statusText, headers });
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  const ehPagina = event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');

  if (ehPagina) {
    event.respondWith(
      fetch(event.request)
        .then((response) => injetarPatch(response))
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(event.request).then((c) => c || caches.match('/index.html')).then((c) => injetarPatch(c || new Response('Offline', { status: 503 })))
        )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
