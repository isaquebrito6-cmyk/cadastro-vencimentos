/* Patch v5: exclusao de empresa pelo seletor + dedup por nome + assinaturas + funcao + badges */
(function () {
  var SIG_COLAB_KEY = 'cv_assinatura_colaborador';
  var SIG_RESP_KEY = 'cv_assinatura_responsavel';
  var sigColab = null;
  var sigResp = null;
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
    var blank = document.createElement('canvas');
    blank.width = canvas.width; blank.height = canvas.height;
    return canvas.toDataURL() === blank.toDataURL();
  }

  function redrawCarteira() {
    if (window.CARTEIRA_ATUAL && typeof window.abrirCarteira === 'function') {
      window.abrirCarteira(window.CARTEIRA_ATUAL.colabId, window.CARTEIRA_ATUAL.sigla, true);
    }
  }

  function ensureSigUI() {
    if (document.getElementById('sigPadBox')) return;
    var modal = document.getElementById('cardModal');
    if (!modal) return;
    var printBtn = document.getElementById('cardImprimir');
    if (!printBtn) return;
    var box = document.createElement('div');
    box.id = 'sigPadBox';
    box.style.cssText = 'margin:8px 0 12px;padding:10px;border:1px dashed var(--line,#333);border-radius:4px;';
    box.innerHTML =
      '<div style="font-size:12px;font-weight:600;margin-bottom:10px;">✍️ Assinaturas digitais</div>' +
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

    var canvasColab = document.getElementById('sigPadColab');
    var canvasResp = document.getElementById('sigPadResp');
    var ctxColab = makePad(canvasColab);
    var ctxResp = makePad(canvasResp);
    function restore(canvas, ctx, dataUrl) {
      if (!dataUrl) return;
      var im = new Image();
      im.onload = function () { ctx.drawImage(im, 0, 0, canvas.width, canvas.height); };
      im.src = dataUrl;
    }
    restore(canvasColab, ctxColab, sigColab);
    restore(canvasResp, ctxResp, sigResp);
    function setStatus(t) { var el = document.getElementById('sigStatus'); if (el) el.textContent = t; }

    document.getElementById('sigLimparColab').onclick = function () {
      ctxColab.clearRect(0, 0, canvasColab.width, canvasColab.height);
      sigColab = null; try { localStorage.removeItem(SIG_COLAB_KEY); } catch (_) {}
      setStatus('Assinatura do colaborador limpa.'); redrawCarteira();
    };
    document.getElementById('sigUsarColab').onclick = function () {
      if (isBlank(canvasColab)) { setStatus('Desenhe a assinatura do colaborador.'); return; }
      sigColab = canvasColab.toDataURL('image/png');
      try { localStorage.setItem(SIG_COLAB_KEY, sigColab); } catch (_) {}
      setStatus('Assinatura do colaborador aplicada.'); redrawCarteira();
    };
    document.getElementById('sigLimparResp').onclick = function () {
      ctxResp.clearRect(0, 0, canvasResp.width, canvasResp.height);
      sigResp = null; try { localStorage.removeItem(SIG_RESP_KEY); } catch (_) {}
      setStatus('Assinatura do responsável limpa.'); redrawCarteira();
    };
    document.getElementById('sigUsarResp').onclick = function () {
      if (isBlank(canvasResp)) { setStatus('Desenhe a assinatura do responsável.'); return; }
      sigResp = canvasResp.toDataURL('image/png');
      try { localStorage.setItem(SIG_RESP_KEY, sigResp); } catch (_) {}
      setStatus('Assinatura do responsável aplicada.'); redrawCarteira();
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
        var imgColab = await loadImg(sigColab);
        var imgResp = await loadImg(sigResp);
        if (imgColab) ctx.drawImage(imgColab, 40, 500, 400, 50);
        if (imgResp) ctx.drawImage(imgResp, 540, 500, 360, 50);
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
        ctx.fillText('FUNÇÃO', 40, 530);
        ctx.fillStyle = '#111'; ctx.font = '600 20px Oswald, sans-serif';
        var texto = funcao.toUpperCase();
        while (ctx.measureText(texto).width > 240 && texto.length > 3) texto = texto.slice(0, -2);
        ctx.fillText(texto, 40, 554);
      } catch (_) {}
      return c;
    };
    window.desenharFrente.__patchedFuncao = true;
  }

  function patchDesenharFrenteBadges() {
    if (typeof window.desenharFrente !== 'function' || window.desenharFrente.__patchedBadges) return;
    var prev = window.desenharFrente;
    window.desenharFrente = async function (e, sigla, fotoURL, logoURL, equip) {
      var c = await prev(e, sigla, fotoURL, logoURL, equip);
      try {
        var ctx = c.getContext('2d');
        var order = (window.DOC_ORDER && window.DOC_ORDER.length) ? window.DOC_ORDER.slice() : Object.keys((e && e.docs) || {});
        var itens = [];
        order.forEach(function (s) {
          if (!e.docs || !e.docs[s]) return;
          var st = typeof window.statusFor === 'function' ? window.statusFor(e.docs[s]) : 'valido';
          itens.push({ sigla: s, st: st });
        });
        if (!itens.length) return c;
        var x = 28, y = c.height - 52, gap = 8, maxX = c.width - 28;
        itens.forEach(function (it) {
          ctx.font = '700 16px Oswald, sans-serif';
          var bw = ctx.measureText(it.sigla).width + 28, bh = 26;
          if (x + bw > maxX) return;
          var cor = it.st === 'vencido' ? '#D3211A' : (it.st === 'a_vencer' ? '#f2b705' : '#3fae5c');
          var isAtual = it.sigla === sigla;
          ctx.fillStyle = isAtual ? cor : '#fff'; ctx.strokeStyle = cor; ctx.lineWidth = 2;
          var r = 8;
          ctx.beginPath();
          ctx.moveTo(x + r, y); ctx.lineTo(x + bw - r, y); ctx.quadraticCurveTo(x + bw, y, x + bw, y + r);
          ctx.lineTo(x + bw, y + bh - r); ctx.quadraticCurveTo(x + bw, y + bh, x + bw - r, y + bh);
          ctx.lineTo(x + r, y + bh); ctx.quadraticCurveTo(x, y + bh, x, y + bh - r);
          ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
          ctx.fill(); ctx.stroke();
          ctx.fillStyle = cor; ctx.beginPath(); ctx.arc(x + 12, y + bh / 2, 5, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = (isAtual && it.st === 'vencido') ? '#fff' : '#111';
          ctx.font = '700 15px Oswald, sans-serif'; ctx.textBaseline = 'middle';
          ctx.fillText(it.sigla, x + 22, y + bh / 2 + 1);
          x += bw + gap;
        });
      } catch (_) {}
      return c;
    };
    window.desenharFrente.__patchedBadges = true;
  }

  function ensureExcluirEmpresaBtn() {
    var novaBtn = document.getElementById('novaEmpresaBtn');
    if (!novaBtn) return;
    var old = document.getElementById('excluirEmpresaBtn');
    if (old) old.remove();
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn ghost'; btn.id = 'excluirEmpresaBtn';
    btn.style.cssText = 'padding:4px 10px;font-size:12px;color:var(--red,#e2483a);';
    btn.textContent = '✕ Excluir empresa';
    novaBtn.parentNode.insertBefore(btn, novaBtn.nextSibling);

    btn.addEventListener('click', async function (ev) {
      ev.preventDefault();
      try {
        var sel = document.getElementById('seletorEmpresa');
        var id = null, nome = '';
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
          if (typeof window.showToast === 'function') window.showToast('Selecione uma empresa no seletor.', 'error');
          else alert('Selecione uma empresa no seletor.');
          return;
        }
        if (!nome) nome = '#' + id;

        if (!confirm('Excluir a empresa "' + nome + '" (id ' + id + ')?\n\nApaga colaboradores e documentos desta empresa.')) return;

        var conf = prompt('Digite o nome da empresa para confirmar:\n\n' + nome);
        if (conf === null) return;
        var a = String(conf).trim().toLowerCase().replace(/\s+/g, ' ');
        var b = String(nome).trim().toLowerCase().replace(/\s+/g, ' ');
        if (a !== b) {
          if (typeof window.showToast === 'function') window.showToast('Nome não confere. Empresa não excluída.', 'error');
          else alert('Nome não confere.');
          return;
        }

        await window.apiFetch('/api/empresas?id=' + encodeURIComponent(id), { method: 'DELETE' });
        if (typeof window.showToast === 'function') window.showToast('Empresa "' + nome + '" excluída.');
        else alert('Empresa excluída.');
        window.EMPRESA_ATUAL = null;
        if (typeof window.refreshData === 'function') await window.refreshData();
        else location.reload();
      } catch (err) {
        var msg = (err && err.message) || String(err);
        if (msg === 'nao_pode_excluir_ultima_empresa') msg = 'Não é possível excluir a última empresa.';
        else if (msg === 'existem_usuarios_vinculados') msg = 'Há usuários vinculados a esta empresa. Remova-os antes.';
        else if (msg === 'somente_admin') msg = 'Somente administrador pode excluir empresa.';
        else if (msg === 'empresa_inexistente') msg = 'Empresa não encontrada.';
        if (typeof window.showToast === 'function') window.showToast('Erro ao excluir: ' + msg, 'error');
        else alert('Erro ao excluir: ' + msg);
      }
    });
  }

  function patchRenderSeletorEmpresa() {
    if (typeof window.renderSeletorEmpresa !== 'function' || window.renderSeletorEmpresa.__patchedDedup2) return;
    var orig = window.renderSeletorEmpresa;
    window.renderSeletorEmpresa = function () {
      try {
        if (window.EMPRESAS_DISPONIVEIS && Array.isArray(window.EMPRESAS_DISPONIVEIS)) {
          var seenId = {}, seenNome = {}, atualId = window.EMPRESA_ATUAL && window.EMPRESA_ATUAL.id;
          var out = [];
          window.EMPRESAS_DISPONIVEIS.forEach(function (e) {
            if (!e || e.id == null) return;
            if (seenId[e.id]) return;
            var nome = String(e.nome || '').trim().toLowerCase().replace(/\s+/g, ' ');
            if (nome && seenNome[nome] != null) {
              var prev = out[seenNome[nome]];
              if (e.id === atualId || (prev && prev.id !== atualId && e.id < prev.id)) {
                out[seenNome[nome]] = e; seenId[e.id] = true;
              }
              return;
            }
            seenId[e.id] = true;
            if (nome) seenNome[nome] = out.length;
            out.push(e);
          });
          window.EMPRESAS_DISPONIVEIS = out;
        }
      } catch (_) {}
      var r = orig();
      // limpa options duplicadas no DOM
      try {
        var sel = document.getElementById('seletorEmpresa');
        if (sel) {
          var sId = {}, sNome = {};
          Array.prototype.slice.call(sel.options).forEach(function (opt) {
            var id = opt.value;
            var nome = String(opt.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
            if (sId[id] || (nome && sNome[nome])) { opt.remove(); return; }
            sId[id] = true; if (nome) sNome[nome] = true;
          });
        }
      } catch (_) {}
      return r;
    };
    window.renderSeletorEmpresa.__patchedDedup2 = true;
    try { window.renderSeletorEmpresa(); } catch (_) {}
  }

  function injectFuncaoFields() {
    document.querySelectorAll('tr.edit-row').forEach(function (row) {
      if (row.querySelector('[id^="fld-funcao-"]')) return;
      var nomeInput = row.querySelector('input[id^="fld-nome-"]');
      if (!nomeInput) return;
      var id = nomeInput.id.replace('fld-nome-', '');
      var funcaoAtual = '';
      try {
        if (window.DATA) {
          var col = window.DATA.find(function (x) { return x.id === id; });
          if (col && col.funcao) funcaoAtual = col.funcao;
        }
      } catch (_) {}
      var field = document.createElement('div');
      field.className = 'field wide';
      field.innerHTML = '<label>Função / cargo</label><input type="text" id="fld-funcao-' + id + '" value="' +
        String(funcaoAtual).replace(/"/g, '"') + '" placeholder="ex.: Operador" maxlength="120">';
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

  function boot() {
    ensureSigUI();
    patchDesenharVerso();
    patchDesenharFrente();
    patchDesenharFrenteBadges();
    patchEnviarLogo();
    patchApiFetchFuncao();
    patchRenderSeletorEmpresa();
    ensureExcluirEmpresaBtn();
    injectFuncaoFields();

    var modal = document.getElementById('cardModal');
    if (modal && !modal.__sigObs) {
      modal.__sigObs = true;
      new MutationObserver(function () {
        if (modal.style.display === 'flex' || modal.style.display === 'block') {
          ensureSigUI(); patchDesenharVerso(); patchDesenharFrente(); patchDesenharFrenteBadges();
        }
      }).observe(modal, { attributes: true, attributeFilter: ['style'] });
    }
    var tbody = document.getElementById('tableBody') || document.body;
    if (tbody && !tbody.__funcaoObs) {
      tbody.__funcaoObs = true;
      new MutationObserver(function () {
        injectFuncaoFields();
        ensureExcluirEmpresaBtn();
        patchRenderSeletorEmpresa();
      }).observe(tbody, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setTimeout(boot, 800);
  setTimeout(boot, 2500);
  setTimeout(boot, 5000);
})();
