import { handleLogin, handleEmpresas } from './lib/handlers_auth_emp.js';
import { handleData } from './lib/handlers_data2.js';
import { handleColaborador } from './lib/handlers_colab2.js';
import { handleHistorico } from './lib/handlers_hist2.js';
import { handleFoto } from './lib/handlers_core.js';
import { json } from './lib/auth.js';

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const p = url.pathname;
      if (p === '/api/login') return await handleLogin(request, env);
      if (p === '/api/empresas') return await handleEmpresas(request, env, url);
      if (p === '/api/data') return await handleData(request, env, url);
      if (p === '/api/foto') return await handleFoto(request, env, url);
      if (p === '/api/historico') return await handleHistorico(request, env, url);
      if (p === '/api/colaborador') return await handleColaborador(request, env, url);
      if (p.startsWith('/api/')) return json({ error: 'not_found' }, 404);
      if (env.ASSETS) {
        const assetRes = await env.ASSETS.fetch(request);
        if ((url.pathname === '/' || url.pathname === '/index.html') && assetRes.ok) {
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
