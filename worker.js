import { hashPassword, verifyPassword, makeSessionToken, getSession, json, generateRecoveryCode, usernameValido } from './lib/auth.js';

// TEMPORARY - full file push in progress
export default {
  async fetch(request, env) {
    return new Response(JSON.stringify({ error: 'restaurando', detalhe: 'Restaure worker.js do commit e74849e7 ou dos artifacts' }), { status: 503, headers: { 'content-type': 'application/json' } });
  }
};
