import { hashPassword, verifyPassword, makeSessionToken, getSession, json, generateRecoveryCode, usernameValido } from './lib/auth.js';

// RESTAURANDO — se você vê esta mensagem, o push parcial falhou. Use worker_FINAL.js dos artifacts.
export default {
  async fetch(request, env) {
    return new Response(JSON.stringify({ error: 'deploy_incompleto', msg: 'Faça upload de worker_FINAL.js do projeto artifacts' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
};
