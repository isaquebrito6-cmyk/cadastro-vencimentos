import { getSession, json } from './lib/auth.js';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const p = url.pathname;
      if (p.startsWith('/api/')) {
        return json({ error: 'worker_precisa_restaurar', dica: 'Cole artifacts/worker_COM_HISTORICO_PRONTO.js no GitHub em worker.js' }, 503);
      }
      if (env.ASSETS) {
        const assetRes = await env.ASSETS.fetch(request);
        if ((p === '/' || p === '/index.html') && assetRes.ok) {
          let html = await assetRes.text();
          if (!html.includes('carteirinha-patch.js')) {
            html = html.replace('</body>', '<script src="/carteirinha-patch.js?v=16"></script>\n</body>');
          }
          const headers = new Headers(assetRes.headers);
          headers.set('content-type', 'text/html; charset=utf-8');
          headers.delete('content-length');
          return new Response(html, { status: assetRes.status, headers });
        }
        return assetRes;
      }
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: 'internal_error' }, 500);
    }
  },
};
