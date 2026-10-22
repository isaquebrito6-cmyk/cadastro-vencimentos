import { getSession } from './auth.js';

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

function normalizarNome(nome) {
  return String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/\s+/).filter(p => p && !['de', 'da', 'do', 'dos', 'das', 'e'].includes(p)).join(' ').trim();
}

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
  const TAMANHO_LOTE_D1 = 80;
  for (let i = 0; i < stmts.length; i += TAMANHO_LOTE_D1) {
    await db.batch(stmts.slice(i, i + TAMANHO_LOTE_D1));
  }
}

function chaveSigla(x) {
  return String(x || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function identidadeNR(texto) {
  const u = chaveSigla(texto);
  const m = u.match(/\bNR\s*-?\s*(\d{1,2})\b/);
  if (m) {
    let id = 'NR-' + String(parseInt(m[1], 10));
    const resto = u.replace(/\bNR\s*-?\s*\d{1,2}\b/, '').replace(/[^A-Z0-9]+/g, ' ').trim();
    if (resto) id += '|' + resto;
    return id;
  }
  return chaveSigla(u);
}

const MAX_FOTO_BYTES = 600 * 1024;
let fotoTabelaPronta = false;
let certTabelasProntas = false;
const MAX_CERT_BYTES = 4 * 1024 * 1024;
const CERT_PARTE_BYTES = 384 * 1024;
const MAX_CERT_POR_DOC = 10;
const LIMITE_ARMAZENAMENTO_CERT = 400 * 1024 * 1024;

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
  ]);
  certTabelasProntas = true;
}

function detectarTipoArquivo(b) {
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'image/webp';
  return null;
}

function bytesParaBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
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
  } catch (err) { /* best-effort */ }
}

async function garantirTabelaFotos(db) {
  if (fotoTabelaPronta) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS colaborador_fotos (
    colaborador_id TEXT PRIMARY KEY, empresa_id INTEGER NOT NULL, tipo TEXT NOT NULL,
    tamanho INTEGER NOT NULL, dados TEXT NOT NULL, atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  fotoTabelaPronta = true;
}

export {
  SIGLA_VALIDA, DATA_ISO, HASH_FALSO, PALETA, BUILTIN_DOC_TYPES,
  MAX_TENTATIVAS, BLOQUEIO_MINUTOS, DIAS_RETENCAO_LIXEIRA,
  clienteInfo, obterSessao, lerJson, regHist, dataLimiteRetencao, purgarLixeiraAntiga, resolverEmpresa,
  normalizarNome, dataValida, limparNotas, limparDocs, executarEmLotes, chaveSigla, identidadeNR,
  MAX_FOTO_BYTES, MAX_CERT_BYTES, CERT_PARTE_BYTES, MAX_CERT_POR_DOC, LIMITE_ARMAZENAMENTO_CERT,
  garantirTabelasCert, detectarTipoArquivo, bytesParaBase64, base64ParaBytes, limparNomeArquivo,
  apagarCertificadosDaLixeira, garantirTabelaFotos,
};
