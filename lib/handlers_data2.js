import {
  BLOQUEIO_MINUTOS,
  BUILTIN_DOC_TYPES,
  DATA_ISO,
  DIAS_RETENCAO_LIXEIRA,
  HASH_FALSO,
  MAX_FOTO_BYTES,
  MAX_TENTATIVAS,
  PALETA,
  SIGLA_VALIDA,
  apagarCertificadosDaLixeira,
  base64ParaBytes,
  bytesParaBase64,
  clienteInfo,
  dataLimiteRetencao,
  dataValida,
  detectarTipoArquivo,
  garantirTabelaFotos,
  garantirTabelasCert,
  handleFoto,
  lerJson,
  obterSessao,
  purgarLixeiraAntiga,
  regHist,
  resolverEmpresa
} from './handlers_core.js';
import { json, hashPassword, verifyPassword, makeSessionToken, getSession, generateRecoveryCode, usernameValido } from './auth.js';

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

export { handleData };
