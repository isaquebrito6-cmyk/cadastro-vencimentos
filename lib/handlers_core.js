import { getSession, json } from './auth.js';

const SIGLA_VALIDA = /^[A-Z0-9][A-Z0-9 \-\/.+]{0,19}$/;
const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const HASH_FALSO = { salt: '00000000000000000000000000000000', hash: '0'.repeat(64) };
const PALETA = ['#f2b705', '#3fae5c', '#f2954a', '#e05a8a', '#8a6de0', '#4fa3e3', '#c94f4f', '#4fc9a8', '#c9a24f', '#7a8fd6'];
const BUILTIN_DOC_TYPES = [
  { sigla: 'ASO', nome: 'ASO', desc: '' },
  { sigla: 'NR-35', nome: 'Trabalho em Altura', desc: '' },
  { sigla: 'NR-33', nome: 'Espacos Confinados', desc: '' },
  { sigla: 'NR-33 SUP', nome: 'Espacos Confinados Supervisor', desc: '' },
  { sigla: 'LOTO', nome: 'LOTO', desc: '' },
  { sigla: 'NR-11/18', nome: 'Plataforma', desc: '' },
  { sigla: 'NR-20', nome: 'Inflamaveis', desc: '' },
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
  await db.prepare('INSERT INTO historico (username, acao, tipo, ip, user_agent, empresa_id) VALUES (?, ?, ?, ?, ?, ?)').bind(username, acao, tipo, ip, ua, empresaId).run();
}

function dataLimiteRetencao() {
  return new Date(Date.now() - DIAS_RETENCAO_LIXEIRA * 24 * 60 * 60 * 1000).toISOString();
}

function dataValida(v) {
  return typeof v === 'string' && DATA_ISO.test(v);
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
  return null;
}

async function garantirTabelasCert(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS certificados (
    id TEXT PRIMARY KEY, colaborador_id TEXT, sigla TEXT, nome_arquivo TEXT, tipo TEXT, tamanho INTEGER,
    empresa_id INTEGER, enviado_em TEXT NOT NULL DEFAULT (datetime('now')), deletado_em TEXT)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS certificado_partes (
    certificado_id TEXT, parte INTEGER, dados TEXT, PRIMARY KEY (certificado_id, parte))`).run();
}

async function garantirTabelaFotos(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS colaborador_fotos (
    colaborador_id TEXT PRIMARY KEY, empresa_id INTEGER, dados TEXT, atualizado_em TEXT)`).run();
}

async function apagarCertificadosDaLixeira(db, empresaId, limiteData) {
  try {
    await garantirTabelasCert(db);
    if (empresaId) {
      await db.prepare('DELETE FROM certificado_partes WHERE certificado_id IN (SELECT id FROM certificados WHERE empresa_id = ? AND deletado_em IS NOT NULL)').bind(empresaId).run();
      await db.prepare('DELETE FROM certificados WHERE empresa_id = ? AND deletado_em IS NOT NULL').bind(empresaId).run();
    }
  } catch (_) {}
}

async function purgarLixeiraAntiga(db) {
  const limite = dataLimiteRetencao();
  await apagarCertificadosDaLixeira(db, null, limite);
  await db.prepare('DELETE FROM colaboradores WHERE deletado_em IS NOT NULL AND deletado_em < ?').bind(limite).run();
  await db.prepare('DELETE FROM historico WHERE deletado_em IS NOT NULL AND deletado_em < ?').bind(limite).run();
}

async function resolverEmpresa(session, url, db) {
  let empresaId = session.empresaId;
  if (session.role === 'admin') {
    const q = url.searchParams.get('empresa_id');
    if (q) empresaId = parseInt(q, 10);
  }
  if (!empresaId) {
    const { results } = await db.prepare('SELECT id FROM empresas ORDER BY id ASC LIMIT 1').all();
    if (results.length) empresaId = results[0].id;
  }
  if (!empresaId) return { ok: false, error: 'empresa_nao_encontrada' };
  return { ok: true, empresaId };
}

async function handleFoto(request, env, url) {
  const session = await obterSessao(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  const db = env.DB;
  const resolvido = await resolverEmpresa(session, url, db);
  if (!resolvido.ok) return json({ error: resolvido.error }, 403);
  const empresaId = resolvido.empresaId;
  await garantirTabelaFotos(db);
  const colaboradorId = url.searchParams.get('colaborador_id');
  if (!colaboradorId) return json({ error: 'colaborador_id_obrigatorio' }, 400);

  if (request.method === 'GET') {
    const { results } = await db.prepare('SELECT dados, atualizado_em FROM colaborador_fotos WHERE colaborador_id = ? AND empresa_id = ?').bind(colaboradorId, empresaId).all();
    if (!results.length) return json({ error: 'nao_encontrado' }, 404);
    const bytes = base64ParaBytes(results[0].dados);
    return new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' } });
  }
  if (request.method === 'POST') {
    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.length > MAX_FOTO_BYTES) return json({ error: 'arquivo_muito_grande' }, 400);
    const tipo = detectarTipoArquivo(buf);
    if (!tipo || !tipo.startsWith('image/')) return json({ error: 'tipo_invalido' }, 400);
    const b64 = bytesParaBase64(buf);
    const agora = new Date().toISOString();
    await db.prepare('INSERT OR REPLACE INTO colaborador_fotos (colaborador_id, empresa_id, dados, atualizado_em) VALUES (?, ?, ?, ?)').bind(colaboradorId, empresaId, b64, agora).run();
    return json({ ok: true, foto: { atualizado_em: agora } });
  }
  if (request.method === 'DELETE') {
    await db.prepare('DELETE FROM colaborador_fotos WHERE colaborador_id = ? AND empresa_id = ?').bind(colaboradorId, empresaId).run();
    return json({ ok: true });
  }
  return json({ error: 'method_not_allowed' }, 405);
}

export {
  BLOQUEIO_MINUTOS, BUILTIN_DOC_TYPES, DATA_ISO, DIAS_RETENCAO_LIXEIRA, HASH_FALSO,
  MAX_FOTO_BYTES, MAX_TENTATIVAS, PALETA, SIGLA_VALIDA,
  apagarCertificadosDaLixeira, base64ParaBytes, bytesParaBase64, clienteInfo,
  dataLimiteRetencao, dataValida, detectarTipoArquivo, garantirTabelaFotos,
  garantirTabelasCert, handleFoto, lerJson, obterSessao, purgarLixeiraAntiga,
  regHist, resolverEmpresa
};
