/* Fix pontual: exclusao de empresa le o seletor da tela */
(function () {
  function bind() {
    var btn = document.getElementById('excluirEmpresaBtn');
    if (!btn || btn.__fixedDelete) return;
    btn.__fixedDelete = true;

    // Remove listeners antigos clonando o botao
    var novo = btn.cloneNode(true);
    btn.parentNode.replaceChild(novo, btn);
    btn = novo;
    btn.__fixedDelete = true;

    btn.addEventListener('click', async function (ev) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      try {
        var sel = document.getElementById('seletorEmpresa');
        var id = null;
        var nome = '';
        if (sel && sel.value) {
          id = parseInt(sel.value, 10);
          nome = (sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].textContent) || '';
          nome = String(nome).trim();
        }
        if (!id || Number.isNaN(id)) {
          if (window.EMPRESA_ATUAL && window.EMPRESA_ATUAL.id) {
            id = window.EMPRESA_ATUAL.id;
            nome = window.EMPRESA_ATUAL.nome || ('#' + id);
          }
        }
        if (!id) {
          alert('Selecione uma empresa no seletor.');
          return;
        }
        if (!nome) nome = '#' + id;

        if (!confirm('Excluir a empresa "' + nome + '" (id ' + id + ')?\n\nApaga colaboradores e documentos desta empresa.')) return;

        var conf = prompt('Digite o nome da empresa para confirmar:\n\n' + nome);
        if (conf === null) return;
        var a = String(conf).trim().toLowerCase().replace(/\s+/g, ' ');
        var b = String(nome).trim().toLowerCase().replace(/\s+/g, ' ');
        if (a !== b) {
          alert('Nome nao confere. Empresa nao excluida.');
          return;
        }

        if (typeof window.apiFetch !== 'function') {
          alert('API nao disponivel. Recarregue a pagina.');
          return;
        }

        await window.apiFetch('/api/empresas?id=' + encodeURIComponent(id), { method: 'DELETE' });
        if (typeof window.showToast === 'function') window.showToast('Empresa "' + nome + '" excluida.');
        else alert('Empresa excluida.');
        window.EMPRESA_ATUAL = null;
        if (typeof window.refreshData === 'function') await window.refreshData();
        else location.reload();
      } catch (err) {
        var msg = (err && err.message) || String(err);
        if (msg === 'nao_pode_excluir_ultima_empresa') msg = 'Nao e possivel excluir a ultima empresa.';
        if (msg === 'existem_usuarios_vinculados') msg = 'Ha usuarios vinculados. Remova-os antes.';
        if (msg === 'somente_admin') msg = 'Somente administrador pode excluir.';
        alert('Erro ao excluir: ' + msg);
      }
    });
  }

  function dedupSelect() {
    var sel = document.getElementById('seletorEmpresa');
    if (!sel) return;
    var seenId = {}, seenNome = {};
    Array.prototype.slice.call(sel.options).forEach(function (opt) {
      var id = opt.value;
      var nome = String(opt.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (seenId[id] || (nome && seenNome[nome])) { opt.remove(); return; }
      seenId[id] = true;
      if (nome) seenNome[nome] = true;
    });
  }

  function boot() {
    bind();
    dedupSelect();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setTimeout(boot, 1000);
  setTimeout(boot, 3000);
  setInterval(function () { bind(); dedupSelect(); }, 4000);
})();
