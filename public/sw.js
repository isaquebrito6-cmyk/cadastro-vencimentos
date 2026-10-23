const CACHE_NAME = 'vencimentos-cache-v29';
const PATCH_URL = '/carteirinha-patch.js?v=29';
const APP_SHELL = ['/', '/index.html', '/manifest.json', '/icon-512.png', '/icon-180.png'];
const PATCH_TAG = '<script src="' + PATCH_URL + '"></script>';

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
    ).then(() => self.clients.claim())
  );
});

function injetarPatch(response) {
  if (!response || !response.ok) return response;
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return response;
  return response.text().then((html) => {
    html = html.replace(/<script[^>]*carteirinha-patch\.js[^>]*><\/script>/g, '');
    if (html.includes('</body>')) {
      html = html.replace('</body>', PATCH_TAG + '\n</body>');
    } else {
      html = html + PATCH_TAG;
    }
    const headers = new Headers(response.headers);
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.set('cache-control', 'no-store');
    headers.delete('content-length');
    return new Response(html, { status: response.status, statusText: response.statusText, headers });
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname.indexOf('carteirinha-patch.js') !== -1) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request))
    );
    return;
  }

  const ehPagina = event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  if (ehPagina) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((response) => injetarPatch(response))
        .catch(() =>
          caches.match(event.request).then((c) => c || caches.match('/index.html')).then((c) => injetarPatch(c || new Response('Offline', { status: 503 })))
        )
    );
    return;
  }

  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
