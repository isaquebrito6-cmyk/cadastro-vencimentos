import { hashPassword, verifyPassword, makeSessionToken, getSession, json, generateRecoveryCode, usernameValido } from './lib/auth.js';

// TEMP: worker mínimo estável enquanto o completo sobe
// Este arquivo será substituído pelo completo na sequência

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p.startsWith('/api/')) {
        // Deixa claro no log do CF que o worker está de pé, mas precisa do arquivo completo
        return json({ error: 'worker_parcial', dica: 'Aguardando worker completo no GitHub' }, 503);
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
      return json({ error: 'internal_error', message: String(err && err.message || err) }, 500);
    }
  },
};
