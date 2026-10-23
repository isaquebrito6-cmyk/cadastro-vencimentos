import { hashPassword, verifyPassword, makeSessionToken, getSession, json, generateRecoveryCode, usernameValido } from './lib/auth.js';

// RESTORE temporary - full file will be updated next
export default {
  async fetch(request, env, ctx) {
    return json({ error: 'worker_restoring' }, 503);
  }
};
