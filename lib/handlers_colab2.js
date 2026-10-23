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

export { handleColaborador };
