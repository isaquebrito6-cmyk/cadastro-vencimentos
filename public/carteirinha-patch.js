/* Patch v16: chips abaixo do APTO (NR em cima / numero embaixo) + funcao + historico + scroll */
(function () {
  var SIG_COLAB_KEY = 'cv_assinatura_colaborador';
  var SIG_RESP_KEY = 'cv_assinatura_responsavel';
  var sigColab = null, sigResp = null;
  try { sigColab = localStorage.getItem(SIG_COLAB_KEY) || null; } catch (_) {}
  try { sigResp = localStorage.getItem(SIG_RESP_KEY) || null; } catch (_) {}

  function rotuloLocal(sigla) {
    var su = String(sigla || '').toUpperCase().trim();
    if (su === 'ASO' || /^ASO\\b/.test(su)) return { top: 'ASO', bottom: '' };
    if (su === 'LOTO' || /LOTO|BLOQUEIO/.test(su)) return { top: 'NR', bottom: '10/12' };
    var m = su.match(/NR\\s*-?\\s*(\\d{1,2}(?:\\/\\d{1,2})?)/);
    if (m) {
      var num = m[1];
      if (/SUP|\\+/.test(su)) num += '+';
      return { top: 'NR', bottom: num };
    }
    var d = su.match(/(\\d{1,2}(?:\\/\\d{1,2})?)/);
    if (d) {
      var n = d[1];
      if (/SUP|\\+/.test(su)) n += '+';
      return { top: 'NR', bottom: n };
    }
    return { top: 'NR', bottom: su.replace(/[^A-Z0-9+/]/g, '').slice(0, 5) };
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

  function patchChipsLayout() {
    window.desenharChipsNR = function (ctx, e, x, y, w, h) {
      var docs = (e && e.docs) || {};
      var itens = [];
      Object.keys(docs).forEach(function (s) {
        if (!docs[s]) return;
        var st = typeof window.statusFor === 'function' ? window.statusFor(docs[s]) : 'valido';
        if (st === 'sem_registro') return;
        itens.push({ sigla: s, st: st });
      });
      if (!itens.length) return;
      var cw = 52, ch = 48, gap = 8;
      var porLinha = Math.max(1, Math.floor((w + gap) / (cw + gap)));
      var col = 0, cy = y + 4;
      itens.forEach(function (it) {
        if (col >= porLinha) {
          col = 0;
          cy += ch + 8;
          if (cy + ch > y + h) return;
        }
        var cx = x + col * (cw + gap);
        var rot = rotuloLocal(it.sigla);
        var bg = corSegChip(it.sigla);
        var border = it.st === 'vencido' ? '#e2483a' : (it.st === 'a_vencer' ? '#f2954a' : '#222');
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(cx + 2, cy + 2, cw, ch);
        ctx.fillStyle = bg;
        ctx.strokeStyle = border;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.rect(cx, cy, cw, ch);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#111';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (rot.bottom) {
          ctx.font = '800 12px monospace, Oswald, sans-serif';
          ctx.fillText(rot.top, cx + cw / 2, cy + 14);
          ctx.font = '900 18px monospace, Oswald, sans-serif';
          ctx.fillText(rot.bottom, cx + cw / 2, cy + 34);
        } else {
          ctx.font = '900 16px monospace, Oswald, sans-serif';
          ctx.fillText(rot.top, cx + cw / 2, cy + ch / 2 + 1);
        }
        ctx.textAlign = 'left';
        col += 1;
      });
    };
  }

  function patchHistoricoDelete() {
    var list = document.getElementById('historicoList');
    if (!list || list.__histDelV16) return;
    list.__histDelV16 = true;
    list.addEventListener('click', async function (ev) {
      var btn = ev.target.closest('[data-del-historico]');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      var id = btn.getAttribute('data-del-historico') || btn.dataset.delHistorico;
      if (!id) return;
      if (!confirm('Mover este registro para a lixeira? Da pra restaurar depois.')) return;
      var scrollY = window.scrollY || window.pageYOffset || 0;
      try {
        await window.apiFetch('/api/historico?id=' + encodeURIComponent(id), { method: 'DELETE' });
        if (typeof window.refreshData === 'function') await window.refreshData();
        window.scrollTo(0, scrollY);
        if (typeof window.showToast === 'function') window.showToast('Registro apagado.');
      } catch (err) {
        var msg = (err && err.message) || String(err);
        if (msg === 'nao_encontrado' || msg === 'not_found') {
          try { if (typeof window.refreshData === 'function') await window.refreshData(); } catch (_) {}
          window.scrollTo(0, scrollY);
          if (typeof window.showToast === 'function') window.showToast('Registro atualizado.');
          return;
        }
        if (msg === 'somente_admin') msg = 'Somente administrador pode apagar historico.';
        if (typeof window.showToast === 'function') window.showToast('Nao foi possivel apagar: ' + msg, 'error');
      }
    }, true);
  }

  function patchDataFuncao() {
    if (typeof window.refreshData === 'function' && !window.refreshData.__patchedFuncaoMap) {
      window.refreshData = async function () {
        var scrollY = window.scrollY || window.pageYOffset || 0;
        var openId = window.openEditId;
        var data = await window.apiFetch('/api/data');
        window.CERTS = data.certificados || [];
        window.FOTOS = {};
        (data.fotos || []).forEach(function (f) { window.FOTOS[f.colaborador_id] = f.atualizado_em; });
        window.DATA = (data.colaboradores || []).map(function (e) {
          return { id: e.id, nome: e.nome, notas: e.notas || [], docs: e.docs || {}, funcao: e.funcao || '' };
        });
        window.DOC_TYPES = {};
        (data.docTypes || []).forEach(function (dt) {
          window.DOC_TYPES[dt.sigla] = { cor: dt.cor, nome: dt.nome, desc: dt.descricao };
        });
        if (typeof window.recalcularDocOrder === 'function') window.recalcularDocOrder();
        window.DATA = window.DATA.map(function (e) {
          var docs = {};
          (window.DOC_ORDER || []).forEach(function (s) {
            docs[s] = (s in e.docs) ? e.docs[s] : null;
          });
          return Object.assign({}, e, { docs: docs });
        });
        if (data.config) {
          if (data.config.avisoDias) window.CFG.avisoDias = parseInt(data.config.avisoDias, 10) || 30;
          if (data.config.empresa) window.CFG.empresa = data.config.empresa;
        }
        window.HISTORICO = (data.historico || []).map(function (h) {
          return { id: h.id, ts: h.ts, quem: h.username, acao: h.acao, tipo: h.tipo || 'dados', ip: h.ip };
        });
        window.EMPRESA_ATUAL = data.empresaAtual || null;
        if (data.empresas) window.EMPRESAS_DISPONIVEIS = data.empresas;
        if (typeof window.renderAll === 'function') window.renderAll();
        if (typeof window.renderHistorico === 'function') window.renderHistorico();
        if (typeof window.refreshDocFilterOptions === 'function') window.refreshDocFilterOptions();
        if (typeof window.renderSeletorEmpresa === 'function') window.renderSeletorEmpresa();
        requestAnimationFrame(function () {
          window.scrollTo(0, scrollY);
          if (openId) {
            var el = document.getElementById('fld-nome-' + openId);
            if (el) el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
          }
        });
      };
      window.refreshData.__patchedFuncaoMap = true;
    }
  }

  function injectFuncaoFields() {
    document.querySelectorAll('[id^="fld-nome-"]').forEach(function (nomeInput) {
      var id = nomeInput.id.replace('fld-nome-', '');
      if (!id) return;
      var row = nomeInput.closest('tr') || nomeInput.parentElement;
      if (!row || row.querySelector('[id^="fld-funcao-"]')) return;
      var field = document.createElement('div');
      field.className = 'field';
      field.innerHTML = '<label>Funcao / cargo</label><input type="text" id="fld-funcao-' + id + '" value="" placeholder="ex.: Operador" maxlength="120">';
      var notas = row.querySelector('[id^="fld-notas-"]');
      if (notas && notas.parentElement && notas.parentElement.parentNode) {
        notas.parentElement.parentNode.insertBefore(field, notas.parentElement.nextSibling);
      } else if (nomeInput.parentElement && nomeInput.parentElement.parentNode) {
        nomeInput.parentElement.parentNode.insertBefore(field, nomeInput.parentElement.nextSibling);
      }
      try {
        var colab = (window.DATA || []).find(function (x) { return String(x.id) === String(id); });
        if (colab && colab.funcao) {
          var inp = document.getElementById('fld-funcao-' + id);
          if (inp) inp.value = colab.funcao;
        }
      } catch (_) {}
    });
  }

  function patchSaveEdit() {
    if (typeof window.saveEdit !== 'function' || window.saveEdit.__patchedFuncao) return;
    window.saveEdit = async function (id) {
      var e = (window.DATA || []).find(function (x) { return x.id === id; });
      if (!e) return;
      var nomeField = document.getElementById('fld-nome-' + id);
      var nome = nomeField ? nomeField.value.trim() : (e.nome || '');
      if (!nome) {
        if (nomeField) { nomeField.style.borderColor = 'var(--red)'; nomeField.focus(); }
        if (typeof window.showToast === 'function') window.showToast('Informe o nome do colaborador.');
        return;
      }
      if (nomeField) nomeField.style.borderColor = '';
      var notasRaw = (document.getElementById('fld-notas-' + id) || {}).value || '';
      var notas = String(notasRaw).trim() ? String(notasRaw).trim().split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
      var docs = {};
      (window.DOC_ORDER || []).forEach(function (sigla) {
        var campo = document.getElementById('fld-doc-' + id + '-' + sigla);
        docs[sigla] = campo ? (campo.value || null) : (e.docs[sigla] || null);
      });
      var funcaoInput = document.getElementById('fld-funcao-' + id);
      var funcao = funcaoInput ? String(funcaoInput.value || '').trim().slice(0, 120) : (e.funcao || '');
      var eraNovo = e._novo === true;
      var scrollY = window.scrollY || window.pageYOffset || 0;
      try {
        await window.apiFetch('/api/colaborador', {
          method: 'POST',
          body: JSON.stringify({ id: eraNovo ? null : id, nome: nome, notas: notas, docs: docs, funcao: funcao })
        });
        if (window.CAMPOS_EXTRA) delete window.CAMPOS_EXTRA[id];
        window.openEditId = null;
        if (typeof window.refreshData === 'function') await window.refreshData();
        window.scrollTo(0, scrollY);
        if (typeof window.showToast === 'function') window.showToast('Colaborador salvo.');
      } catch (err) {
        if (typeof window.showToast === 'function') window.showToast('Nao foi possivel salvar: ' + ((err && err.message) || err), 'error');
      }
    };
    window.saveEdit.__patchedFuncao = true;
  }

  function showVersionBadge() {
    var el = document.getElementById('patch-version-badge');
    if (!el) {
      el = document.createElement('div');
      el.id = 'patch-version-badge';
      el.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:99999;font-size:10px;opacity:0.55;background:#111;color:#9f9;padding:2px 6px;border-radius:4px;pointer-events:none;';
      document.body.appendChild(el);
    }
    el.textContent = 'patch v16';
  }

  function boot() {
    showVersionBadge();
    patchChipsLayout();
    patchDataFuncao();
    patchSaveEdit();
    injectFuncaoFields();
    patchHistoricoDelete();
    var tbody = document.getElementById('tableBody');
    if (tbody && !tbody.__batchObs) {
      tbody.__batchObs = true;
      new MutationObserver(function () {
        injectFuncaoFields();
        patchHistoricoDelete();
        patchSaveEdit();
      }).observe(tbody, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setTimeout(boot, 400);
  setTimeout(boot, 1200);
  setTimeout(boot, 2500);
})();
