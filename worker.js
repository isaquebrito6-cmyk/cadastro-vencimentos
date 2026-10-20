import { hashPassword, verifyPassword, makeSessionToken, getSession, json, generateRecoveryCode } from './lib/auth.js';

const SIGLA_VALIDA = /^[A-Z0-9][A-Z0-9 \-\/.+]{0,19}$/;
const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const HASH_FALSO = { salt: '00000000000000000000000000000000', hash: '0'.repeat(64) };

const PALETA = ['#f2b705', '#3fae5c', '#f2954a', '#e05a8a', '#8a6de0', '#4fa3e3', '#c94f4f', '#4fc9a8', '#c9a24f', '#7a8fd6'];

const BUILTIN_DOC_TYPES = [
  { sigla: 'ASO', nome: 'NR-07 · Atestado de Saúde Ocupacional', desc: 'Exame médico ocupacional obrigatório para todo colaborador.' },
  { sigla: 'NR-35', nome: 'Trabalho em Altura', desc: 'Treinamento obrigatório para atividades acima de 2m com risco de queda.' },
  { sigla: 'NR-33', nome: 'Espaços Confinados', desc: 'Treinamento para entrada e trabalho em espaços confinados (trabalhador).' },
  { sigla: 'NR-33 SUP', nome: 'Espaços Confinados · Supervisor', desc: 'Capacitação de supervisor responsável por entradas em espaços confinados.' },
  { sigla: 'LOTO', nome: 'NR-10/12 · Bloqueio e Etiquetagem', desc: 'Procedimento de bloqueio e etiquetagem (Lockout/Tagout) para energia perigosa.' },
  { sigla: 'NR-11/18', nome: 'Plataforma de Elevação', desc: 'Capacitação para operação de plataformas elevatórias / movimentação de cargas.' },
  { sigla: 'NR-20', nome: 'Inflamáveis e Combustíveis', desc: 'Treinamento para atividades com líquidos inflamáveis e combustíveis.' },
];

const MAX_TENTATIVAS = 5;
const BLOQUEIO_MINUTOS = 15;
const DIAS_RETENCAO_LIXEIRA = 30;

function clienteInfo(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'desconhecido';
  const ua = request.headers.get('User-Agent') || 'desconhecido';
  return { ip, ua };
}

async function obterSessao(request, env) {
  if (!env.SESSION_SECRET) return null;
  const token = await getSession(request, env.SESSION_SECRET);
  if (!token || !token.username) return null;
  const { results } = await env.DB.prepare('SELECT username, role, empresa_id FROM users WHERE username = ?').bind(token.username).all();
  const u = results[0];
  if (!u) return null;
  return { username: u.username, role: u.role, empresaId: u.empresa_id };
}

async function regHist(db, request, username, acao, tipo = 'dados', empresaId = null) {
  const { ip, ua } = clienteInfo(request);
  await db.prepare('INSERT INTO historico (username, acao, tipo, ip, user_agent, empresa_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(username, acao, tipo, ip, ua, empresaId).run();
}

function dataLimiteRetencao() {
  return new Date(Date.now() - DIAS_RETENCAO_LIXEIRA * 24 * 60 * 60 * 1000).toISOString();
}

async function purgarLixeiraAntiga(db) {
  const limite = dataLimiteRetencao();
  try { await apagarCertificadosDaLixeira(db, null, limite); } catch (e) {}
  await db.prepare('DELETE FROM colaboradores WHERE deletado_em IS NOT NULL AND deletado_em < ?').bind(limite).run();
  await db.prepare('DELETE FROM historico WHERE deletado_em IS NOT NULL AND deletado_em < ?').bind(limite).run();
}

async function resolverEmpresa(session, url, db) {
  const requestedRaw = url.searchParams.get('empresa_id');
  const requested = requestedRaw ? parseInt(requestedRaw, 10) : null;
  if (session.role === 'admin') {
    if (requested) {
      const { results: ex } = await db.prepare('SELECT id FROM empresas WHERE id = ?').bind(requested).all();
      if (ex.length === 0) return { ok: false, error: 'empresa_inexistente' };
      return { ok: true, empresaId: requested };
    }
    const { results } = await db.prepare('SELECT id FROM empresas ORDER BY id ASC LIMIT 1').all();
    if (results.length === 0) return { ok: false, error: 'nenhuma_empresa_cadastrada' };
    return { ok: true, empresaId: results[0].id };
  }
  if (!session.empresaId) return { ok: false, error: 'usuario_sem_empresa' };
  if (requested && requested !== session.empresaId) return { ok: false, error: 'sem_acesso_a_essa_empresa' };
  return { ok: true, empresaId: session.empresaId };
}

async function handleLogin(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const secret = env.SESSION_SECRET;
  if (!secret) return json({ error: 'server_not_configured' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return json({ error: 'missing_credentials' }, 400);
  const db = env.DB;
  const { results: countRows } = await db.prepare('SELECT COUNT(*) AS count FROM users').all();
  const count = countRows[0].count;
  if (count === 0) {
    if (password.length < 8) return json({ error: 'password_too_short' }, 400);
    const { hash, salt } = await hashPassword(password);
    const recoveryCode = generateRecoveryCode();
    const { hash: recoveryHash, salt: recoverySalt } = await hashPassword(recoveryCode);
    await db.prepare('INSERT INTO users (username, password_hash, password_salt, role, recovery_hash, recovery_salt, empresa_id) VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .bind(username, hash, salt, 'admin', recoveryHash, recoverySalt).run();
    await regHist(db, request, username, 'Criou a conta de administrador (primeiro acesso)', 'seguranca');
    const token = await makeSessionToken({ username, role: 'admin', empresaId: null }, secret);
    return json({ token, username, role: 'admin', empresaId: null, bootstrap: true, recoveryCode });
  }
  const { results } = await db.prepare('SELECT username, password_hash, password_salt, role, empresa_id, failed_attempts, locked_until FROM users WHERE username = ?')
    .bind(username).all();
  const user = results[0];
  if (user && user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    const minutosRestantes = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
    return json({ error: 'conta_bloqueada', minutos: minutosRestantes }, 423);
  }
  const senhaOk = user
    ? await verifyPassword(password, user.password_salt, user.password_hash)
    : (await verifyPassword(password, HASH_FALSO.salt, HASH_FALSO.hash), false);
  if (!senhaOk) {
    if (user) {
      const tentativas = user.failed_attempts + 1;
      if (tentativas >= MAX_TENTATIVAS) {
        const bloqueadoAte = new Date(Date.now() + BLOQUEIO_MINUTOS * 60000).toISOString();
        await db.prepare('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE username = ?').bind(bloqueadoAte, username).run();
        await regHist(db, request, username, `Conta bloqueada por ${BLOQUEIO_MINUTOS} minutos após ${MAX_TENTATIVAS} tentativas de login erradas`, 'seguranca', user.empresa_id);
      } else {
        await db.prepare('UPDATE users SET failed_attempts = ? WHERE username = ?').bind(tentativas, username).run();
        await regHist(db, request, username, 'Tentativa de login falhou (senha incorreta)', 'seguranca', user.empresa_id);
      }
    }
    return json({ error: 'invalid_credentials' }, 401);
  }
  await db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = ?').bind(username).run();
  const token = await makeSessionToken({ username: user.username, role: user.role, empresaId: user.empresa_id }, secret);
  await regHist(db, request, username, 'Entrou no sistema', 'seguranca', user.empresa_id);
  return json({ token, username: user.username, role: user.role, empresaId: user.empresa_id });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/api/login') return await handleLogin(request, env);
    } catch (err) {
      return json({ error: 'erro_interno' }, 500);
    }
    const resp = await env.ASSETS.fetch(request);
    const seguro = new Response(resp.body, resp);
    seguro.headers.set('X-Content-Type-Options', 'nosniff');
    seguro.headers.set('X-Frame-Options', 'DENY');
    seguro.headers.set('Referrer-Policy', 'same-origin');
    return seguro;
  },
};
