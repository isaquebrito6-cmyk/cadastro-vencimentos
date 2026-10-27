/* Escanear lista de colaboradores: câmera/foto → recorte automático (ajustável) → OCR no aparelho → texto para a importação.
   Tudo roda no navegador; nada é enviado para fora. O OCR (Tesseract) fica em /ocr/ e só é baixado na primeira vez. */
(function(){
  'use strict';
  const MAX_LADO = 2600;           // lado maior da imagem de trabalho
  let stream = null, imgCanvas = null, crop = null, rawTexto = '', ocrWorker = null, arrasto = null;

  const $ = id => document.getElementById(id);

  function montarModal(){
    if($('scanModal')) return;
    const d = document.createElement('div');
    d.id = 'scanModal';
    d.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:260;align-items:center;justify-content:center;padding:10px;';
    d.innerHTML = `
    <div style="width:100%;max-width:760px;max-height:96vh;overflow-y:auto;background:var(--bg-panel);border:1px solid var(--line);border-radius:6px;padding:18px;">
      <h2 style="font-family:'Oswald',sans-serif;font-size:17px;font-weight:600;margin:0 0 6px;">📷 Escanear lista de colaboradores</h2>
      <p id="scanDica" style="font-size:12px;color:var(--text-dim);margin:0 0 10px;line-height:1.5;">Fotografe a lista (folha inteira, bem iluminada e sem sombra). O sistema recorta só o papel, lê os nomes e as datas e deixa tudo para você conferir antes de importar.</p>

      <div id="scanCaptura">
        <video id="scanVideo" playsinline muted style="width:100%;max-height:60vh;background:#000;border-radius:6px;display:none;"></video>
        <div id="scanCamErro" style="font-size:12px;color:var(--text-dim);margin:6px 0;"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
          <button class="btn primary" id="scanCapturar" style="display:none;">📸 Capturar</button>
          <label class="btn primary" for="scanArquivo" style="cursor:pointer;">🖼 Tirar foto / escolher imagem</label>
          <input type="file" id="scanArquivo" accept="image/*" capture="environment" style="display:none;">
          <button class="btn ghost" id="scanFechar1" style="margin-left:auto;">Cancelar</button>
        </div>
      </div>

      <div id="scanRecorte" style="display:none;">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">Arraste os cantos para ajustar o recorte (só a parte com a lista).</div>
        <div id="scanPalco" style="position:relative;touch-action:none;user-select:none;line-height:0;background:#000;border-radius:6px;overflow:hidden;">
          <canvas id="scanCanvas" style="width:100%;height:auto;display:block;"></canvas>
          <div id="scanCaixa" style="position:absolute;border:2px solid #f5b400;box-shadow:0 0 0 9999px rgba(0,0,0,.55);pointer-events:none;"></div>
          <div class="scan-al" data-c="tl"></div><div class="scan-al" data-c="tr"></div><div class="scan-al" data-c="bl"></div><div class="scan-al" data-c="br"></div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
          <button class="btn" id="scanGirar">↻ Girar</button>
          <button class="btn" id="scanAuto">✂ Recorte automático</button>
          <button class="btn" id="scanRefazer">↺ Outra foto</button>
          <button class="btn primary" id="scanLer" style="margin-left:auto;">🔍 Ler texto</button>
        </div>
      </div>

      <div id="scanResultado" style="display:none;">
        <div id="scanProg" style="font-size:12px;color:var(--text-dim);margin-bottom:6px;"></div>
        <div style="height:6px;background:#2a3038;border-radius:3px;overflow:hidden;margin-bottom:10px;"><div id="scanBarra" style="height:100%;width:0;background:var(--yellow,#f5b400);transition:width .2s;"></div></div>
        <div id="scanCorpo" style="display:none;">
          <div class="field" style="margin-bottom:8px;">
            <label for="scanDocPadrao">As datas da lista são de qual documento?</label>
            <select id="scanDocPadrao" style="width:100%;"></select>
          </div>
          <div class="field" style="margin-bottom:8px;">
            <label for="scanCsv">Resultado (confira e corrija aqui; uma pessoa por linha: Nome;data;data…)</label>
            <textarea id="scanCsv" rows="9" style="width:100%;resize:vertical;font-family:monospace;font-size:13px;"></textarea>
          </div>
          <div id="scanAvisos" style="font-size:12px;line-height:1.5;margin-bottom:8px;"></div>
          <details style="margin-bottom:8px;"><summary style="cursor:pointer;font-size:12px;color:var(--text-dim);">Ver texto bruto lido da imagem</summary><pre id="scanBruto" style="white-space:pre-wrap;font-size:12px;max-height:160px;overflow:auto;margin:6px 0 0;"></pre></details>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn" id="scanVoltar">← Ajustar recorte</button>
            <button class="btn" id="scanOutra">＋ Outra página</button>
            <button class="btn primary" id="scanUsar" style="margin-left:auto;">✔ Usar na importação</button>
          </div>
        </div>
      </div>
    </div>`;
    document.body.appendChild(d);
    const st = document.createElement('style');
    st.textContent = '.scan-al{position:absolute;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;background:#f5b400;border:3px solid #111;box-sizing:border-box;touch-action:none;cursor:grab;}';
    document.head.appendChild(st);

    $('scanFechar1').addEventListener('click', fechar);
    $('scanArquivo').addEventListener('change', async ev => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; if(f) await carregarArquivo(f); });
    $('scanCapturar').addEventListener('click', capturarQuadro);
    $('scanRefazer').addEventListener('click', () => { mostrar('scanCaptura'); iniciarCamera(); });
    $('scanGirar').addEventListener('click', girar);
    $('scanAuto').addEventListener('click', () => { crop = detectarPapel(imgCanvas); desenharCrop(); });
    $('scanLer').addEventListener('click', lerTexto);
    $('scanVoltar').addEventListener('click', () => mostrar('scanRecorte'));
    $('scanOutra').addEventListener('click', () => { acumulado = ($('scanCsv').value || '').trim(); mostrar('scanCaptura'); iniciarCamera(); });
    $('scanUsar').addEventListener('click', usarNaImportacao);
    $('scanDocPadrao').addEventListener('change', () => reinterpretar());
    const palco = $('scanPalco');
    palco.addEventListener('pointerdown', ev => {
      const al = ev.target.closest('.scan-al'); if(!al) return;
      arrasto = al.dataset.c; palco.setPointerCapture(ev.pointerId); ev.preventDefault();
    });
    palco.addEventListener('pointermove', ev => { if(arrasto) moverAlca(ev); });
    palco.addEventListener('pointerup', () => { arrasto = null; });
    palco.addEventListener('pointercancel', () => { arrasto = null; });
  }
  let acumulado = '';

  function mostrar(qual){
    ['scanCaptura','scanRecorte','scanResultado'].forEach(id => { $(id).style.display = id === qual ? '' : 'none'; });
    if(qual !== 'scanCaptura') pararCamera();
  }

  /* ---------- câmera ---------- */
  async function iniciarCamera(){
    const v = $('scanVideo'), erro = $('scanCamErro'), bt = $('scanCapturar');
    erro.textContent = ''; v.style.display = 'none'; bt.style.display = 'none';
    if(!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)){ erro.textContent = 'Câmera ao vivo indisponível neste navegador: use "Tirar foto / escolher imagem".'; return; }
    try{
      pararCamera();
      stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: 'environment'}, width: {ideal: 2560}, height: {ideal: 1920}}, audio: false});
      v.srcObject = stream; await v.play(); v.style.display = 'block'; bt.style.display = '';
    }catch(err){
      erro.textContent = 'Não consegui abrir a câmera (' + (err && err.name === 'NotAllowedError' ? 'permissão negada' : (err && err.name) || 'erro') + '). Use "Tirar foto / escolher imagem" — no celular isso abre a câmera.';
    }
  }
  function pararCamera(){ if(stream){ stream.getTracks().forEach(t => t.stop()); stream = null; } const v = $('scanVideo'); if(v) v.srcObject = null; }
  function capturarQuadro(){
    const v = $('scanVideo'); if(!v.videoWidth) return;
    definirImagem(v, v.videoWidth, v.videoHeight);
  }
  async function carregarArquivo(file){
    try{
      const url = URL.createObjectURL(file);
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('imagem_invalida')); i.src = url; });
      definirImagem(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
    }catch(err){ $('scanCamErro').textContent = 'Não consegui abrir essa imagem.'; }
  }
  function definirImagem(fonte, w, h){
    const r = Math.min(1, MAX_LADO / Math.max(w, h));
    const c = document.createElement('canvas'); c.width = Math.round(w * r); c.height = Math.round(h * r);
    c.getContext('2d').drawImage(fonte, 0, 0, c.width, c.height);
    imgCanvas = c; crop = detectarPapel(c);
    mostrar('scanRecorte'); desenharCrop();
  }
  function girar(){
    const c = document.createElement('canvas'); c.width = imgCanvas.height; c.height = imgCanvas.width;
    const x = c.getContext('2d'); x.translate(c.width, 0); x.rotate(Math.PI / 2); x.drawImage(imgCanvas, 0, 0);
    imgCanvas = c; crop = detectarPapel(c); desenharCrop();
  }

  /* ---------- recorte automático ---------- */
  // Papel = região clara. Projeta os pixels claros em linhas e colunas e pega o maior trecho contínuo.
  function detectarPapel(c){
    const esc = Math.min(1, 420 / Math.max(c.width, c.height));
    const w = Math.max(8, Math.round(c.width * esc)), h = Math.max(8, Math.round(c.height * esc));
    const t = document.createElement('canvas'); t.width = w; t.height = h;
    const tx = t.getContext('2d', {willReadFrequently: true}); tx.drawImage(c, 0, 0, w, h);
    const d = tx.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h), hist = new Array(256).fill(0);
    for(let i = 0; i < w * h; i++){ const v = (d[i*4] * 0.299 + d[i*4+1] * 0.587 + d[i*4+2] * 0.114) | 0; g[i] = v; hist[v]++; }
    // limiar de Otsu
    let soma = 0; for(let i = 0; i < 256; i++) soma += i * hist[i];
    let sB = 0, wB = 0, melhor = 0, lim = 128; const tot = w * h;
    for(let i = 0; i < 256; i++){ wB += hist[i]; if(!wB) continue; const wF = tot - wB; if(!wF) break; sB += i * hist[i];
      const mB = sB / wB, mF = (soma - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if(v > melhor){ melhor = v; lim = i; } }
    const lin = new Float32Array(h), col = new Float32Array(w);
    for(let y = 0; y < h; y++) for(let x = 0; x < w; x++) if(g[y*w+x] > lim){ lin[y]++; col[x]++; }
    for(let y = 0; y < h; y++) lin[y] /= w; for(let x = 0; x < w; x++) col[x] /= h;
    const faixa = (arr, minimo) => {            // maior trecho contínuo com densidade >= minimo
      let ini = -1, bI = 0, bF = arr.length - 1, bL = 0;
      for(let i = 0; i <= arr.length; i++){
        const ok = i < arr.length && arr[i] >= minimo;
        if(ok && ini < 0) ini = i;
        if(!ok && ini >= 0){ if(i - ini > bL){ bL = i - ini; bI = ini; bF = i - 1; } ini = -1; }
      }
      return bL ? [bI, bF] : [0, arr.length - 1];
    };
    const [y0, y1] = faixa(lin, 0.30), [x0, x1] = faixa(col, 0.30);
    let r = {x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h};
    if((r.x1 - r.x0) < 0.25 || (r.y1 - r.y0) < 0.25) r = {x0: 0.02, y0: 0.02, x1: 0.98, y1: 0.98};   // não achou papel: quase a imagem toda
    const m = 0.008;
    return {x0: Math.max(0, r.x0 - m), y0: Math.max(0, r.y0 - m), x1: Math.min(1, r.x1 + m), y1: Math.min(1, r.y1 + m)};
  }

  function desenharCrop(){
    const cv = $('scanCanvas'); cv.width = imgCanvas.width; cv.height = imgCanvas.height;
    cv.getContext('2d').drawImage(imgCanvas, 0, 0);
    const cx = $('scanCaixa'), p = (v, t) => (v * 100) + '%';
    cx.style.left = p(crop.x0); cx.style.top = p(crop.y0); cx.style.width = ((crop.x1 - crop.x0) * 100) + '%'; cx.style.height = ((crop.y1 - crop.y0) * 100) + '%';
    const pos = {tl: [crop.x0, crop.y0], tr: [crop.x1, crop.y0], bl: [crop.x0, crop.y1], br: [crop.x1, crop.y1]};
    document.querySelectorAll('.scan-al').forEach(a => { const q = pos[a.dataset.c]; a.style.left = (q[0] * 100) + '%'; a.style.top = (q[1] * 100) + '%'; });
  }
  function moverAlca(ev){
    const r = $('scanPalco').getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), fy = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)), min = 0.08;
    if(arrasto[0] === 't') crop.y0 = Math.min(fy, crop.y1 - min); else crop.y1 = Math.max(fy, crop.y0 + min);
    if(arrasto[1] === 'l') crop.x0 = Math.min(fx, crop.x1 - min); else crop.x1 = Math.max(fx, crop.x0 + min);
    desenharCrop();
  }

  /* ---------- pré-processamento (melhora muito o OCR de foto de papel) ---------- */
  function prepararParaOCR(){
    const sx = Math.round(crop.x0 * imgCanvas.width), sy = Math.round(crop.y0 * imgCanvas.height);
    const sw = Math.max(16, Math.round((crop.x1 - crop.x0) * imgCanvas.width)), sh = Math.max(16, Math.round((crop.y1 - crop.y0) * imgCanvas.height));
    const alvoW = Math.min(2600, Math.max(1700, sw)), r = alvoW / sw;
    const c = document.createElement('canvas'); c.width = Math.round(sw * r); c.height = Math.round(sh * r);
    const x = c.getContext('2d', {willReadFrequently: true}); x.imageSmoothingQuality = 'high';
    x.drawImage(imgCanvas, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const im = x.getImageData(0, 0, c.width, c.height), d = im.data, W = c.width, H = c.height, g = new Uint8Array(W * H);
    for(let i = 0; i < W * H; i++) g[i] = (d[i*4] * 0.299 + d[i*4+1] * 0.587 + d[i*4+2] * 0.114) | 0;
    // limiar local (média da vizinhança via imagem integral): tira sombra e iluminação desigual
    const I = new Float64Array((W + 1) * (H + 1));
    for(let y = 1; y <= H; y++){ let lin = 0; for(let xx = 1; xx <= W; xx++){ lin += g[(y-1)*W + xx-1]; I[y*(W+1) + xx] = I[(y-1)*(W+1) + xx] + lin; } }
    const j = Math.max(10, Math.round(W / 24));
    for(let y = 0; y < H; y++){
      const y0 = Math.max(0, y - j), y1 = Math.min(H, y + j + 1);
      for(let xx = 0; xx < W; xx++){
        const x0 = Math.max(0, xx - j), x1 = Math.min(W, xx + j + 1);
        const area = (x1 - x0) * (y1 - y0);
        const s = I[y1*(W+1) + x1] - I[y0*(W+1) + x1] - I[y1*(W+1) + x0] + I[y0*(W+1) + x0];
        const v = g[y*W + xx] < (s / area) * 0.90 ? 0 : 255;
        const k = (y*W + xx) * 4; d[k] = d[k+1] = d[k+2] = v; d[k+3] = 255;
      }
    }
    x.putImageData(im, 0, 0);
    return c;
  }

  /* ---------- OCR ---------- */
  function progresso(txt, pct){ $('scanProg').textContent = txt; if(pct != null) $('scanBarra').style.width = Math.round(pct * 100) + '%'; }
  async function carregarTesseract(){
    if(window.Tesseract) return;
    await new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/ocr/tesseract.min.js'; s.onload = ok; s.onerror = () => no(new Error('Não consegui carregar o leitor de texto (sem internet?).')); document.head.appendChild(s); });
  }
  async function obterWorker(){
    if(ocrWorker) return ocrWorker;
    await carregarTesseract();
    progresso('Preparando o leitor de texto (na primeira vez baixa cerca de 6 MB)…', 0.05);
    ocrWorker = await Tesseract.createWorker('por', 1, {
      workerPath: '/ocr/worker.min.js', corePath: '/ocr/', langPath: '/ocr', gzip: true,
      logger: m => {
        if(m.status === 'recognizing text') progresso('Lendo o texto da imagem… ' + Math.round(m.progress * 100) + '%', 0.2 + m.progress * 0.75);
        else if(/loading|initializ/.test(m.status || '')) progresso('Preparando o leitor de texto…', 0.05 + (m.progress || 0) * 0.15);
      },
    });
    await ocrWorker.setParameters({tessedit_pageseg_mode: '6', preserve_interword_spaces: '1'});
    return ocrWorker;
  }
  async function lerTexto(){
    mostrar('scanResultado'); $('scanCorpo').style.display = 'none'; progresso('Ajustando a imagem…', 0.02);
    try{
      const c = prepararParaOCR();
      const w = await obterWorker();
      progresso('Lendo o texto da imagem…', 0.2);
      const r = await w.recognize(c);
      rawTexto = (r && r.data && r.data.text) || '';
      progresso('Pronto. Confira o resultado abaixo.', 1);
      montarSeletorDoc();
      $('scanBruto').textContent = rawTexto;
      $('scanCorpo').style.display = '';
      reinterpretar();
    }catch(err){
      progresso('Não foi possível ler: ' + (err && err.message || err), 0);
      $('scanCorpo').style.display = '';
      $('scanCsv').value = acumulado;
    }
  }

  /* ---------- interpretação: texto → "Nome;data;data" ---------- */
  function montarSeletorDoc(){
    const sel = $('scanDocPadrao'), atual = sel.value;
    const docs = (typeof DOC_ORDER !== 'undefined' ? DOC_ORDER : ['ASO']);
    sel.innerHTML = '<option value="">Detectar pelo cabeçalho da lista (se houver)</option>' + docs.map(s => `<option value="${escapeHTML(s)}">${escapeHTML(s)}</option>`).join('');
    if(atual) sel.value = atual;
  }
  function limparDigitos(tok){ return tok.replace(/[OoQD]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/B/g, '8'); }
  function achaDatas(linha){
    const datas = []; let resto = linha;
    // tokens parecidos com data, tolerando confusões do OCR (O→0, l→1…)
    resto = resto.replace(/[0-9OoIl|SBQD]{1,2}\s*[\/.\-,]\s*[0-9OoIl|SBQD]{1,2}\s*[\/.\-,]\s*[0-9OoIl|SBQD]{2,4}/g, tok => {
      const m = limparDigitos(tok).match(/(\d{1,2})\s*[\/.\-,]\s*(\d{1,2})\s*[\/.\-,]\s*(\d{2,4})/);
      if(m){ let a = parseInt(m[3], 10); if(m[3].length === 2) a += 2000;
        const dd = parseInt(m[1], 10), mm = parseInt(m[2], 10);
        const ok = a >= 2000 && a <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= new Date(a, mm, 0).getDate();
        datas.push(ok ? String(dd).padStart(2, '0') + '/' + String(mm).padStart(2, '0') + '/' + a : null);
      }
      return ' ';
    });
    return {datas, resto};
  }
  function lev(a, b){
    const m = a.length, n = b.length; if(Math.abs(m - n) > 4) return 99;
    let p = Array.from({length: n + 1}, (_, i) => i);
    for(let i = 1; i <= m; i++){ const q = [i]; for(let j = 1; j <= n; j++) q[j] = Math.min(p[j] + 1, q[j-1] + 1, p[j-1] + (a[i-1] === b[j-1] ? 0 : 1)); p = q; }
    return p[n];
  }
  function ajustarAoCadastro(nome){
    if(typeof DATA === 'undefined' || typeof chaveNome !== 'function') return {nome, ajustou: false};
    const k = chaveNome(nome); let melhor = null, dm = 99, empate = false;
    for(const e of DATA){
      const ke = chaveNome(e.nome);
      if(ke === k) return {nome: e.nome, ajustou: e.nome.toUpperCase() !== nome.toUpperCase()};
      const dd = lev(k, ke);
      if(dd < dm){ dm = dd; melhor = e; empate = false; } else if(dd === dm) empate = true;
    }
    const limite = Math.max(1, Math.min(3, Math.floor(k.length * 0.12)));
    if(melhor && !empate && dm <= limite) return {nome: melhor.nome, ajustou: true};
    return {nome, ajustou: false};
  }
  const RUIDO = /^(lista|relacao|relação|empresa|pagina|página|nome|data|assinatura|obra|setor|funcao|função|cargo|colaboradores?|treinamento|visto|rg|cpf)\b/i;
  function interpretar(texto, docPadrao){
    const linhas = String(texto || '').split(/\r?\n/).map(l => l.replace(/[|_—–;\t]+/g, ' ').replace(/[ ]{2,}/g, ' ').trim()).filter(Boolean);
    let cols = [];                          // cabeçalho detectado
    const linhasNome = [];
    const re = /\b(ASO|LOTO|NR\s*-?\s*\d{1,2}(?:\s*\/\s*\d{1,2})?)\b/gi;
    for(const l of linhas){
      const {datas, resto} = achaDatas(l);
      const ids = (resto.match(re) || []).map(s => s.toUpperCase().replace(/\s+/g, '').replace(/^NR-?/, 'NR-'));
      if(!datas.length && ids.length >= 2 && !cols.length){ cols = ids; continue; }     // linha de cabeçalho
      let nome = resto.replace(/^[\s\d.\-)\]]+/, '')                                // número de ordem
        .replace(/[^A-Za-zÀ-ÿ'´`\s]/g, ' ').replace(/\s{2,}/g, ' ').trim();
      const palavras = nome.split(' ').filter(p => p.length >= 2 || /^[eE]$/.test(p));
      if(palavras.length < 2 || nome.length < 5) continue;
      if(!datas.length && RUIDO.test(nome)) continue;
      if(RUIDO.test(nome) && palavras.length <= 3) continue;
      linhasNome.push({nome: palavras.join(' ').toUpperCase(), datas});
    }
    const avisos = []; let ajustados = 0, datasRuins = 0, semColuna = 0;
    // colunas de data
    const maxDatas = linhasNome.reduce((m, r) => Math.max(m, r.datas.length), 0);
    let header = [];
    if(docPadrao){ header = [docPadrao]; }
    else if(cols.length && maxDatas){ header = cols.slice(0, Math.max(maxDatas, 1)); }
    const saida = [];
    for(const r of linhasNome){
      const aj = ajustarAoCadastro(r.nome); if(aj.ajustou) ajustados++;
      const celulas = [aj.nome];
      if(header.length){
        // com cabeçalho/doc escolhido: usa as datas na ordem (ou só a primeira, quando é um documento só)
        header.forEach((_, i) => { const v = r.datas[i]; if(v === null) datasRuins++; celulas.push(v || ''); });
      } else if(r.datas.length) semColuna++;
      saida.push(celulas.join(';'));
    }
    const cab = ['Nome'].concat(header);
    const csv = linhasNome.length ? cab.join(';') + '\n' + saida.join('\n') : '';
    if(!linhasNome.length) avisos.push({t: 'Não encontrei nomes. Tente uma foto mais nítida, com a folha inteira e sem sombra, ou ajuste o recorte.', c: 'var(--red,#e5484d)'});
    else avisos.push({t: `${linhasNome.length} nome(s) encontrado(s).`, c: 'var(--green,#3fb950)'});
    if(ajustados) avisos.push({t: `${ajustados} nome(s) corrigido(s) pelo cadastro (grafia muito parecida com um colaborador já cadastrado).`, c: 'var(--text-dim)'});
    if(semColuna) avisos.push({t: `Há datas na lista, mas não achei o cabeçalho (ASO, NR-35…). Escolha acima a que documento elas pertencem.`, c: 'var(--yellow,#f5b400)'});
    if(datasRuins) avisos.push({t: `${datasRuins} data(s) ilegível(is) ficaram em branco — complete na caixa acima.`, c: 'var(--yellow,#f5b400)'});
    if(header.length > 1 && cols.length && header.some(h => h && !/^(ASO|LOTO|NR-\d+(\/\d+)?)$/.test(h))) avisos.push({t: 'Confira os nomes das colunas na primeira linha do resultado.', c: 'var(--text-dim)'});
    return {csv, avisos};
  }
  function reinterpretar(){
    const r = interpretar(rawTexto, $('scanDocPadrao').value);
    $('scanCsv').value = (acumulado ? acumulado + '\n' : '') + r.csv;
    $('scanAvisos').innerHTML = r.avisos.map(a => `<div style="color:${a.c}">• ${escapeHTML(a.t)}</div>`).join('');
  }

  function usarNaImportacao(){
    const txt = $('scanCsv').value.trim();
    if(!txt){ if(typeof showToast === 'function') showToast('Nada para importar ainda.', 'error'); return; }
    fechar();
    if($('importModal').style.display !== 'flex' && typeof abrirImport === 'function') abrirImport();
    IMPORT_XLSX = null;
    $('importTexto').value = txt;
    $('importArquivoNome').textContent = '📷 Lista escaneada (confira a prévia abaixo)';
    renderPreviaImport();
    $('importTexto').scrollIntoView({block: 'center'});
  }

  function fechar(){ pararCamera(); const m = $('scanModal'); if(m) m.style.display = 'none'; }
  async function abrir(){
    montarModal(); acumulado = ''; rawTexto = '';
    $('scanModal').style.display = 'flex'; mostrar('scanCaptura'); iniciarCamera();
  }

  window.abrirScannerLista = abrir;
  window.__scanner = {interpretar, detectarPapel};   // usado nos testes
})();
