import { hashPassword, verifyPassword, makeSessionToken, getSession, json, generateRecoveryCode, usernameValido } from './lib/auth.js';

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
const MAX_FOTO_BYTES = 600 * 1024;

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

function lerJson(texto, padrao) {
  try { const v = JSON.parse(texto); return v == null ? padrao : v; } catch { return padrao; }
}

async function regHist(db, request, username, acao, tipo = 'dados', empresaId = null) {
  const { ip, ua } = clienteInfo(request);
  await db.prepare('INSERT INTO historico (username, acao, tipo, ip, user_agent, empresa_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(username, acao, tipo, ip, ua, empresaId).run();
}

function dataLimiteRetencao() {
  return new Date(Date.now() - DIAS_RETENCAO_LIXEIRA * 24 * 60 * 60 * 1000).toISOString();
}

function base64ParaBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesParaBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function detectarTipoArquivo(b) {
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

async function apagarCertificadosDaLixeira(db, empresaId, limiteData) {
  try {
    await garantirTabelasCert(db);
    const filtroColab = empresaId
      ? 'colaborador_id IN (SELECT id FROM colaboradores WHERE empresa_id = ? AND deletado_em IS NOT NULL)'
      : 'colaborador_id IN (SELECT id FROM colaboradores WHERE deletado_em IS NOT NULL AND deletado_em < ?)';
    const arg = empresaId || limiteData;
    const alvo = `(${filtroColab})` + (limiteData && !empresaId ? ' OR (deletado_em IS NOT NULL AND deletado_em < ?)' : '');
    const binds = limiteData && !empresaId ? [arg, limiteData] : [arg];
    await db.prepare(`DELETE FROM certificado_partes WHERE certificado_id IN (SELECT id FROM certificados WHERE ${alvo})`).bind(...binds).run();
    await db.prepare(`DELETE FROM certificados WHERE ${alvo}`).bind(...binds).run();
    await garantirTabelaFotos(db);
    await db.prepare(`DELETE FROM colaborador_fotos WHERE ${filtroColab}`).bind(arg).run();
  } catch (err) {}
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

let certTabelasProntas = false;
async function garantirTabelasCert(db) {
  if (certTabelasProntas) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS certificados (
      id TEXT PRIMARY KEY, empresa_id INTEGER NOT NULL, colaborador_id TEXT NOT NULL, sigla TEXT NOT NULL,
      nome_arquivo TEXT NOT NULL, tipo TEXT NOT NULL, tamanho INTEGER NOT NULL,
      enviado_em TEXT NOT NULL DEFAULT (datetime('now')), deletado_em TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS certificado_partes (
      certificado_id TEXT NOT NULL, parte INTEGER NOT NULL, dados TEXT NOT NULL,
      PRIMARY KEY (certificado_id, parte))`),
  ]);
  certTabelasProntas = true;
}

let fotoTabelaPronta = false;
async function garantirTabelaFotos(db) {
  if (fotoTabelaPronta) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS colaborador_fotos (
    colaborador_id TEXT PRIMARY KEY, empresa_id INTEGER NOT NULL, tipo TEXT NOT NULL,
    tamanho INTEGER NOT NULL, dados TEXT NOT NULL, atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  fotoTabelaPronta = true;
}

async function handleFoto(request, env, url) {
  const session = await obterSessao(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  const db = env.DB;
  const resolvido = await resolverEmpresa(session, url, db);
  if (!resolvido.ok) return json({ error: resolvido.error }, 403);
  const empresaId = resolvido.empresaId;
  await garantirTabelaFotos(db);
  const colaboradorId = url.searchParams.get('colaborador_id') || '';
  if (!colaboradorId) return json({ error: 'colaborador_obrigatorio' }, 400);
  const ehLogo = colaboradorId.startsWith('logo:');
  let colab;
  if (ehLogo) {
    if (colaboradorId !== 'logo:' + empresaId) return json({ error: 'nao_encontrado' }, 404);
    if (request.method !== 'GET' && session.role !== 'admin') return json({ error: 'forbidden' }, 403);
    colab = [{ id: colaboradorId, nome: 'logo da empresa' }];
  } else {
    const r = await db.prepare('SELECT id, nome FROM colaboradores WHERE id = ? AND empresa_id = ? AND deletado_em IS NULL').bind(colaboradorId, empresaId).all();
    colab = r.results;
    if (colab.length === 0) return json({ error: 'colaborador_nao_encontrado' }, 404);
  }
  if (request.method === 'GET') {
    const { results } = await db.prepare('SELECT tipo, dados FROM colaborador_fotos WHERE colaborador_id = ? AND empresa_id = ?').bind(colaboradorId, empresaId).all();
    if (results.length === 0) return json({ error: 'nao_encontrado' }, 404);
    const corpo = base64ParaBytes(results[0].dados);
    return new Response(corpo, { headers: {
      'content-type': results[0].tipo, 'content-length': String(corpo.length),
      'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store',
    } });
  }
  if (request.method === 'POST') {
    const declarado = parseInt(request.headers.get('content-length') || '0', 10);
    if (declarado > MAX_FOTO_BYTES + 1024) return json({ error: 'arquivo_muito_grande', limite: MAX_FOTO_BYTES }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length === 0) return json({ error: 'arquivo_vazio' }, 400);
    if (bytes.length > MAX_FOTO_BYTES) return json({ error: 'arquivo_muito_grande', limite: MAX_FOTO_BYTES }, 413);
    const tipo = detectarTipoArquivo(bytes);
    if (!tipo || tipo === 'application/pdf') return json({ error: 'tipo_nao_permitido' }, 415);
    await db.prepare(`INSERT INTO colaborador_fotos (colaborador_id, empresa_id, tipo, tamanho, dados, atualizado_em) VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(colaborador_id) DO UPDATE SET tipo = excluded.tipo, tamanho = excluded.tamanho, dados = excluded.dados, atualizado_em = excluded.atualizado_em`)
      .bind(colaboradorId, empresaId, tipo, bytes.length, bytesParaBase64(bytes)).run();
    await regHist(db, request, session.username, ehLogo ? 'Atualizou o logo da empresa' : `Atualizou a foto de "${colab[0].nome}"`, 'dados', empresaId);
    const { results } = await db.prepare('SELECT colaborador_id, atualizado_em FROM colaborador_fotos WHERE colaborador_id = ?').bind(colaboradorId).all();
    return json({ ok: true, foto: results[0] });
  }
  if (request.method === 'DELETE') {
    const r = await db.prepare('DELETE FROM colaborador_fotos WHERE colaborador_id = ? AND empresa_id = ?').bind(colaboradorId, empresaId).run();
    if (r.meta && r.meta.changes) await regHist(db, request, session.username, ehLogo ? 'Removeu o logo da empresa' : `Removeu a foto de "${colab[0].nome}"`, 'dados', empresaId);
    return json({ ok: true });
  }
  return json({ error: 'metodo_nao_permitido' }, 405);
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
    if (!usernameValido(username)) return json({ error: 'usuario_invalido' }, 400);
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
  if (request.method === 'DELETE') {
    if (session.role !== 'admin') return json({ error: 'somente_admin' }, 403);
    const idRaw = url.searchParams.get('id');
    const id = idRaw ? parseInt(idRaw, 10) : NaN;
    if (!id || Number.isNaN(id)) return json({ error: 'id_obrigatorio' }, 400);
    const { results: empRows } = await db.prepare('SELECT id, nome FROM empresas WHERE id = ?').bind(id).all();
    if (empRows.length === 0) return json({ error: 'empresa_inexistente' }, 404);
    const nome = empRows[0].nome;
    const { results: countRows } = await db.prepare('SELECT COUNT(*) AS c FROM empresas').all();
    if (countRows[0].c <= 1) return json({ error: 'nao_pode_excluir_ultima_empresa' }, 400);
    const { results: userRows } = await db.prepare('SELECT COUNT(*) AS c FROM users WHERE empresa_id = ?').bind(id).all();
    if (userRows[0].c > 0) return json({ error: 'existem_usuarios_vinculados', count: userRows[0].c }, 409);
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
    const logEmpId = outras.length ? outras[0].id : null;
    await regHist(db, request, session.username, `Excluiu a empresa "${nome}" (id ${id}) e todos os dados vinculados`, 'seguranca', logEmpId);
    return json({ ok: true, id, nome });
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
  try { await db.prepare('ALTER TABLE colaboradores ADD COLUMN funcao TEXT').run(); } catch (_) {}
  const [colaboradoresRes, docTypesRes, configRes, historicoRes, empresaRes] = await Promise.all([
    db.prepare('SELECT id, nome, notas, docs, funcao FROM colaboradores WHERE empresa_id = ? AND deletado_em IS NULL ORDER BY ordem ASC, nome ASC').bind(empresaId).all(),
    db.prepare('SELECT sigla, nome, descricao, cor, ordem FROM doc_types WHERE empresa_id = ? ORDER BY ordem ASC').bind(empresaId).all(),
    db.prepare('SELECT chave, valor FROM config WHERE empresa_id = ?').bind(empresaId).all(),
    db.prepare('SELECT id, ts, username, acao, tipo, ip, user_agent FROM historico WHERE empresa_id = ? AND deletado_em IS NULL ORDER BY ts DESC LIMIT 500').bind(empresaId).all(),
    db.prepare('SELECT id, nome FROM empresas WHERE id = ?').bind(empresaId).all(),
  ]);
  const colaboradores = colaboradoresRes.results.map(c => ({ id: c.id, nome: c.nome, notas: lerJson(c.notas, []), docs: lerJson(c.docs, {}), funcao: c.funcao || '' }));
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
    const { results } = await db.prepare('SELECT id, colaborador_id, sigla, nome_arquivo, tipo, tamanho, enviado_em FROM certificados WHERE empresa_id = ? AND deletado_em IS NULL ORDER BY enviado_em ASC').bind(empresaId).all();
    certificados = results;
  } catch (err) {}
  let fotos = [];
  try {
    await garantirTabelaFotos(db);
    const { results } = await db.prepare('SELECT colaborador_id, atualizado_em FROM colaborador_fotos WHERE empresa_id = ?').bind(empresaId).all();
    fotos = results;
  } catch (err) {}
  return json({
    certificados, fotos,
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
  try { await db.prepare('ALTER TABLE colaboradores ADD COLUMN funcao TEXT').run(); } catch (_) {}
  if (request.method === 'GET') {
    await purgarLixeiraAntiga(db);
    const { results } = await db.prepare('SELECT id, nome, docs, deletado_em FROM colaboradores WHERE empresa_id = ? AND deletado_em IS NOT NULL ORDER BY deletado_em DESC').bind(empresaId).all();
    return json({ lixeira: results.map(c => ({ id: c.id, nome: c.nome, docs: lerJson(c.docs, {}), deletado_em: c.deletado_em })), diasRetencao: DIAS_RETENCAO_LIXEIRA });
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
    const funcao = String(body.funcao || '').trim().slice(0, 120);
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
      await db.prepare('INSERT INTO colaboradores (id, nome, notas, docs, ordem, empresa_id, funcao) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, nome, JSON.stringify(notas), JSON.stringify(docs), results[0].max + 1, empresaId, funcao).run();
    } else {
      const { results } = await db.prepare('SELECT id FROM colaboradores WHERE id = ? AND empresa_id = ?').bind(id, empresaId).all();
      if (results.length === 0) return json({ error: 'nao_encontrado' }, 404);
      await db.prepare("UPDATE colaboradores SET nome = ?, notas = ?, docs = ?, funcao = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(nome, JSON.stringify(notas), JSON.stringify(docs), funcao, id).run();
    }
    await regHist(db, request, session.username, (isNew ? 'Criou' : 'Editou') + ` colaborador "${nome}"`, 'dados', empresaId);
    return json({ ok: true, id });
  }
  if (request.method === 'DELETE') {
    if (url.searchParams.get('esvaziar') === 'tudo') {
      if (session.role !== 'admin') return json({ error: 'somente_admin' }, 403);
      const { results: countRes } = await db.prepare('SELECT COUNT(*) AS count FROM colaboradores WHERE empresa_id = ? AND deletado_em IS NOT NULL').bind(empresaId).all();
      await apagarCertificadosDaLixeira(db, empresaId, null);
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
    try {
      const url = new URL(request.url);
      const p = url.pathname;
      if (p === '/api/login') return await handleLogin(request, env);
      if (p === '/api/empresas') return await handleEmpresas(request, env, url);
      if (p === '/api/data') return await handleData(request, env, url);
      if (p === '/api/foto') return await handleFoto(request, env, url);
      if (p === '/api/colaborador') return await handleColaborador(request, env, url);
      if (p.startsWith('/api/')) return json({ error: 'not_found' }, 404);
      if (env.ASSETS) {
        const assetRes = await env.ASSETS.fetch(request);
        const path = url.pathname;
        if ((path === '/' || path === '/index.html') && assetRes.ok) {
          let html = await assetRes.text();
          if (!html.includes('carteirinha-patch.js')) {
            html = html.replace('</body>', '<script src="/carteirinha-patch.js"></script>\n</body>');
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
