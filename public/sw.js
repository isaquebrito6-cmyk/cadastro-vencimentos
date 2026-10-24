const CACHE_NAME = 'vencimentos-cache-v40';
const APP_SHELL = ['/', '/index.html', '/manifest.json', '/icon-512.png', '/icon-180.png'];

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
  // Nunca guarda em cache chamadas de API — elas têm que sempre ir direto pro servidor,
  // senão as alterações (colaboradores, histórico etc.) parecem não atualizar sem recarregar a página.
  if (url.pathname.startsWith('/api/')) {
    return;
  }
  // Só cuida do resto das requisições do próprio site; deixa fontes externas (Google Fonts etc.) passarem direto.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }
  // Páginas (HTML): rede primeiro, pra a pessoa sempre receber a versão nova após um deploy;
  // o cache só entra se estiver sem internet. Demais arquivos (ícones etc.): cache primeiro.
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
