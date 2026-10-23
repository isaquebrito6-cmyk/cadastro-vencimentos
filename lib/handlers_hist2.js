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
    await regHist(db, request, session.username, `Restaurou um registro do historico (#${id})`, 'seguranca', empresaId);
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
      await regHist(db, request, session.username, `Esvaziou a lixeira do historico (${countRes[0].count} registros apagados definitivamente)`, 'seguranca', empresaId);
      return json({ ok: true });
    }

    if (limpar === 'tudo') {
      const { results: countRes } = await db.prepare('SELECT COUNT(*) AS count FROM historico WHERE empresa_id = ? AND deletado_em IS NULL').bind(empresaId).all();
      await db.prepare('UPDATE historico SET deletado_em = ? WHERE empresa_id = ? AND deletado_em IS NULL').bind(agora, empresaId).run();
      await regHist(db, request, session.username, `Moveu todo o historico para a lixeira (${countRes[0].count} registros)`, 'seguranca', empresaId);
      return json({ ok: true });
    }

    if (!idParam) return json({ error: 'id_obrigatorio' }, 400);
    const id = parseInt(idParam, 10);
    const { results } = await db.prepare('SELECT id FROM historico WHERE id = ? AND empresa_id = ? AND deletado_em IS NULL').bind(id, empresaId).all();
    if (results.length === 0) return json({ error: 'nao_encontrado' }, 404);
    await db.prepare('UPDATE historico SET deletado_em = ? WHERE id = ?').bind(agora, id).run();
    await regHist(db, request, session.username, `Moveu um registro do historico para a lixeira (#${id})`, 'seguranca', empresaId);
    return json({ ok: true });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

export { handleHistorico };
