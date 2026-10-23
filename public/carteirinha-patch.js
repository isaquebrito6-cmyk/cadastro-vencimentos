/* Patch v14: chips so sob a foto (nao sobrepoe APTO); NR + numero */
(function () {
  var SIG_COLAB_KEY = 'cv_assinatura_colaborador';
  var SIG_RESP_KEY = 'cv_assinatura_responsavel';
  var sigColab = null, sigResp = null;
  try { sigColab = localStorage.getItem(SIG_COLAB_KEY) || null; } catch (_) {}
  try { sigResp = localStorage.getItem(SIG_RESP_KEY) || null; } catch (_) {}

  function makePad(canvas) {
    var ctx = canvas.getContext('2d');
    var drawing = false, last = null;
    function pos(e) {
      var r = canvas.getBoundingClientRect();
      var src = e.touches ? e.touches[0] : e;
      return { x: (src.clientX - r.left) * (canvas.width / r.width), y: (src.clientY - r.top) * (canvas.height / r.height) };
    }
    function start(e) { e.preventDefault(); drawing = true; last = pos(e); }
    function move(e) {
      if (!drawing) return; e.preventDefault();
      var p = pos(e);
      ctx.strokeStyle = '#111'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p;
    }
    function end() { drawing = false; }
    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
    return ctx;
  }
  function isBlank(canvas) {
    var b = document.createElement('canvas'); b.width = canvas.width; b.height = canvas.height;
    return canvas.toDataURL() === b.toDataURL();
  }
  function redrawCarteira() {
    if (window.CARTEIRA_ATUAL && typeof window.abrirCarteira === 'function') {
      window.abrirCarteira(window.CARTEIRA_ATUAL.colabId, window.CARTEIRA_ATUAL.sigla, true);
    }
  }
  function ensureSigUI() {
    if (document.getElementById('sigPadBox')) return;
    var modal = document.getElementById('cardModal');
    var printBtn = document.getElementById('cardImprimir');
    if (!modal || !printBtn) return;
    var box = document.createElement('div');
    box.id = 'sigPadBox';
    box.style.cssText = 'margin:8px 0 12px;padding:10px;border:1px dashed var(--line,#333);border-radius:4px;';
    box.innerHTML = '<div style="font-size:12px;font-weight:600;margin-bottom:10px;">✍️ Assinaturas digitais</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
      '<div><div style="font-size:11px;color:var(--text-dim,#9aa0a8);margin-bottom:4px;">Colaborador</div>' +
      '<canvas id="sigPadColab" width="240" height="100" style="width:100%;height:100px;background:#fff;border:1px solid #333;border-radius:4px;touch-action:none;cursor:crosshair;"></canvas>' +
      '<div style="display:flex;gap:6px;margin-top:6px;"><button type="button" class="btn ghost" id="sigLimparColab" style="padding:4px 8px;font-size:11px;">Limpar</button>' +
      '<button type="button" class="btn primary" id="sigUsarColab" style="padding:4px 8px;font-size:11px;">Usar</button></div></div>' +
      '<div><div style="font-size:11px;color:var(--text-dim,#9aa0a8);margin-bottom:4px;">Responsável / Segurança do Trabalho</div>' +
      '<canvas id="sigPadResp" width="240" height="100" style="width:100%;height:100px;background:#fff;border:1px solid #333;border-radius:4px;touch-action:none;cursor:crosshair;"></canvas>' +
      '<div style="display:flex;gap:6px;margin-top:6px;"><button type="button" class="btn ghost" id="sigLimparResp" style="padding:4px 8px;font-size:11px;">Limpar</button>' +
      '<button type="button" class="btn primary" id="sigUsarResp" style="padding:4px 8px;font-size:11px;">Usar</button></div></div></div>' +
      '<div id="sigStatus" style="font-size:11px;color:var(--text-dim,#9aa0a8);margin-top:8px;"></div>';
    printBtn.parentElement.parentElement.insertBefore(box, printBtn.parentElement);
    var c1 = document.getElementById('sigPadColab'), c2 = document.getElementById('sigPadResp');
    var x1 = makePad(c1), x2 = makePad(c2);
    function restore(canvas, ctx, dataUrl) {
      if (!dataUrl) return;
      var im = new Image();
      im.onload = function () { ctx.drawImage(im, 0, 0, canvas.width, canvas.height); };
      im.src = dataUrl;
    }
    restore(c1, x1, sigColab); restore(c2, x2, sigResp);
    function st(t) { var el = document.getElementById('sigStatus'); if (el) el.textContent = t; }
    document.getElementById('sigLimparColab').onclick = function () {
      x1.clearRect(0, 0, c1.width, c1.height); sigColab = null;
      try { localStorage.removeItem(SIG_COLAB_KEY); } catch (_) {}
      st('Assinatura do colaborador limpa.'); redrawCarteira();
    };
    document.getElementById('sigUsarColab').onclick = function () {
      if (isBlank(c1)) { st('Desenhe a assinatura do colaborador.'); return; }
      sigColab = c1.toDataURL('image/png');
      try { localStorage.setItem(SIG_COLAB_KEY, sigColab); } catch (_) {}
      st('Assinatura do colaborador aplicada.'); redrawCarteira();
    };
    document.getElementById('sigLimparResp').onclick = function () {
      x2.clearRect(0, 0, c2.width, c2.height); sigResp = null;
      try { localStorage.removeItem(SIG_RESP_KEY); } catch (_) {}
      st('Assinatura do responsável limpa.'); redrawCarteira();
    };
    document.getElementById('sigUsarResp').onclick = function () {
      if (isBlank(c2)) { st('Desenhe a assinatura do responsável.'); return; }
      sigResp = c2.toDataURL('image/png');
      try { localStorage.setItem(SIG_RESP_KEY, sigResp); } catch (_) {}
      st('Assinatura do responsável aplicada.'); redrawCarteira();
    };
  }
  function loadImg(dataUrl) {
    return new Promise(function (res) {
      if (!dataUrl) return res(null);
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { res(null); };
      im.src = dataUrl;
    });
  }
  function patchDesenharVerso() {
    if (typeof window.desenharVerso !== 'function' || window.desenharVerso.__patchedSig2) return;
    var orig = window.desenharVerso;
    window.desenharVerso = async function (e, sigla, logoURL) {
      var c = await orig(e, sigla, logoURL);
      try {
        var ctx = c.getContext('2d');
        var a = await loadImg(sigColab), b = await loadImg(sigResp);
        if (a) ctx.drawImage(a, 40, 500, 400, 50);
        if (b) ctx.drawImage(b, 540, 500, 360, 50);
      } catch (_) {}
      return c;
    };
    window.desenharVerso.__patchedSig2 = true;
  }
  function patchDesenharFrente() {
    if (typeof window.desenharFrente !== 'function' || window.desenharFrente.__patchedFuncao) return;
    var orig = window.desenharFrente;
    window.desenharFrente = async function (e, sigla, fotoURL, logoURL, equip) {
      var c = await orig(e, sigla, fotoURL, logoURL, equip);
      var funcao = (e && e.funcao) ? String(e.funcao).trim() : '';
      if (!funcao) return c;
      try {
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#6B747C'; ctx.font = '600 16px Inter, sans-serif';
        ctx.fillText('FUNÇÃO', 300, 208);
        ctx.fillStyle = '#111'; ctx.font = '600 20px Oswald, sans-serif';
        var texto = funcao.toUpperCase();
        while (ctx.measureText(texto).width > 400 && texto.length > 3) texto = texto.slice(0, -2);
        ctx.fillText(texto, 300, 232);
      } catch (_) {}
      return c;
    };
    window.desenharFrente.__patchedFuncao = true;
  }
  function rotuloLocal(sigla) {
    var su = String(sigla || '').toUpperCase().trim();
    if (su === 'ASO' || /ASO/.test(su)) return { top: 'ASO', bottom: '' };
    if (su === 'LOTO' || /LOTO|BLOQUEIO/.test(su)) return { top: 'NR', bottom: '10/12' };
    var m = su.match(/NR\s*-?\s*(\d{1,2})/);
    if (m) {
      var num = m[1];
      if (/SUP/.test(su)) num += '+';
      return { top: 'NR', bottom: num };
    }
    var d = su.match(/(\d{1,2})/);
    if (d) return { top: 'NR', bottom: d[1] };
    return { top: 'NR', bottom: su.slice(0, 4) };
  }
  function corSegChip(sigla) {
    try {
      if (typeof window.corSegurancaDe === 'function') {
        var cs = window.corSegurancaDe(sigla);
        if (cs && cs.hex) return cs.hex;
      }
    } catch (_) {}
    var s = String(sigla).toUpperCase();
    if (s === 'ASO' || /ASO/.test(s)) return '#2E8B57';
    if (s.indexOf('35') >= 0) return '#0A5BB5';
    if (s.indexOf('33') >= 0) return '#F5B800';
    if (s.indexOf('20') >= 0 || s.indexOf('LOTO') >= 0 || s.indexOf('10') >= 0) return '#D3211A';
    return '#F26B1D';
  }
  function patchDesenharFrenteBadges() {
    if (typeof window.desenharFrente !== 'function' || window.desenharFrente.__patchedBadges9) return;
    var prev = window.desenharFrente;
    window.desenharFrente = async function (e, sigla, fotoURL, logoURL, equip) {
      var c = await prev(e, sigla, fotoURL, logoURL, equip);
      try {
        var ctx = c.getContext('2d');
        // Chips SOMENTE sob a foto — não invadem o botão APTO à direita
        var fx = 40, fy = 196, fw = 240, fh = 320;
        var shrink = 110;
        var fotoBase = fy + fh;
        var novaBase = fotoBase - shrink;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(fx - 1, novaBase, fw + 2, shrink + 2);
        ctx.strokeStyle = '#c5c9ce';
        ctx.lineWidth = 2;
        ctx.strokeRect(fx, fy, fw, fh - shrink);

        var docs = (e && e.docs) || {};
        var itens = [];
        Object.keys(docs).forEach(function (s) {
          if (!docs[s]) return;
          var st = typeof window.statusFor === 'function' ? window.statusFor(docs[s]) : 'valido';
          if (st === 'sem_registro') return;
          itens.push({ sigla: s, st: st });
        });
        if (!itens.length) return c;

        var areaW = fw;
        var cw = 48, ch = 42, gap = 8;
        var porLinha = Math.max(1, Math.floor((areaW + gap) / (cw + gap)));
        var y = novaBase + 8;
        var col = 0;

        itens.forEach(function (it) {
          if (col >= porLinha) {
            col = 0;
            y += ch + 8;
            if (y + ch > 548) return;
          }
          var x = fx + col * (cw + gap);
          var rot = rotuloLocal(it.sigla);
          var bg = corSegChip(it.sigla);
          var border = it.st === 'vencido' ? '#e2483a' : (it.st === 'a_vencer' ? '#f2954a' : '#222');

          ctx.fillStyle = 'rgba(0,0,0,0.2)';
          ctx.fillRect(x + 2, y + 2, cw, ch);
          ctx.fillStyle = bg;
          ctx.strokeStyle = border;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.rect(x, y, cw, ch);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = '#111';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          if (rot.bottom) {
            ctx.font = '800 11px monospace';
            ctx.fillText(rot.top, x + cw / 2, y + 13);
            ctx.font = '900 17px monospace';
            ctx.fillText(rot.bottom, x + cw / 2, y + 30);
          } else {
            ctx.font = '900 15px monospace';
            ctx.fillText(rot.top, x + cw / 2, y + ch / 2 + 1);
          }
          ctx.textAlign = 'left';
          col += 1;
        });
      } catch (_) {}
      return c;
    };
    window.desenharFrente.__patchedBadges9 = true;
  }

  function patchHistoricoDelete() {
    var list = document.getElementById('historicoList');
    if (!list || list.__histDelV11) return;
    list.__histDelV11 = true;
    list.addEventListener('click', async function (ev) {
      var btn = ev.target.closest('[data-del-historico]');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      var id = btn.getAttribute('data-del-historico') || btn.dataset.delHistorico;
      if (!id) return;
      if (!confirm('Mover este registro para a lixeira? Dá pra restaurar depois.')) return;
      try {
        await window.apiFetch('/api/historico?id=' + encodeURIComponent(id), { method: 'DELETE' });
        if (typeof window.refreshData === 'function') await window.refreshData();
        if (typeof window.showToast === 'function') window.showToast('Registro apagado.');
        else alert('Registro apagado.');
      } catch (err) {
        var msg = (err && err.message) || String(err);
        if (msg === 'nao_encontrado' || msg === 'not_found') {
          try { if (typeof window.refreshData === 'function') await window.refreshData(); } catch (_) {}
          if (typeof window.showToast === 'function') window.showToast('Registro atualizado.');
          return;
        }
        if (msg === 'somente_admin') msg = 'Somente administrador pode apagar histórico.';
        if (typeof window.showToast === 'function') window.showToast('Não foi possível apagar: ' + msg, 'error');
        else alert('Não foi possível apagar: ' + msg);
      }
    }, true);
  }

  function rotularSeletorEmpresas() {
    var sel = document.getElementById('seletorEmpresa');
    if (!sel) return;
    var nomes = {};
    Array.prototype.slice.call(sel.options).forEach(function (opt) {
      var base = String(opt.textContent || '').replace(/\s*\(id\s*\d+\)\s*$/i, '').trim();
      nomes[base.toLowerCase()] = (nomes[base.toLowerCase()] || 0) + 1;
    });
    Array.prototype.slice.call(sel.options).forEach(function (opt) {
      var base = String(opt.textContent || '').replace(/\s*\(id\s*\d+\)\s*$/i, '').trim();
      opt.textContent = nomes[base.toLowerCase()] > 1 ? (base + ' (id ' + opt.value + ')') : base;
    });
  }

  async function excluirEmpresaSelecionada() {
    try {
      var sel = document.getElementById('seletorEmpresa');
      var id = null, nome = '';
      if (sel && sel.value) {
        id = parseInt(sel.value, 10);
        nome = (sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].textContent) || '';
        nome = String(nome).replace(/\s*\(id\s*\d+\)\s*$/i, '').trim();
      }
      if (!id || Number.isNaN(id)) {
        if (window.EMPRESA_ATUAL && window.EMPRESA_ATUAL.id) {
          id = window.EMPRESA_ATUAL.id;
          nome = window.EMPRESA_ATUAL.nome || ('#' + id);
        }
      }
      if (!id) { alert('Selecione uma empresa no seletor.'); return; }
      if (!nome) nome = '#' + id;
      if (!confirm('Excluir a empresa "' + nome + '" (id ' + id + ')?\n\nApaga colaboradores e documentos desta empresa.')) return;
      var conf = prompt('Confirme o nome da empresa (já preenchido — pode copiar/colar ou só OK):', nome);
      if (conf === null) return;
      var a = String(conf).trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(id\s*\d+\)\s*$/i, '');
      var b = String(nome).trim().toLowerCase().replace(/\s+/g, ' ');
      if (a !== b) { alert('Nome não confere. Empresa não excluída.'); return; }
      if (typeof window.apiFetch !== 'function') { alert('API não disponível. Recarregue (Ctrl+F5).'); return; }
      var idExcluido = id;
      window.EMPRESA_ATUAL = null;
      await window.apiFetch('/api/empresas?id=' + encodeURIComponent(idExcluido), { method: 'DELETE' });
      function purgarLocal() {
        try {
          if (window.EMPRESAS_DISPONIVEIS) {
            window.EMPRESAS_DISPONIVEIS = window.EMPRESAS_DISPONIVEIS.filter(function (e) {
              return e && String(e.id) !== String(idExcluido);
            });
          }
          var s = document.getElementById('seletorEmpresa');
          if (s) Array.prototype.slice.call(s.options).forEach(function (opt) {
            if (String(opt.value) === String(idExcluido)) opt.remove();
          });
        } catch (_) {}
      }
      purgarLocal();
      try {
        var lista = await window.apiFetch('/api/empresas');
        var empresas = ((lista && lista.empresas) || []).filter(function (e) {
          return e && String(e.id) !== String(idExcluido);
        });
        window.EMPRESAS_DISPONIVEIS = empresas;
        window.EMPRESA_ATUAL = empresas.length ? { id: empresas[0].id, nome: empresas[0].nome } : null;
        if (typeof window.renderSeletorEmpresa === 'function') window.renderSeletorEmpresa();
        rotularSeletorEmpresas();
        purgarLocal();
      } catch (_) {}
      try { if (typeof window.refreshData === 'function') await window.refreshData(); } catch (_) {}
      purgarLocal();
      alert('Empresa "' + nome + '" excluída.');
    } catch (err) {
      var msg = (err && err.message) || String(err);
      if (msg === 'nao_pode_excluir_ultima_empresa') msg = 'Não é possível excluir a última empresa.';
      else if (msg === 'existem_usuarios_vinculados') msg = 'Há usuários vinculados a esta empresa. Remova-os antes.';
      else if (msg === 'somente_admin') msg = 'Somente administrador pode excluir empresa.';
      alert('Erro ao excluir: ' + msg);
    }
  }

  function ensureExcluirEmpresaBtn() {
    var novaBtn = document.getElementById('novaEmpresaBtn');
    if (!novaBtn) return;
    var btn = document.getElementById('excluirEmpresaBtn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn ghost'; btn.id = 'excluirEmpresaBtn';
      btn.style.cssText = 'padding:4px 10px;font-size:12px;color:var(--red,#e2483a);';
      btn.textContent = '✕ Excluir empresa';
      novaBtn.parentNode.insertBefore(btn, novaBtn.nextSibling);
    }
    if (!btn.__bound) {
      btn.__bound = true;
      btn.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        excluirEmpresaSelecionada();
      });
    }
  }

  function ensureBatchToolbar() {
    if (document.getElementById('batchDelBtn')) return;
    var addBtn = document.getElementById('addBtn');
    if (!addBtn) return;
    var wrap = document.createElement('span');
    wrap.id = 'batchToolbar';
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:8px;margin-left:8px;flex-wrap:wrap;';
    wrap.innerHTML = '<label style="font-size:12px;display:inline-flex;align-items:center;gap:4px;cursor:pointer;">' +
      '<input type="checkbox" id="colabSelectAll"> Todos</label>' +
      '<button type="button" class="btn ghost" id="batchDelBtn" style="color:var(--red,#e2483a);">Excluir selecionados</button>' +
      '<span id="batchCount" style="font-size:11px;color:var(--text-dim,#9aa0a8);"></span>';
    addBtn.parentNode.insertBefore(wrap, addBtn.nextSibling);
    document.getElementById('colabSelectAll').addEventListener('change', function (ev) {
      var on = !!ev.target.checked;
      document.querySelectorAll('#tableBody .colab-check').forEach(function (c) { c.checked = on; });
      atualizarBatchCount();
    });
    document.getElementById('batchDelBtn').addEventListener('click', async function () {
      var ids = [];
      document.querySelectorAll('#tableBody .colab-check:checked').forEach(function (c) {
        if (c.dataset.colabId) ids.push(c.dataset.colabId);
      });
      if (!ids.length) { alert('Selecione ao menos um colaborador.'); return; }
      if (!confirm('Mover ' + ids.length + ' colaborador(es) para a lixeira?')) return;
      var ok = 0, fail = 0;
      for (var i = 0; i < ids.length; i++) {
        try { await window.apiFetch('/api/colaborador?id=' + encodeURIComponent(ids[i]), { method: 'DELETE' }); ok++; }
        catch (_) { fail++; }
      }
      if (typeof window.refreshData === 'function') await window.refreshData();
      alert(ok + ' movido(s) para a lixeira' + (fail ? ', ' + fail + ' falha(s)' : '') + '.');
      var all = document.getElementById('colabSelectAll');
      if (all) all.checked = false;
      atualizarBatchCount();
    });
  }
  function atualizarBatchCount() {
    var n = document.querySelectorAll('#tableBody .colab-check:checked').length;
    var el = document.getElementById('batchCount');
    if (el) el.textContent = n ? (n + ' selecionado(s)') : '';
  }
  function injectRowCheckboxes() {
    var tbody = document.getElementById('tableBody');
    if (!tbody) return;
    var table = tbody.closest('table');
    if (table) {
      var headRow = table.querySelector('thead tr');
      if (headRow && !headRow.querySelector('.th-check')) {
        var th = document.createElement('th');
        th.className = 'th-check no-sort'; th.style.cssText = 'width:36px;';
        headRow.insertBefore(th, headRow.firstChild);
      }
    }
    tbody.querySelectorAll('tr').forEach(function (tr) {
      if (tr.classList.contains('edit-row') || tr.querySelector('.colab-check') || tr.querySelector('.empty-state')) return;
      var del = tr.querySelector('[data-del]');
      var edit = tr.querySelector('[data-edit]');
      var id = del ? del.dataset.del : (edit ? edit.dataset.edit : null);
      if (!id) return;
      var td = document.createElement('td');
      td.style.cssText = 'width:36px;vertical-align:middle;';
      td.innerHTML = '<input type="checkbox" class="colab-check" data-colab-id="' + id + '" style="width:16px;height:16px;cursor:pointer;">';
      tr.insertBefore(td, tr.firstChild);
      td.querySelector('.colab-check').addEventListener('change', atualizarBatchCount);
    });
    atualizarBatchCount();
  }
  function patchRenderTable() {
    if (typeof window.renderTable !== 'function' || window.renderTable.__patchedBatch) return;
    var orig = window.renderTable;
    window.renderTable = function () {
      var r = orig.apply(this, arguments);
      try { ensureBatchToolbar(); injectRowCheckboxes(); } catch (_) {}
      return r;
    };
    window.renderTable.__patchedBatch = true;
  }
  function patchRenderSeletorEmpresa() {
    if (typeof window.renderSeletorEmpresa !== 'function' || window.renderSeletorEmpresa.__patchedDedup3) return;
    var orig = window.renderSeletorEmpresa;
    window.renderSeletorEmpresa = function () {
      try {
        if (window.EMPRESAS_DISPONIVEIS && Array.isArray(window.EMPRESAS_DISPONIVEIS)) {
          var seenId = {}, out = [];
          window.EMPRESAS_DISPONIVEIS.forEach(function (e) {
            if (!e || e.id == null || seenId[e.id]) return;
            seenId[e.id] = true; out.push(e);
          });
          window.EMPRESAS_DISPONIVEIS = out;
        }
      } catch (_) {}
      var r = orig();
      try { rotularSeletorEmpresas(); } catch (_) {}
      return r;
    };
    window.renderSeletorEmpresa.__patchedDedup3 = true;
    try { window.renderSeletorEmpresa(); } catch (_) {}
  }
  function injectFuncaoFields() {
    document.querySelectorAll('tr.edit-row').forEach(function (row) {
      if (row.querySelector('[id^="fld-funcao-"]')) return;
      var nomeInput = row.querySelector('input[id^="fld-nome-"]');
      if (!nomeInput) return;
      var id = nomeInput.id.replace('fld-nome-', '');
      var field = document.createElement('div');
      field.className = 'field wide';
      field.innerHTML = '<label>Função / cargo</label><input type="text" id="fld-funcao-' + id + '" value="" placeholder="ex.: Operador" maxlength="120">';
      var nomeField = nomeInput.closest('.field');
      if (nomeField && nomeField.parentNode) nomeField.parentNode.insertBefore(field, nomeField.nextSibling);
    });
  }
  function patchApiFetchFuncao() {
    if (typeof window.apiFetch !== 'function' || window.apiFetch.__patchedFuncao) return;
    var orig = window.apiFetch;
    window.apiFetch = async function (path, options) {
      options = options || {};
      if (path && path.indexOf('/api/colaborador') === 0 && options.method === 'POST' && options.body) {
        try {
          var body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
          if (body && typeof body === 'object') {
            var fid = body.id || null;
            var input = fid ? document.getElementById('fld-funcao-' + fid) : document.querySelector('input[id^="fld-funcao-"]');
            if (input) body.funcao = (input.value || '').trim().slice(0, 120);
            options = Object.assign({}, options, { body: JSON.stringify(body) });
          }
        } catch (_) {}
      }
      return orig(path, options);
    };
    window.apiFetch.__patchedFuncao = true;
  }
  function patchEnviarLogo() {
    if (typeof window.enviarLogo !== 'function' || window.enviarLogo.__patched) return;
    var orig = window.enviarLogo;
    window.enviarLogo = async function (file) {
      await orig(file);
      try {
        var chave = typeof window.chaveLogo === 'function' ? window.chaveLogo() : null;
        if (chave && window.FOTO_URLS) delete window.FOTO_URLS[chave];
        if (window.CARTEIRA_ATUAL && typeof window.abrirCarteira === 'function') {
          await window.abrirCarteira(window.CARTEIRA_ATUAL.colabId, window.CARTEIRA_ATUAL.sigla, true);
        }
      } catch (_) {}
    };
    window.enviarLogo.__patched = true;
  }
  function showVersionBadge() {
    var el = document.getElementById('patch-version-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'patch-version-badge';
      el.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:99999;font-size:10px;opacity:0.55;background:#111;color:#9f9;padding:2px 6px;border-radius:4px;pointer-events:none;';
      document.body.appendChild(el);
    }
    el.textContent = 'patch v14';
  }
  function boot() {
    showVersionBadge();
    ensureSigUI();
    patchDesenharVerso();
    patchDesenharFrente();
    patchDesenharFrenteBadges();
    patchEnviarLogo();
    patchApiFetchFuncao();
    patchRenderSeletorEmpresa();
    ensureExcluirEmpresaBtn();
    ensureBatchToolbar();
    patchRenderTable();
    injectFuncaoFields();
    injectRowCheckboxes();
    patchHistoricoDelete();
    var modal = document.getElementById('cardModal');
    if (modal && !modal.__sigObs) {
      modal.__sigObs = true;
      new MutationObserver(function () {
        if (modal.style.display === 'flex' || modal.style.display === 'block') {
          ensureSigUI(); patchDesenharVerso(); patchDesenharFrente(); patchDesenharFrenteBadges();
        }
      }).observe(modal, { attributes: true, attributeFilter: ['style'] });
    }
    var tbody = document.getElementById('tableBody');
    if (tbody && !tbody.__batchObs) {
      tbody.__batchObs = true;
      new MutationObserver(function () {
        injectFuncaoFields(); ensureExcluirEmpresaBtn(); ensureBatchToolbar(); injectRowCheckboxes(); patchHistoricoDelete();
      }).observe(tbody, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setTimeout(boot, 500);
  setTimeout(boot, 1500);
  setTimeout(boot, 3000);
})();
