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

function clienteInfo(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'desconhecido';
  const ua = request.headers.get('User-Agent') || 'desconhecido';
  return { ip, ua };
}

// Valida o token E confere no banco se o usuário ainda existe, usando o papel/empresa ATUAIS.
// Assim, remover um usuário ou mudar o papel dele vale na hora, sem esperar o token (12h) expirar.
async function obterSessao(request, env) {
  if (!env.SESSION_SECRET) return null;
  const token = await getSession(request, env.SESSION_SECRET);
  if (!token || !token.username) return null;
  const { results } = await env.DB.prepare('SELECT username, role, empresa_id FROM users WHERE username = ?').bind(token.username).all();
  const u = results[0];
  if (!u) return null;
  return { username: u.username, role: u.role, empresaId: u.empresa_id };
}

// JSON.parse que nunca lança: se o texto salvo estiver quebrado, devolve o valor padrão em vez de derrubar a tela inteira.
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

async function purgarLixeiraAntiga(db) {
  const limite = dataLimiteRetencao();
  await apagarCertificadosDaLixeira(db, null, limite); // antes dos colaboradores, senão perde a ligação
  await db.prepare('DELETE FROM colaboradores WHERE deletado_em IS NOT NULL AND deletado_em < ?').bind(limite).run();
  await db.prepare('DELETE FROM historico WHERE deletado_em IS NOT NULL AND deletado_em < ?').bind(limite).run();
}

// Decide de qual empresa a requisição trata, e garante que a pessoa tem permissão pra ela.
// Admins (empresa_id nulo no token) podem escolher qualquer empresa via ?empresa_id=.
// Editores só podem acessar a própria empresa, fixada no login.
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

  // editor
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

  const { results } = await db.prepare('SELECT username, password_hash, password_salt, role, empresa_id, failed_attempts, locked_until FROM users WHERE username = ?')
    .bind(username).all();
  const user = results[0];

  if (user && user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    const minutosRestantes = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
    return json({ error: 'conta_bloqueada', minutos: minutosRestantes }, 423);
  }

  // Se o usuário não existe, faz o mesmo trabalho de hash mesmo assim, pra não dar pra descobrir
  // quais nomes de usuário existem medindo o tempo de resposta.
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

  const colaboradores = colaboradoresRes.results.map(c => ({ id: c.id, nome: c.nome, notas: lerJson(c.notas, []), docs: lerJson(c.docs, {}) }));
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
  } catch (err) { /* a lista de certificados nunca pode impedir o app de abrir */ }

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
    // Só aceita datas válidas (AAAA-MM-DD) e só de tipos de documento que existem nesta empresa.
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

const LIMITE_IMPORTACAO = 2000;
const TAMANHO_LOTE_D1 = 80;

function normalizarNome(nome) {
  return String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Data AAAA-MM-DD que realmente existe no calendário (recusa 2026-02-30, por exemplo).
function dataValida(v) {
  if (typeof v !== 'string' || !DATA_ISO.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (y < 1900 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function limparNotas(notas) {
  const lista = Array.isArray(notas) ? notas : (typeof notas === 'string' && notas.trim() ? notas.split(',') : []);
  return lista.map(n => String(n).replace(/\s+/g, ' ').trim().slice(0, 500)).filter(Boolean).slice(0, 50);
}

// Devolve { docs } com só as datas válidas de tipos que existem, ou { erro } se alguma data for inválida.
// Valor vazio vira null (= "não informado"; nunca apaga uma data que já exista).
function limparDocs(docsBrutos, siglasValidas) {
  const docs = {};
  if (docsBrutos && typeof docsBrutos === 'object') {
    for (const [siglaRaw, valor] of Object.entries(docsBrutos)) {
      const sigla = String(siglaRaw || '').trim().toUpperCase().replace(/\s+/g, ' ');
      if (!sigla || !siglasValidas.has(sigla)) continue;
      if (valor === null || valor === undefined || valor === '') { docs[sigla] = null; continue; }
      if (!dataValida(valor)) return { erro: `data inválida em ${sigla}` };
      docs[sigla] = valor;
    }
  }
  return { docs };
}

async function executarEmLotes(db, stmts) {
  for (let i = 0; i < stmts.length; i += TAMANHO_LOTE_D1) {
    await db.batch(stmts.slice(i, i + TAMANHO_LOTE_D1));
  }
}

// Importação em lote.
//  { registros:[{nome, notas?, docs?:{SIGLA:'AAAA-MM-DD'}}], modo:'ignorar'|'atualizar' }  (ou o formato antigo { nomes:[...] })
//  { desfazer:{ criados:[ids], atualizados:[{id, notas, docs}] } }  desfaz uma importação feita há pouco
async function handleColaboradorLote(request, env, url) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const session = await obterSessao(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  const db = env.DB;
  const resolvido = await resolverEmpresa(session, url, db);
  if (!resolvido.ok) return json({ error: resolvido.error }, 403);
  const empresaId = resolvido.empresaId;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }

  const { results: tipos } = await db.prepare('SELECT sigla, nome FROM doc_types WHERE empresa_id = ?').bind(empresaId).all();
  const siglasValidas = new Set(tipos.map(t => t.sigla));
  // Chave canônica: "NR35", "NR-35" e "NR 35" são o mesmo tipo (evita duplicar NR na importação).
  const chaveSigla = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const porChave = new Map();
  for (const t of tipos) { const k = chaveSigla(t.sigla); if (k && !porChave.has(k)) porChave.set(k, t.sigla); }
  for (const t of tipos) { const k = chaveSigla(t.nome); if (k && !porChave.has(k)) porChave.set(k, t.sigla); }

  if (body.desfazer && typeof body.desfazer === 'object') {
    const criados = Array.isArray(body.desfazer.criados) ? body.desfazer.criados.map(String).slice(0, LIMITE_IMPORTACAO) : [];
    const atualizados = Array.isArray(body.desfazer.atualizados) ? body.desfazer.atualizados.slice(0, LIMITE_IMPORTACAO) : [];
    const agora = new Date().toISOString();
    const stmts = [];
    for (const id of criados) {
      stmts.push(db.prepare('UPDATE colaboradores SET deletado_em = ? WHERE id = ? AND empresa_id = ? AND deletado_em IS NULL').bind(agora, id, empresaId));
    }
    let restaurados = 0;
    for (const item of atualizados) {
      if (!item || typeof item.id !== 'string') continue;
      const lim = limparDocs(item.docs, siglasValidas);
      if (lim.erro) continue;
      stmts.push(db.prepare("UPDATE colaboradores SET notas = ?, docs = ?, updated_at = datetime('now') WHERE id = ? AND empresa_id = ? AND deletado_em IS NULL")
        .bind(JSON.stringify(limparNotas(item.notas)), JSON.stringify(lim.docs), item.id, empresaId));
      restaurados++;
    }
    await executarEmLotes(db, stmts);
    await regHist(db, request, session.username, `Desfez a última importação (${criados.length} cadastro(s) enviados à lixeira, ${restaurados} restaurado(s) ao estado anterior)`, 'dados', empresaId);
    return json({ ok: true, removidos: criados.length, restaurados });
  }

  let registros;
  if (Array.isArray(body.registros)) registros = body.registros;
  else if (Array.isArray(body.nomes)) registros = body.nomes.map(nome => ({ nome }));
  else return json({ error: 'registros_obrigatorios' }, 400);
  if (registros.length > LIMITE_IMPORTACAO) return json({ error: 'limite_de_registros', limite: LIMITE_IMPORTACAO }, 400);
  const atualizar = body.modo === 'atualizar';

  // Na importação: se a planilha trouxer colunas de NR/treinamento que ainda não existem, cria o tipo automaticamente
  const siglasNovas = [];
  for (const r of registros) {
    if (!r || !r.docs || typeof r.docs !== 'object') continue;
    const novoDocs = {};
    for (const [siglaRaw, valor] of Object.entries(r.docs)) {
      let sigla = String(siglaRaw || '').trim().toUpperCase().replace(/\s+/g, ' ');
      if (!sigla) continue;
      if (!siglasValidas.has(sigla)) {
        const k = chaveSigla(sigla);
        if (porChave.has(k)) sigla = porChave.get(k);          // já existe com outra grafia: reaproveita
        else if (SIGLA_VALIDA.test(sigla)) {                    // realmente nova: cria uma única vez
          siglasNovas.push(sigla);
          porChave.set(k, sigla);
          siglasValidas.add(sigla);
        }
      }
      novoDocs[sigla] = valor;
    }
    r.docs = novoDocs;
  }
  if (siglasNovas.length > 0) {
    const { results: maxRes } = await db.prepare('SELECT COALESCE(MAX(ordem), 0) AS max FROM doc_types WHERE empresa_id = ?').bind(empresaId).all();
    const { results: countRes } = await db.prepare('SELECT COUNT(*) AS count FROM doc_types WHERE empresa_id = ?').bind(empresaId).all();
    let ordem = maxRes[0].max;
    let count = countRes[0].count;
    const builtinMap = Object.fromEntries(BUILTIN_DOC_TYPES.map(d => [d.sigla, d]));
    const stmtsTipos = [];
    for (const sigla of siglasNovas) {
      ordem += 1;
      const meta = builtinMap[sigla];
      const nome = meta ? meta.nome : sigla;
      const desc = meta ? meta.desc : ('Treinamento / documento ' + sigla);
      const cor = PALETA[count % PALETA.length];
      count += 1;
      stmtsTipos.push(
        db.prepare('INSERT INTO doc_types (sigla, nome, descricao, cor, ordem, empresa_id) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(sigla, nome, desc, cor, ordem, empresaId)
      );
    }
    await db.batch(stmtsTipos);
    await regHist(db, request, session.username, `Criou automaticamente ${siglasNovas.length} tipo(s) de documento na importação: ${siglasNovas.join(', ')}`, 'dados', empresaId);
  }

  const { results: existentes } = await db.prepare('SELECT id, nome, notas, docs FROM colaboradores WHERE empresa_id = ? AND deletado_em IS NULL').bind(empresaId).all();
  const mapa = new Map();
  for (const e of existentes) {
    let notas = [], docs = {};
    try { notas = JSON.parse(e.notas) || []; } catch { /* mantém vazio */ }
    try { docs = JSON.parse(e.docs) || {}; } catch { /* mantém vazio */ }
    mapa.set(normalizarNome(e.nome), { id: e.id, nome: e.nome, notas, docs, existente: true, anterior: null });
  }

  const novos = [];
  const alterados = new Map();
  const erros = [];
  let ignorados = 0, semMudanca = 0;

  registros.forEach((r, i) => {
    const nome = String((r && r.nome) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!nome) return;
    const lim = limparDocs(r.docs, siglasValidas);
    if (lim.erro) { erros.push({ nome, motivo: lim.erro }); return; }
    const notas = limparNotas(r.notas);
    const chave = normalizarNome(nome);
    const atual = mapa.get(chave);

    if (!atual) {
      const reg = { id: null, nome, notas, docs: lim.docs, existente: false };
      mapa.set(chave, reg);
      novos.push(reg);
      return;
    }
    if (!atualizar) { ignorados++; return; }

    const antesDocs = JSON.stringify(atual.docs), antesNotas = JSON.stringify(atual.notas);
    const docsNovos = { ...atual.docs };
    for (const [sigla, valor] of Object.entries(lim.docs)) if (valor !== null) docsNovos[sigla] = valor;
    const notasNovas = notas.length ? notas : atual.notas;
    if (JSON.stringify(docsNovos) === antesDocs && JSON.stringify(notasNovas) === antesNotas) { semMudanca++; return; }
    if (atual.existente && !atual.anterior) atual.anterior = { notas: atual.notas, docs: atual.docs };
    atual.docs = docsNovos;
    atual.notas = notasNovas;
    if (atual.existente) alterados.set(atual.id, atual);
  });

  const stmts = [];
  if (novos.length > 0) {
    const { results } = await db.prepare('SELECT COALESCE(MAX(ordem), 0) AS max FROM colaboradores WHERE empresa_id = ?').bind(empresaId).all();
    let ordem = results[0].max;
    novos.forEach((n, i) => {
      ordem += 1;
      n.id = 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8) + i.toString(36);
      stmts.push(db.prepare('INSERT INTO colaboradores (id, nome, notas, docs, ordem, empresa_id) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(n.id, n.nome, JSON.stringify(n.notas), JSON.stringify(n.docs), ordem, empresaId));
    });
  }
  for (const a of alterados.values()) {
    stmts.push(db.prepare("UPDATE colaboradores SET notas = ?, docs = ?, updated_at = datetime('now') WHERE id = ? AND empresa_id = ?")
      .bind(JSON.stringify(a.notas), JSON.stringify(a.docs), a.id, empresaId));
  }
  await executarEmLotes(db, stmts);

  const criados = novos.length, atualizados = alterados.size;
  if (criados > 0 || atualizados > 0) {
    const partes = [`${criados} novo(s)`];
    if (atualizar) partes.push(`${atualizados} atualizado(s)`);
    if (ignorados) partes.push(`${ignorados} já existente(s) pulado(s)`);
    if (semMudanca) partes.push(`${semMudanca} sem mudança`);
    if (erros.length) partes.push(`${erros.length} com erro`);
    await regHist(db, request, session.username, `Importou lista de colaboradores: ${partes.join(', ')}`, 'dados', empresaId);
  }
  return json({
    ok: true, criados, atualizados, ignorados, semMudanca, erros,
    tiposCriados: siglasNovas,
    desfazer: {
      criados: novos.map(n => n.id),
      atualizados: [...alterados.values()].map(a => ({ id: a.id, notas: a.anterior.notas, docs: a.anterior.docs })),
    },
  });
}

// ---------- Certificados anexados (PDF ou foto) ----------
// Os arquivos ficam no próprio banco D1, em partes de 512 KB (o D1 não aceita linha acima de 2 MB).
// As tabelas são criadas sozinhas no primeiro uso, então não há migração manual a fazer.
const MAX_CERT_BYTES = 4 * 1024 * 1024;
const CERT_PARTE_BYTES = 384 * 1024; // múltiplo de 3: cada parte vira base64 sem sobra e pode ser lida sozinha
const MAX_CERT_POR_DOC = 10;
const LIMITE_ARMAZENAMENTO_CERT = 400 * 1024 * 1024; // o plano gratuito do D1 aceita 500 MB por banco
let certTabelasProntas = false;

async function garantirTabelasCert(db) {
  if (certTabelasProntas) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS certificados (
      id TEXT PRIMARY KEY, empresa_id INTEGER NOT NULL, colaborador_id TEXT NOT NULL, sigla TEXT NOT NULL,
      nome_arquivo TEXT NOT NULL, tipo TEXT NOT NULL, tamanho INTEGER NOT NULL,
      enviado_em TEXT NOT NULL DEFAULT (datetime('now')), deletado_em TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS certificado_partes (
      certificado_id TEXT NOT NULL, parte INTEGER NOT NULL, dados TEXT NOT NULL,
      PRIMARY KEY (certificado_id, parte)
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_cert_empresa ON certificados (empresa_id)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_cert_colab ON certificados (empresa_id, colaborador_id)'),
  ]);
  certTabelasProntas = true;
}

// Confere o conteúdo real do arquivo (não confia no nome nem no tipo informado pelo navegador).
function detectarTipoArquivo(b) {
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

function bytesParaBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ParaBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function limparNomeArquivo(bruto, tipo) {
  let nome = String(bruto || '').replace(/[\u0000-\u001f\u007f\\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!nome) nome = 'certificado' + ({ 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[tipo] || '');
  return nome;
}

// Apaga de vez os certificados cujos colaboradores já estão sendo apagados da lixeira.
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
  } catch (err) { /* limpeza é best-effort: nunca derruba a operação principal */ }
}

async function handleCertificado(request, env, url) {
  const session = await obterSessao(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  const db = env.DB;
  const resolvido = await resolverEmpresa(session, url, db);
  if (!resolvido.ok) return json({ error: resolvido.error }, 403);
  const empresaId = resolvido.empresaId;
  await garantirTabelasCert(db);

  if (request.method === 'GET') {
    const id = url.searchParams.get('id');
    if (!id) {
      const { results } = await db.prepare('SELECT id, colaborador_id, sigla, nome_arquivo, tipo, tamanho, enviado_em FROM certificados WHERE empresa_id = ? AND deletado_em IS NULL ORDER BY enviado_em ASC').bind(empresaId).all();
      return json({ certificados: results });
    }
    const { results } = await db.prepare('SELECT nome_arquivo, tipo, tamanho FROM certificados WHERE id = ? AND empresa_id = ? AND deletado_em IS NULL').bind(id, empresaId).all();
    if (results.length === 0) return json({ error: 'nao_encontrado' }, 404);
    const meta = results[0];
    const { results: partes } = await db.prepare('SELECT dados FROM certificado_partes WHERE certificado_id = ? ORDER BY parte ASC').bind(id).all();
    const corpo = new Uint8Array(meta.tamanho);
    let pos = 0;
    for (const p of partes) { const b = base64ParaBytes(p.dados); corpo.set(b, pos); pos += b.length; }
    if (pos !== meta.tamanho) return json({ error: 'arquivo_corrompido' }, 500);
    const disposicao = url.searchParams.get('baixar') === '1' ? 'attachment' : 'inline';
    return new Response(corpo, { headers: {
      'content-type': meta.tipo,
      'content-length': String(corpo.length),
      'content-disposition': `${disposicao}; filename="certificado"; filename*=UTF-8''${encodeURIComponent(meta.nome_arquivo)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    } });
  }

  if (request.method === 'POST') {
    const colaboradorId = url.searchParams.get('colaborador_id') || '';
    const sigla = url.searchParams.get('sigla') || '';
    const { results: colab } = await db.prepare('SELECT id, nome FROM colaboradores WHERE id = ? AND empresa_id = ? AND deletado_em IS NULL').bind(colaboradorId, empresaId).all();
    if (colab.length === 0) return json({ error: 'colaborador_nao_encontrado' }, 404);
    const { results: tipoDoc } = await db.prepare('SELECT sigla FROM doc_types WHERE sigla = ? AND empresa_id = ?').bind(sigla, empresaId).all();
    if (tipoDoc.length === 0) return json({ error: 'documento_invalido' }, 400);

    const declarado = parseInt(request.headers.get('content-length') || '0', 10);
    if (declarado > MAX_CERT_BYTES + 1024) return json({ error: 'arquivo_muito_grande', limite: MAX_CERT_BYTES }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length === 0) return json({ error: 'arquivo_vazio' }, 400);
    if (bytes.length > MAX_CERT_BYTES) return json({ error: 'arquivo_muito_grande', limite: MAX_CERT_BYTES }, 413);
    const tipo = detectarTipoArquivo(bytes);
    if (!tipo) return json({ error: 'tipo_nao_permitido' }, 415);

    const { results: cont } = await db.prepare('SELECT COUNT(*) AS n FROM certificados WHERE empresa_id = ? AND colaborador_id = ? AND sigla = ? AND deletado_em IS NULL').bind(empresaId, colaboradorId, sigla).all();
    if (cont[0].n >= MAX_CERT_POR_DOC) return json({ error: 'limite_de_certificados_no_documento', limite: MAX_CERT_POR_DOC }, 409);
    const { results: uso } = await db.prepare('SELECT COALESCE(SUM(tamanho), 0) AS total FROM certificados').all();
    if (uso[0].total + bytes.length > LIMITE_ARMAZENAMENTO_CERT) return json({ error: 'armazenamento_cheio' }, 409);

    const id = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const nomeArquivo = limparNomeArquivo(url.searchParams.get('nome'), tipo);
    const stmts = [db.prepare('INSERT INTO certificados (id, empresa_id, colaborador_id, sigla, nome_arquivo, tipo, tamanho) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, empresaId, colaboradorId, sigla, nomeArquivo, tipo, bytes.length)];
    for (let n = 0, ini = 0; ini < bytes.length; n++, ini += CERT_PARTE_BYTES) {
      stmts.push(db.prepare('INSERT INTO certificado_partes (certificado_id, parte, dados) VALUES (?, ?, ?)')
        .bind(id, n, bytesParaBase64(bytes.subarray(ini, ini + CERT_PARTE_BYTES))));
    }
    await db.batch(stmts); // tudo ou nada: nunca fica arquivo pela metade
    await regHist(db, request, session.username, `Anexou certificado "${nomeArquivo}" (${sigla}) a "${colab[0].nome}"`, 'dados', empresaId);
    const { results: nova } = await db.prepare('SELECT id, colaborador_id, sigla, nome_arquivo, tipo, tamanho, enviado_em FROM certificados WHERE id = ?').bind(id).all();
    return json({ ok: true, certificado: nova[0] });
  }

  if (request.method === 'DELETE' || request.method === 'PUT') {
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'id_obrigatorio' }, 400);
    const apagar = request.method === 'DELETE';
    const { results } = await db.prepare(`SELECT nome_arquivo, sigla FROM certificados WHERE id = ? AND empresa_id = ? AND deletado_em IS ${apagar ? '' : 'NOT '}NULL`).bind(id, empresaId).all();
    if (results.length === 0) return json({ error: 'nao_encontrado' }, 404);
    await db.prepare('UPDATE certificados SET deletado_em = ? WHERE id = ?').bind(apagar ? new Date().toISOString() : null, id).run();
    await regHist(db, request, session.username, `${apagar ? 'Excluiu' : 'Restaurou'} certificado "${results[0].nome_arquivo}" (${results[0].sigla})`, 'dados', empresaId);
    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

async function handleDoctype(request, env, url) {
  const session = await obterSessao(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  const db = env.DB;
  const resolvido = await resolverEmpresa(session, url, db);
  if (!resolvido.ok) return json({ error: resolvido.error }, 403);
  const empresaId = resolvido.empresaId;

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
    const sigla = String(body.sigla || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const nome = String(body.nome || '').trim();
    if (!sigla) return json({ error: 'sigla_obrigatoria' }, 400);
    if (!SIGLA_VALIDA.test(sigla)) return json({ error: 'sigla_invalida' }, 400);
    if (!nome) return json({ error: 'nome_obrigatorio' }, 400);
    if (nome.length > 200) return json({ error: 'nome_muito_longo' }, 400);
    const { results: existing } = await db.prepare('SELECT sigla FROM doc_types WHERE sigla = ? AND empresa_id = ?').bind(sigla, empresaId).all();
    if (existing.length > 0) return json({ error: 'ja_existe' }, 409);
    const { results: maxRes } = await db.prepare('SELECT COALESCE(MAX(ordem), 0) AS max FROM doc_types WHERE empresa_id = ?').bind(empresaId).all();
    const { results: countRes } = await db.prepare('SELECT COUNT(*) AS count FROM doc_types WHERE empresa_id = ?').bind(empresaId).all();
    const cor = PALETA[countRes[0].count % PALETA.length];
    await db.prepare('INSERT INTO doc_types (sigla, nome, descricao, cor, ordem, empresa_id) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(sigla, nome, nome, cor, maxRes[0].max + 1, empresaId).run();
    await regHist(db, request, session.username, `Incluiu tipo de documento "${sigla}" (${nome})`, 'dados', empresaId);
    return json({ ok: true, sigla, cor });
  }

  if (request.method === 'DELETE') {
    const sigla = url.searchParams.get('sigla');
    if (!sigla) return json({ error: 'sigla_obrigatoria' }, 400);
    const { results } = await db.prepare('SELECT sigla FROM doc_types WHERE sigla = ? AND empresa_id = ?').bind(sigla, empresaId).all();
    if (results.length === 0) return json({ error: 'nao_encontrado' }, 404);
    await db.prepare('DELETE FROM doc_types WHERE sigla = ? AND empresa_id = ?').bind(sigla, empresaId).run();
    try {
      await garantirTabelasCert(db);
      await db.prepare('UPDATE certificados SET deletado_em = ? WHERE empresa_id = ? AND sigla = ? AND deletado_em IS NULL').bind(new Date().toISOString(), empresaId, sigla).run();
    } catch (err) { /* sem certificados ainda */ }
    const { results: colaboradores } = await db.prepare('SELECT id, docs FROM colaboradores WHERE empresa_id = ?').bind(empresaId).all();
    const stmts = colaboradores.map(c => {
      const docs = lerJson(c.docs, {});
      delete docs[sigla];
      return db.prepare('UPDATE colaboradores SET docs = ? WHERE id = ?').bind(JSON.stringify(docs), c.id);
    });
    if (stmts.length > 0) await db.batch(stmts);
    await regHist(db, request, session.username, `Excluiu tipo de documento "${sigla}"`, 'dados', empresaId);
    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

async function handleConfig(request, env, url) {
  const session = await obterSessao(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const db = env.DB;
  const resolvido = await resolverEmpresa(session, url, db);
  if (!resolvido.ok) return json({ error: resolvido.error }, 403);
  const empresaId = resolvido.empresaId;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const chave = String(body.chave || '').trim();
  const valor = String(body.valor ?? '');
  if (!chave) return json({ error: 'chave_obrigatoria' }, 400);
  await db.prepare('INSERT INTO config (empresa_id, chave, valor) VALUES (?, ?, ?) ON CONFLICT (empresa_id, chave) DO UPDATE SET valor = excluded.valor')
    .bind(empresaId, chave, valor).run();
  await regHist(db, request, session.username, `Alterou configuração "${chave}" para "${valor}"`, 'dados', empresaId);
  return json({ ok: true });
}

async function handleUsers(request, env, url) {
  const session = await obterSessao(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  if (session.role !== 'admin') return json({ error: 'somente_admin' }, 403);
  const db = env.DB;

  if (request.method === 'GET') {
    const { results } = await db.prepare(`
      SELECT u.username, u.role, u.empresa_id, u.created_at, e.nome AS empresa_nome
      FROM users u LEFT JOIN empresas e ON e.id = u.empresa_id
      ORDER BY u.created_at ASC
    `).all();
    return json({ users: results });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const role = body.role === 'admin' ? 'admin' : 'editor';
    const empresaId = role === 'editor' ? parseInt(body.empresaId, 10) || null : null;
    if (!usernameValido(username) || password.length < 8) return json({ error: 'dados_invalidos' }, 400);
    if (role === 'editor' && !empresaId) return json({ error: 'empresa_obrigatoria_para_editor' }, 400);
    if (role === 'editor') {
      const { results: emp } = await db.prepare('SELECT id FROM empresas WHERE id = ?').bind(empresaId).all();
      if (emp.length === 0) return json({ error: 'empresa_inexistente' }, 400);
    }
    const { results: existing } = await db.prepare('SELECT username FROM users WHERE username = ?').bind(username).all();
    if (existing.length > 0) return json({ error: 'ja_existe' }, 409);
    const { hash, salt } = await hashPassword(password);
    const recoveryCode = generateRecoveryCode();
    const { hash: recoveryHash, salt: recoverySalt } = await hashPassword(recoveryCode);
    await db.prepare('INSERT INTO users (username, password_hash, password_salt, role, recovery_hash, recovery_salt, empresa_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(username, hash, salt, role, recoveryHash, recoverySalt, empresaId).run();
    await regHist(db, request, session.username, `Adicionou o usuário "${username}" (${role})`, 'seguranca', empresaId);
    return json({ ok: true, recoveryCode });
  }

  if (request.method === 'DELETE') {
    const username = url.searchParams.get('username');
    if (!username) return json({ error: 'username_obrigatorio' }, 400);
    if (username === session.username) return json({ error: 'nao_pode_excluir_a_si_mesmo' }, 400);
    const { results: adminCountRes } = await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").all();
    const { results: targetRes } = await db.prepare('SELECT role FROM users WHERE username = ?').bind(username).all();
    if (targetRes.length === 0) return json({ error: 'nao_encontrado' }, 404);
    if (targetRes[0].role === 'admin' && adminCountRes[0].count <= 1) return json({ error: 'nao_pode_remover_ultimo_admin' }, 400);
    await db.prepare('DELETE FROM users WHERE username = ?').bind(username).run();
    await regHist(db, request, session.username, `Removeu o usuário "${username}"`, 'seguranca');
    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

async function handleResetPassword(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const username = String(body.username || '').trim();
  const recoveryCode = String(body.recoveryCode || '').trim().toUpperCase();
  const newPassword = String(body.newPassword || '');
  if (!username || !recoveryCode || !newPassword) return json({ error: 'missing_fields' }, 400);
  if (newPassword.length < 8) return json({ error: 'password_too_short' }, 400);

  const db = env.DB;
  const { results } = await db.prepare('SELECT recovery_hash, recovery_salt, empresa_id FROM users WHERE username = ?').bind(username).all();
  const user = results[0];
  if (!user || !user.recovery_hash || !(await verifyPassword(recoveryCode, user.recovery_salt, user.recovery_hash))) {
    await regHist(db, request, username, 'Tentativa de redefinir senha com código de recuperação inválido', 'seguranca');
    return json({ error: 'codigo_invalido' }, 401);
  }

  const { hash, salt } = await hashPassword(newPassword);
  const novoCodigo = generateRecoveryCode();
  const { hash: recoveryHash, salt: recoverySalt } = await hashPassword(novoCodigo);
  await db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, recovery_hash = ?, recovery_salt = ?, failed_attempts = 0, locked_until = NULL WHERE username = ?')
    .bind(hash, salt, recoveryHash, recoverySalt, username).run();
  await regHist(db, request, username, 'Redefiniu a própria senha usando o código de recuperação', 'seguranca', user.empresa_id);

  return json({ ok: true, newRecoveryCode: novoCodigo });
}

async function handleAdminResetPassword(request, env) {
  const session = await obterSessao(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  if (session.role !== 'admin') return json({ error: 'somente_admin' }, 403);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const username = String(body.username || '').trim();
  const newPassword = String(body.newPassword || '');
  if (!username || newPassword.length < 8) return json({ error: 'dados_invalidos' }, 400);

  const db = env.DB;
  const { results } = await db.prepare('SELECT username FROM users WHERE username = ?').bind(username).all();
  if (results.length === 0) return json({ error: 'nao_encontrado' }, 404);

  const { hash, salt } = await hashPassword(newPassword);
  await db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, failed_attempts = 0, locked_until = NULL WHERE username = ?').bind(hash, salt, username).run();
  await regHist(db, request, session.username, `Redefiniu a senha do usuário "${username}"`, 'seguranca');

  return json({ ok: true });
}

async function handleHistorico(request, env, url) {
  const session = await obterSessao(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  if (session.role !== 'admin') return json({ error: 'somente_admin' }, 403);
  const db = env.DB;
  const resolvido = await resolverEmpresa(session, url, db);
  if (!resolvido.ok) return json({ error: resolvido.error }, 403);
  const empresaId = resolvido.empresaId;

  if (request.method === 'GET') {
    await purgarLixeiraAntiga(db);
    const { results } = await db.prepare('SELECT id, ts, username, acao, tipo, ip, deletado_em FROM historico WHERE empresa_id = ? AND deletado_em IS NOT NULL ORDER BY deletado_em DESC LIMIT 300').bind(empresaId).all();
    return json({ lixeira: results, diasRetencao: DIAS_RETENCAO_LIXEIRA });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
    const id = parseInt(body.id, 10);
    if (!id) return json({ error: 'id_obrigatorio' }, 400);
    const { results } = await db.prepare('SELECT id FROM historico WHERE id = ? AND empresa_id = ? AND deletado_em IS NOT NULL').bind(id, empresaId).all();
    if (results.length === 0) return json({ error: 'nao_encontrado' }, 404);
    await db.prepare('UPDATE historico SET deletado_em = NULL WHERE id = ?').bind(id).run();
    await regHist(db, request, session.username, `Restaurou um registro do histórico (#${id})`, 'seguranca', empresaId);
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    const idParam = url.searchParams.get('id');
    const limpar = url.searchParams.get('limpar');
    const esvaziar = url.searchParams.get('esvaziar');
    const agora = new Date().toISOString();

    if (esvaziar === 'tudo') {
      const { results: countRes } = await db.prepare('SELECT COUNT(*) AS count FROM historico WHERE empresa_id = ? AND deletado_em IS NOT NULL').bind(empresaId).all();
      await db.prepare('DELETE FROM historico WHERE empresa_id = ? AND deletado_em IS NOT NULL').bind(empresaId).run();
      await regHist(db, request, session.username, `Esvaziou a lixeira do histórico (${countRes[0].count} registros apagados definitivamente)`, 'seguranca', empresaId);
      return json({ ok: true });
    }

    if (limpar === 'tudo') {
      const { results: countRes } = await db.prepare('SELECT COUNT(*) AS count FROM historico WHERE empresa_id = ? AND deletado_em IS NULL').bind(empresaId).all();
      await db.prepare('UPDATE historico SET deletado_em = ? WHERE empresa_id = ? AND deletado_em IS NULL').bind(agora, empresaId).run();
      await regHist(db, request, session.username, `Moveu todo o histórico para a lixeira (${countRes[0].count} registros)`, 'seguranca', empresaId);
      return json({ ok: true });
    }

    if (!idParam) return json({ error: 'id_obrigatorio' }, 400);
    const id = parseInt(idParam, 10);
    const { results } = await db.prepare('SELECT id FROM historico WHERE id = ? AND empresa_id = ? AND deletado_em IS NULL').bind(id, empresaId).all();
    if (results.length === 0) return json({ error: 'nao_encontrado' }, 404);
    await db.prepare('UPDATE historico SET deletado_em = ? WHERE id = ?').bind(agora, id).run();
    await regHist(db, request, session.username, `Moveu um registro do histórico para a lixeira (#${id})`, 'seguranca', empresaId);
    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === '/api/login') return await handleLogin(request, env);
      if (p === '/api/reset-password') return await handleResetPassword(request, env);
      if (p === '/api/admin-reset-password') return await handleAdminResetPassword(request, env);
      if (p === '/api/empresas') return await handleEmpresas(request, env, url);
      if (p === '/api/data') return await handleData(request, env, url);
      if (p === '/api/historico') return await handleHistorico(request, env, url);
      if (p === '/api/colaborador') return await handleColaborador(request, env, url);
      if (p === '/api/colaborador-lote') return await handleColaboradorLote(request, env, url);
      if (p === '/api/certificado') return await handleCertificado(request, env, url);
      if (p === '/api/doctype') return await handleDoctype(request, env, url);
      if (p === '/api/config') return await handleConfig(request, env, url);
      if (p === '/api/users') return await handleUsers(request, env, url);
    } catch (err) {
      console.error(err);
      return json({ error: 'erro_interno' }, 500);
    }
    // Qualquer outra rota (index.html, manifest.json, ícones, sw.js) vem dos arquivos estáticos.
    const resp = await env.ASSETS.fetch(request);
    const seguro = new Response(resp.body, resp);
    seguro.headers.set('X-Content-Type-Options', 'nosniff');
    seguro.headers.set('X-Frame-Options', 'DENY');
    seguro.headers.set('Referrer-Policy', 'same-origin');
    return seguro;
  },
};
