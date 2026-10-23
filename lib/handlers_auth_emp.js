import {
  BLOQUEIO_MINUTOS,
  HASH_FALSO,
  MAX_TENTATIVAS,
  obterSessao,
  regHist,
  resolverEmpresa,
  garantirTabelaFotos,
  garantirTabelasCert
} from './handlers_core.js';
import { json, hashPassword, verifyPassword, makeSessionToken, generateRecoveryCode, usernameValido } from './auth.js';

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
  if (countRows[0].count === 0) {
    if (!usernameValido(username)) return json({ error: 'usuario_invalido' }, 400);
    if (password.length < 8) return json({ error: 'password_too_short' }, 400);
    const { hash, salt } = await hashPassword(password);
    const recoveryCode = generateRecoveryCode();
    const { hash: recoveryHash, salt: recoverySalt } = await hashPassword(recoveryCode);
    await db.prepare('INSERT INTO users (username, password_hash, password_salt, role, recovery_hash, recovery_salt, empresa_id) VALUES (?, ?, ?, ?, ?, ?, NULL)').bind(username, hash, salt, 'admin', recoveryHash, recoverySalt).run();
    await regHist(db, request, username, 'Criou a conta de administrador (primeiro acesso)', 'seguranca');
    const token = await makeSessionToken({ username, role: 'admin', empresaId: null }, secret);
    return json({ token, username, role: 'admin', empresaId: null, bootstrap: true, recoveryCode });
  }
  const { results } = await db.prepare('SELECT username, password_hash, password_salt, role, empresa_id, failed_attempts, locked_until FROM users WHERE username = ?').bind(username).all();
  const user = results[0];
  if (user && user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    const minutos = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
    return json({ error: 'account_locked', minutos }, 423);
  }
  const senhaOk = user ? await verifyPassword(password, user.password_salt, user.password_hash) : (await verifyPassword(password, HASH_FALSO.salt, HASH_FALSO.hash), false);
  if (!senhaOk) {
    if (user) {
      const tentativas = (user.failed_attempts || 0) + 1;
      if (tentativas >= MAX_TENTATIVAS) {
        const bloqueadoAte = new Date(Date.now() + BLOQUEIO_MINUTOS * 60000).toISOString();
        await db.prepare('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE username = ?').bind(bloqueadoAte, username).run();
      } else {
        await db.prepare('UPDATE users SET failed_attempts = ? WHERE username = ?').bind(tentativas, username).run();
      }
    }
    return json({ error: 'invalid_credentials' }, 401);
  }
  await db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = ?').bind(username).run();
  const token = await makeSessionToken({ username: user.username, role: user.role, empresaId: user.empresa_id }, secret);
  await regHist(db, request, username, 'Entrou no sistema', 'seguranca', user.empresa_id);
  return json({ token, username: user.username, role: user.role, empresaId: user.empresa_id });
}

async function handleEmpresas(request, env, url) {
  const session = await obterSessao(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  const db = env.DB;
  if (request.method === 'GET') {
    if (session.role !== 'admin') return json({ error: 'somente_admin' }, 403);
    const { results } = await db.prepare('SELECT id, nome FROM empresas ORDER BY nome ASC').all();
    return json({ empresas: results });
  }
  if (request.method === 'POST') {
    if (session.role !== 'admin') return json({ error: 'somente_admin' }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
    const nome = String(body.nome || '').trim();
    if (!nome) return json({ error: 'nome_obrigatorio' }, 400);
    const r = await db.prepare('INSERT INTO empresas (nome) VALUES (?)').bind(nome).run();
    const id = r.meta.last_row_id;
    await regHist(db, request, session.username, `Criou empresa "${nome}"`, 'seguranca', id);
    return json({ ok: true, id, nome });
  }
  if (request.method === 'DELETE') {
    if (session.role !== 'admin') return json({ error: 'somente_admin' }, 403);
    const id = parseInt(url.searchParams.get('id') || '', 10);
    if (!id) return json({ error: 'id_obrigatorio' }, 400);
    const { results } = await db.prepare('SELECT nome FROM empresas WHERE id = ?').bind(id).all();
    if (!results.length) return json({ error: 'nao_encontrado' }, 404);
    const nome = results[0].nome;
    const { results: countRows } = await db.prepare('SELECT COUNT(*) AS c FROM empresas').all();
    if (countRows[0].c <= 1) return json({ error: 'nao_pode_excluir_ultima_empresa' }, 400);
    try {
      await garantirTabelasCert(db);
      await db.prepare('DELETE FROM certificado_partes WHERE certificado_id IN (SELECT id FROM certificados WHERE empresa_id = ?)').bind(id).run();
      await db.prepare('DELETE FROM certificados WHERE empresa_id = ?').bind(id).run();
    } catch (_) {}
    try {
      await garantirTabelaFotos(db);
      await db.prepare('DELETE FROM colaborador_fotos WHERE empresa_id = ?').bind(id).run();
    } catch (_) {}
    await db.prepare('DELETE FROM colaboradores WHERE empresa_id = ?').bind(id).run();
    await db.prepare('DELETE FROM doc_types WHERE empresa_id = ?').bind(id).run();
    await db.prepare('DELETE FROM config WHERE empresa_id = ?').bind(id).run();
    await db.prepare('DELETE FROM historico WHERE empresa_id = ?').bind(id).run();
    await db.prepare('DELETE FROM empresas WHERE id = ?').bind(id).run();
    const { results: outras } = await db.prepare('SELECT id FROM empresas ORDER BY id ASC LIMIT 1').all();
    await regHist(db, request, session.username, `Excluiu a empresa "${nome}" (id ${id})`, 'seguranca', outras.length ? outras[0].id : null);
    return json({ ok: true, id, nome });
  }
  return json({ error: 'method_not_allowed' }, 405);
}

export { handleLogin, handleEmpresas };
