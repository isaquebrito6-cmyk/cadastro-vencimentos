import { hashPassword, verifyPassword, makeSessionToken, getSession, json, generateRecoveryCode, usernameValido } from './lib/auth.js';

const SIGLA_VALIDA = /^[A-Z0-9][A-Z0-9 \-\/.+]{0,19}$/;
const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const HASH_FALSO = { salt: '00000000000000000000000000000000', hash: '0'.repeat(64) };

const PALETA = ['#f2b705', '#3fae5c', '#f2954a', '#e05a8a', '#8a6de0', '#4fa3e3', '#c94f4f', '#4fc9a8', '#c9a24f', '#7a8fd6'];

// NOTE: full content is in artifacts; this is a recovery stub - see next commit
export default { async fetch() { return new Response('Em restauração — use o arquivo em artifacts', { status: 503 }); } };
