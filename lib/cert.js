import { json } from './auth.js';

const MAX_CERT_BYTES = 4 * 1024 * 1024;
const CERT_PARTE_BYTES = 512 * 1024;
const MAX_CERT_POR_DOC = 10;
const LIMITE_ARMAZENAMENTO_CERT = 400 * 1024 * 1024;
let certTabelasProntas = false;

let _obterSessao = null;
let _resolverEmpresa = null;
let _regHist = null;

export function initCert({ obterSessao, resolverEmpresa, regHist }) {
  _obterSessao = obterSessao;
  _resolverEmpresa = resolverEmpresa;
  _regHist = regHist;
}

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
  let nome = String(bruto || '').replace(/[\u0000-\u001f\u007f\\/:\*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
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
  } catch (err) { /* best-effort */ }
}

async function handleCertificado(request, env, url) {
  const session = await _obterSessao(request, env);
  if (!session) return json({ error: 'unauthorized' }, 401);
  const db = env.DB;
  const resolvido = await _resolverEmpresa(session, url, db);
  if (!resolvido.ok) return json({ error: resolvido.error }, 403);
  const empresaId = resolvido.empresaId;
  await garantirTabelasCert(db);

  if (request.method === 'GET') {
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'id_obrigatorio' }, 400);
    const { results } = await db.prepare('SELECT id, nome_arquivo, tipo, tamanho FROM certificados WHERE id = ? AND empresa_id = ? AND deletado_em IS NULL').bind(id, empresaId).all();
    if (results.length === 0) return json({ error: 'nao_encontrado' }, 404);
    const { results: partes } = await db.prepare('SELECT parte, dados FROM certificado_partes WHERE certificado_id = ? ORDER BY parte ASC').bind(id).all();
    let b64 = '';
    for (const p of partes) b64 += p.dados;
    const bytes = base64ParaBytes(b64);
    return new Response(bytes, {
      headers: {
        'content-type': results[0].tipo,
        'content-disposition': `inline; filename="${results[0].nome_arquivo}"`,
        'cache-control': 'private, max-age=3600',
      },
    });
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
    const stmts = [db.prepare('INSERT INTO certificados (id, empresa_id, colaborador_id, sigla, nome_arquivo, tipo, tamanho) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, empresaId, colaboradorId, sigla, nomeArquivo, tipo, bytes.length)];
    const b64 = bytesParaBase64(bytes);
    for (let i = 0, p = 0; i < b64.length; i += CERT_PARTE_BYTES, p++) {
      stmts.push(db.prepare('INSERT INTO certificado_partes (certificado_id, parte, dados) VALUES (?, ?, ?)').bind(id, p, b64.slice(i, i + CERT_PARTE_BYTES)));
    }
    await db.batch(stmts);
    await _regHist(db, request, session.username, `Enviou certificado "${nomeArquivo}" (${sigla}) para colaborador`, 'dados', empresaId);
    return json({ ok: true, id, nome_arquivo: nomeArquivo, tipo, tamanho: bytes.length });
  }

  if (request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'id_obrigatorio' }, 400);
    const apagar = url.searchParams.get('restaurar') !== '1';
    const { results } = await db.prepare('SELECT id, nome_arquivo, sigla FROM certificados WHERE id = ? AND empresa_id = ?').bind(id, empresaId).all();
    if (results.length === 0) return json({ error: 'nao_encontrado' }, 404);
    await db.prepare('UPDATE certificados SET deletado_em = ? WHERE id = ?').bind(apagar ? new Date().toISOString() : null, id).run();
    await _regHist(db, request, session.username, `${apagar ? 'Excluiu' : 'Restaurou'} certificado "${results[0].nome_arquivo}" (${results[0].sigla})`, 'dados', empresaId);
    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

export { garantirTabelasCert, apagarCertificadosDaLixeira, handleCertificado };
