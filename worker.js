import { hashPassword, verifyPassword, makeSessionToken, getSession, json, generateRecoveryCode } from './lib/auth.js';

// RESTORE IN PROGRESS - temporary minimal worker so the app boots.
// Full improved version will follow in the next commit.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'servico_em_manutencao', detalhe: 'Worker sendo restaurado. Aguarde alguns minutos.' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    try {
      return await env.ASSETS.fetch(request);
    } catch (e) {
      return new Response('App em manutencao', { status: 503 });
    }
  },
};
