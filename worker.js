/**
 * Worker temporário de manutenção.
 * Serve os arquivos estáticos (public/) normalmente.
 * Rotas /api/* respondem 503 até o worker completo ser publicado.
 *
 * Para restaurar: substitua este arquivo pelo conteúdo de
 * artifacts/cadastro-vencimentos-melhorias/worker_FINAL.js
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return new Response(
        JSON.stringify({
          error: 'manutencao',
          msg: 'Sistema em restauração. Publique o worker_FINAL.js (artifacts) em worker.js no GitHub.',
        }),
        {
          status: 503,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        }
      );
    }
    // HTML, JS, ícones, manifest, sw.js
    try {
      return await env.ASSETS.fetch(request);
    } catch (err) {
      return new Response('Asset não encontrado', { status: 404 });
    }
  },
};
