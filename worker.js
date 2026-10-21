import { hashPassword, verifyPassword, makeSessionToken, getSession, json, generateRecoveryCode } from './lib/auth.js';
import { initCert, handleCertificado, garantirTabelasCert, apagarCertificadosDaLixeira } from './lib/cert.js';

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
  await apagarCertificadosDaLixeira(db, null, limite);
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

function dataValida(v) {
  if (typeof v !== 'string' || !DATA_ISO.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (y < 1900 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
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
  const { results } = await db.prepare('SELECT username, password_hash, password_salt, role, empresa_id, failed_attempts, locked_until FROM users WHERE username = ?').bind(username).all();
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

async function handleEmpresas(request, env, url) {
  const session = await obterSessao(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  const db = env.DB;
  if (request.method === 'GET') {
    if (session.role === 'admin') {
      const { results } = await db.prepare('SELECT id, nome, criado_em FROM empresas ORDER BY nome ASC').all();
      return json({ empresas: results });
    }
    if (!session.empresaId) return json({ empresas: [] });
    const { results } = await db.prepare('SELECT id, nome, criado_em FROM empresas WHERE id = ?').bind(session.empresaId).all();
    return json({ empresas: results });
  }
  if (request.method === 'POST') {
    if (session.role !== 'admin') return json({ error: 'somente_admin' }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
    const nome = String(body.nome || '').trim();
    if (!nome) return json({ error: 'nome_obrigatorio' }, 400);
    const { meta } = await db.prepare('INSERT INTO empresas (nome) VALUES (?)').bind(nome).run();
    const empresaId = meta.last_row_id;
    const stmts = BUILTIN_DOC_TYPES.map((dt, i) =>
      db.prepare('INSERT INTO doc_types (sigla, nome, descricao, cor, ordem, empresa_id) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(dt.sigla, dt.nome, dt.desc, PALETA[i % PALETA.length], i + 1, empresaId)
    );
    stmts.push(db.prepare('INSERT INTO config (empresa_id, chave, valor) VALUES (?, ?, ?)').bind(empresaId, 'avisoDias', '30'));
    stmts.push(db.prepare('INSERT INTO config (empresa_id, chave, valor) VALUES (?, ?, ?)').bind(empresaId, 'empresa', nome));
    await db.batch(stmts);
    await regHist(db, request, session.username, `Criou a empresa "${nome}"`, 'seguranca', empresaId);
    return json({ ok: true, id: empresaId, nome });
  }
  return json({ error: 'method_not_allowed' }, 405);
}

async function handleData(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  const session = await obterSessao(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  const db = env.DB;
  const resolvido = await resolverEmpresa(session, url, db);
  if (!resolvido.ok) return json({ error: resolvido.error }, 403);
  const empresaId = resolvido.empresaId;
  const [colaboradoresRes, docTypesRes, configRes, historicoRes, empresaRes] = await Promise.all([
    db.prepare('SELECT id, nome, notas, docs FROM colaboradores WHERE empresa_id = ? AND deletado_em IS NULL ORDER BY ordem ASC, nome ASC').bind(empresaId).all(),
    db.prepare('SELECT sigla, nome, descricao, cor, ordem FROM doc_types WHERE empresa_id = ? ORDER BY ordem ASC').bind(empresaId).all(),
    db.prepare('SELECT chave, valor FROM config WHERE empresa_id = ?').bind(empresaId).all(),
    db.prepare('SELECT id, ts, username, acao, tipo, ip, user_agent FROM historico WHERE empresa_id = ? AND deletado_em IS NULL ORDER BY ts DESC LIMIT 500').bind(empresaId).all(),
    db.prepare('SELECT id, nome FROM empresas WHERE id = ?').bind(empresaId).all(),
  ]);
  const colaboradores = colaboradoresRes.results.map(c => {
    let notas = [], docs = {};
    try { notas = JSON.parse(c.notas) || []; } catch {}
    try { docs = JSON.parse(c.docs) || {}; } catch {}
    return { id: c.id, nome: c.nome, notas, docs };
  });
  const config = {};
  configRes.results.forEach(r => { config[r.chave] = r.valor; });
  let empresas = null;
  if (session.role === 'admin') {
    const { results } = await db.prepare('SELECT id, nome FROM empresas ORDER BY nome ASC').all();
    empresas = results;
  }
  let certificados = [];
  try {
    await garantirTabelasCert(db);
    const { results: certRes } = await db.prepare('SELECT id, colaborador_id, sigla, nome_arquivo, tipo, tamanho, enviado_em FROM certificados WHERE empresa_id = ? AND deletado_em IS NULL ORDER BY enviado_em ASC').bind(empresaId).all();
    certificados = certRes;
  } catch (err) {}
  return json({
    certificados,
    colaboradores, docTypes: docTypesRes.results, config, historico: historicoRes.results,
    role: session.role, username: session.username,
    empresaAtual: empresaRes.results[0] || null,
    empresas,
  });
}

async function handleColaborador(request, env, url) {
  const session = await obterSessao(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  const db = env.DB;
  const resolvido = await resolverEmpresa(session, url, db);
  if (!resolvido.ok) return json({ error: resolvido.error }, 403);
  const empresaId = resolvido.empresaId;
  if (request.method === 'GET') {
    await purgarLixeiraAntiga(db);
    const { results } = await db.prepare('SELECT id, nome, docs, deletado_em FROM colaboradores WHERE empresa_id = ? AND deletado_em IS NOT NULL ORDER BY deletado_em DESC').bind(empresaId).all();
    return json({
      lixeira: results.map(c => {
        let docs = {};
        try { docs = JSON.parse(c.docs) || {}; } catch {}
        return { id: c.id, nome: c.nome, docs, deletado_em: c.deletado_em };
      }),
      diasRetencao: DIAS_RETENCAO_LIXEIRA,
    });
  }
  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
    const id = String(body.id || '');
    if (!id) return json({ error: 'id_obrigatorio' }, 400);
    const { results } = await db.prepare('SELECT nome FROM colaboradores WHERE id = ? AND empresa_id = ? AND deletado_em IS NOT NULL').bind(id, empresaId).all();
    if (results.length === 0) return json({ error: 'nao_encontrado' }, 404);
    await db.prepare('UPDATE colaboradores SET deletado_em = NULL WHERE id = ?').bind(id).run();
    await regHist(db, request, session.username, `Restaurou colaborador "${results[0].nome}" da lixeira`, 'dados', empresaId);
    return json({ ok: true });
  }
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
    const nome = String(body.nome || '').trim();
    if (!nome) return json({ error: 'nome_obrigatorio' }, 400);
    if (nome.length > 200) return json({ error: 'nome_muito_longo' }, 400);
    const notas = (Array.isArray(body.notas) ? body.notas : []).slice(0, 50).map(n => String(n).slice(0, 500));
    const { results: tipos } = await db.prepare('SELECT sigla FROM doc_types WHERE empresa_id = ?').bind(empresaId).all();
    const siglasValidas = new Set(tipos.map(t => t.sigla));
    const docs = {};
    if (body.docs && typeof body.docs === 'object') {
      for (const [sigla, valor] of Object.entries(body.docs)) {
        if (!siglasValidas.has(sigla)) continue;
        if (valor === null || valor === '' || valor === undefined) { docs[sigla] = null; continue; }
        if (!dataValida(valor)) return json({ error: 'data_invalida', sigla }, 400);
        docs[sigla] = valor;
      }
    }
    let id = body.id;
    const isNew = !id;
    if (isNew) {
      id = 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const { results } = await db.prepare('SELECT COALESCE(MAX(ordem), 0) AS max FROM colaboradores WHERE empresa_id = ?').bind(empresaId).all();
      await db.prepare('INSERT INTO colaboradores (id, nome, notas, docs, ordem, empresa_id) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, nome, JSON.stringify(notas), JSON.stringify(docs), results[0].max + 1, empresaId).run();
    } else {
      const { results } = await db.prepare('SELECT id FROM colaboradores WHERE id = ? AND empresa_id = ?').bind(id, empresaId).all();
      if (results.length === 0) return json({ error: 'nao_encontrado' }, 404);
      await db.prepare("UPDATE colaboradores SET nome = ?, notas = ?, docs = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(nome, JSON.stringify(notas), JSON.stringify(docs), id).run();
    }
    await regHist(db, request, session.username, (isNew ? 'Criou' : 'Editou') + ` colaborador "${nome}"`, 'dados', empresaId);
    return json({ ok: true, id });
  }
  if (request.method === 'DELETE') {
    if (url.searchParams.get('esvaziar') === 'tudo') {
      if (session.role !== 'admin') return json({ error: 'somente_admin' }, 403);
      const { results: countRes } = await db.prepare('SELECT COUNT(*) AS count FROM colaboradores WHERE empresa_id = ? AND deletado_em IS NOT NULL').bind(empresaId).all();
      await db.prepare('DELETE FROM colaboradores WHERE empresa_id = ? AND deletado_em IS NOT NULL').bind(empresaId).run();
      await regHist(db, request, session.username, `Esvaziou a lixeira de colaboradores (${countRes[0].count} apagados definitivamente)`, 'seguranca', empresaId);
      return json({ ok: true });
    }
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'id_obrigatorio' }, 400);
    const { results } = await db.prepare('SELECT nome FROM colaboradores WHERE id = ? AND empresa_id = ? AND deletado_em IS NULL').bind(id, empresaId).all();
    if (results.length === 0) return json({ error: 'nao_encontrado' }, 404);
    await db.prepare('UPDATE colaboradores SET deletado_em = ? WHERE id = ?').bind(new Date().toISOString(), id).run();
    await regHist(db, request, session.username, `Moveu colaborador "${results[0].nome}" para a lixeira`, 'dados', empresaId);
    return json({ ok: true });
  }
  return json({ error: 'method_not_allowed' }, 405);
}

export default {
  async fetch(request, env, ctx) {
    initCert({ obterSessao, resolverEmpresa, regHist });
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/api/login') return await handleLogin(request, env);
      if (p === '/api/empresas') return await handleEmpresas(request, env, url);
      if (p === '/api/data') return await handleData(request, env, url);
      if (p === '/api/colaborador') return await handleColaborador(request, env, url);
      if (p === '/api/certificado') return await handleCertificado(request, env, url);
    } catch (err) {
      console.error(err);
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
