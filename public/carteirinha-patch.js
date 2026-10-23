(function () {
  if (window.__carteirinhaPatchFinalApto) return;
  window.__carteirinhaPatchFinalApto = true;

  function loadImg(dataUrl) {
    return new Promise(function (resolve) {
      if (!dataUrl) return resolve(null);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = dataUrl;
    });
  }

  function rotuloLocal(sigla) {
    var s = String(sigla || '').toUpperCase().trim();

    if (s === 'ASO' || /ASO/.test(s)) return { top: 'ASO', bottom: '' };
    if (s === 'LOTO' || /LOTO|BLOQUEIO/.test(s)) return { top: 'NR', bottom: '10/12' };

    var m = s.match(/NR\s*-?\s*(\d{1,2})/);
    if (m) {
      var num = m[1];
      if (/SUP/.test(s)) num += '+';
      return { top: 'NR', bottom: num };
    }

    var d = s.match(/(\d{1,2})/);
    if (d) return { top: 'NR', bottom: d[1] };

    return { top: 'NR', bottom: s.slice(0, 4) };
  }

  function corSegChip(sigla) {
    var s = String(sigla).toUpperCase();

    if (s === 'ASO' || /ASO/.test(s)) return '#2E8B57';
    if (s.indexOf('26') >= 0) return '#8AA9D1'; // mais clara
    if (s.indexOf('35') >= 0) return '#0A5BB5';
    if (s.indexOf('33') >= 0) return '#F5B800';
    if (s.indexOf('20') >= 0 || s.indexOf('LOTO') >= 0 || s.indexOf('10') >= 0) return '#D3211A';
    return '#F26B1D';
  }

  function patchFrenteLayout() {
    if (typeof window.desenharFrente !== 'function') return;
    if (window.desenharFrente.__patchedApto) return;

    var original = window.desenharFrente;

    window.desenharFrente = async function (e, sigla, fotoURL, logoURL, equip) {
      var canvas = await original.call(this, e, sigla, fotoURL, logoURL, equip);
      if (!canvas) return canvas;

      var ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) return canvas;

      try {
        // foto esquerda
        var fotoBox = { x: 38, y: 118, w: 250, h: 270 };

        // chips à direita, logo abaixo da faixa "APTO para atividade"
        var chipBox = { x: 300, y: 390, w: 210, h: 118 };

        if (fotoURL) {
          var img = await loadImg(fotoURL);
          if (img) {
            ctx.save();
            ctx.fillStyle = '#f6f7f8';
            ctx.fillRect(fotoBox.x - 2, fotoBox.y - 2, fotoBox.w + 4, fotoBox.h + 4);
            ctx.strokeStyle = '#d5dbe1';
            ctx.lineWidth = 2;
            ctx.strokeRect(fotoBox.x, fotoBox.y, fotoBox.w, fotoBox.h);
            ctx.beginPath();
            ctx.rect(fotoBox.x, fotoBox.y, fotoBox.w, fotoBox.h);
            ctx.clip();

            var scale = Math.max(fotoBox.w / img.width, fotoBox.h / img.height);
            var drawW = img.width * scale;
            var drawH = img.height * scale;
            var drawX = fotoBox.x + (fotoBox.w - drawW) / 2;
            var drawY = fotoBox.y + (fotoBox.h - drawH) / 2;

            ctx.drawImage(img, drawX, drawY, drawW, drawH);
            ctx.restore();
          }
        }

        var funcao = (e && e.funcao) ? String(e.funcao).trim() : '';
        if (funcao) {
          ctx.fillStyle = '#6B747C';
          ctx.font = '600 16px Inter, sans-serif';
          ctx.fillText('FUNÇÃO', 306, 180);

          ctx.fillStyle = '#111';
          ctx.font = '600 20px Oswald, sans-serif';
          var texto = funcao.toUpperCase();
          while (ctx.measureText(texto).width > 260 && texto.length > 3) {
            texto = texto.slice(0, -2);
          }
          ctx.fillText(texto, 306, 208);
        }

        var docs = (e && e.docs) || {};
        var itens = [];

        Object.keys(docs).forEach(function (siglaDoc) {
          if (!docs[siglaDoc]) return;
          var status = typeof window.statusFor === 'function'
            ? window.statusFor(docs[siglaDoc])
            : 'valido';

          if (status !== 'sem_registro') {
            itens.push({ sigla: siglaDoc, status: status });
          }
        });

        if (!itens.length) return canvas;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(chipBox.x - 4, chipBox.y - 6, chipBox.w + 8, chipBox.h + 18);

        var cellW = 52;
        var cellH = 42;
        var gap = 8;
        var porLinha = Math.max(1, Math.floor((chipBox.w + gap) / (cellW + gap)));

        var xStart = chipBox.x;
        var yStart = chipBox.y + 8;
        var col = 0;
        var y = yStart;

        itens.forEach(function (item) {
          if (col >= porLinha) {
            col = 0;
            y += cellH + 8;
          }

          var x = xStart + col * (cellW + gap);
          var rot = rotuloLocal(item.sigla);
          var bg = corSegChip(item.sigla);
          var border = item.status === 'vencido'
            ? '#e2483a'
            : (item.status === 'a_vencer' ? '#f2954a' : '#232323');

          ctx.fillStyle = 'rgba(0,0,0,0.2)';
          ctx.fillRect(x + 2, y + 2, cellW, cellH);

          ctx.fillStyle = bg;
          ctx.strokeStyle = border;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.rect(x, y, cellW, cellH);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = '#111';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          if (rot.bottom) {
            ctx.font = '800 10px monospace';
            ctx.fillText(rot.top, x + cellW / 2, y + 13);
            ctx.font = '900 16px monospace';
            ctx.fillText(rot.bottom, x + cellW / 2, y + 30);
          } else {
            ctx.font = '900 14px monospace';
            ctx.fillText(rot.top, x + cellW / 2, y + cellH / 2 + 1);
          }

          col += 1;
        });

      } catch (err) {
        console.warn('carteirinha layout error:', err && err.message ? err.message : err);
      }

      return canvas;
    };

    window.desenharFrente.__patchedApto = true;
  }

  function boot() {
    patchFrenteLayout();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();