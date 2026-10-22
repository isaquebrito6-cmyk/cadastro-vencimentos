/* Patch: logo atualiza na hora + assinatura digital na carteirinha */
(function () {
  var SIG_KEY = 'cv_assinatura_digital';
  var assinaturaDataUrl = null;
  try { assinaturaDataUrl = localStorage.getItem(SIG_KEY) || null; } catch (_) {}

  function ensureSigUI() {
    if (document.getElementById('sigPadBox')) return;
    var modal = document.getElementById('cardModal');
    if (!modal) return;
    var printBtn = document.getElementById('cardImprimir');
    if (!printBtn) return;
    var printRow = printBtn.parentElement;
    var box = document.createElement('div');
    box.id = 'sigPadBox';
    box.style.cssText = 'margin:8px 0 12px;padding:10px;border:1px dashed var(--line,#333);border-radius:4px;';
    box.innerHTML =
      '<div style="font-size:12px;font-weight:600;margin-bottom:6px;">✍️ Assinatura digital do colaborador</div>' +
      '<canvas id="sigPad" width="500" height="120" style="width:100%;max-width:500px;height:120px;background:#fff;border:1px solid #333;border-radius:4px;touch-action:none;cursor:crosshair;"></canvas>' +
      '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">' +
      '<button type="button" class="btn ghost" id="sigLimpar">Limpar</button>' +
      '<button type="button" class="btn primary" id="sigUsar">Usar na carteirinha</button>' +
      '<span id="sigStatus" style="font-size:11px;color:var(--text-dim,#9aa0a8);align-self:center;"></span>' +
      '</div>';
    printRow.parentElement.insertBefore(box, printRow);

    var canvas = document.getElementById('sigPad');
    var ctx = canvas.getContext('2d');
    var drawing = false, last = null;

    function pos(e) {
      var r = canvas.getBoundingClientRect();
      var src = e.touches ? e.touches[0] : e;
      return {
        x: (src.clientX - r.left) * (canvas.width / r.width),
        y: (src.clientY - r.top) * (canvas.height / r.height)
      };
    }
    function start(e) { e.preventDefault(); drawing = true; last = pos(e); }
    function move(e) {
      if (!drawing) return;
      e.preventDefault();
      var p = pos(e);
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
    }
    function end() { drawing = false; }

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);

    if (assinaturaDataUrl) {
      var im = new Image();
      im.onload = function () { ctx.drawImage(im, 0, 0, canvas.width, canvas.height); };
      im.src = assinaturaDataUrl;
      document.getElementById('sigStatus').textContent = 'Assinatura salva neste aparelho.';
    }

    document.getElementById('sigLimpar').onclick = function () {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      assinaturaDataUrl = null;
      try { localStorage.removeItem(SIG_KEY); } catch (_) {}
      document.getElementById('sigStatus').textContent = 'Limpa.';
      if (window.CARTEIRA_ATUAL && typeof window.abrirCarteira === 'function') {
        window.abrirCarteira(window.CARTEIRA_ATUAL.colabId, window.CARTEIRA_ATUAL.sigla, true);
      }
    };

    document.getElementById('sigUsar').onclick = function () {
      var blank = document.createElement('canvas');
      blank.width = canvas.width;
      blank.height = canvas.height;
      if (canvas.toDataURL() === blank.toDataURL()) {
        document.getElementById('sigStatus').textContent = 'Desenhe a assinatura primeiro.';
        return;
      }
      assinaturaDataUrl = canvas.toDataURL('image/png');
      try { localStorage.setItem(SIG_KEY, assinaturaDataUrl); } catch (_) {}
      document.getElementById('sigStatus').textContent = 'Aplicada — atualizando…';
      if (window.CARTEIRA_ATUAL && typeof window.abrirCarteira === 'function') {
        window.abrirCarteira(window.CARTEIRA_ATUAL.colabId, window.CARTEIRA_ATUAL.sigla, true);
      }
    };
  }

  function patchDesenharVerso() {
    if (typeof window.desenharVerso !== 'function' || window.desenharVerso.__patched) return;
    var orig = window.desenharVerso;
    window.desenharVerso = async function (e, sigla, logoURL) {
      var c = await orig(e, sigla, logoURL);
      if (!assinaturaDataUrl) return c;
      try {
        var ctx = c.getContext('2d');
        var img = await new Promise(function (res) {
          var im = new Image();
          im.onload = function () { res(im); };
          im.onerror = function () { res(null); };
          im.src = assinaturaDataUrl;
        });
        if (img) {
          ctx.drawImage(img, 40, 500, 420, 55);
        }
      } catch (_) {}
      return c;
    };
    window.desenharVerso.__patched = true;
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
    patchEnviarLogo();
    var modal = document.getElementById('cardModal');
    if (modal && !modal.__sigObs) {
      modal.__sigObs = true;
      new MutationObserver(function () {
        if (modal.style.display === 'flex' || modal.style.display === 'block') {
          ensureSigUI();
          patchDesenharVerso();
          patchEnviarLogo();
        }
      }).observe(modal, { attributes: true, attributeFilter: ['style'] });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setTimeout(boot, 800);
  setTimeout(boot, 2500);
  setTimeout(boot, 5000);
})();
