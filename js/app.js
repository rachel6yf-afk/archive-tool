import * as db from './db.js';
import { extractDates, displayKey, precisionOf, makeKey } from './dates.js';
import { buildThemes, toSimplified, parseQuery, matchesAll, snippets, highlight, escapeHtml as esc, normalize, splitSentences } from './text.js';
import { OcrPool, LANGS, cleanText, preprocess, canvasToBlob, lowConfidenceWords } from './ocr.js';
import { openVisual, extractDocument, isImageLike, isDocLike, titleFromName, ext } from './importers.js';
import { download, safeName, exportBlocks, rowsToCsv, rowsToXlsx, blobToDataURL, dataURLToBlob } from './exporters.js';
import { getAI, setAI, aiEnabled, chat } from './ai.js';
import { getGemini, setGemini, geminiModel, geminiReady, ocrCanvas, testGemini, listModels, modelEvents, GEMINI_MODELS } from './gemini.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const S = { items: new Map(), notes: new Map(), timeline: new Map(), dismissed: new Set(), meta: {}, themes: null, libMode: 'grid', page: {}, currentNote: null };
const TYPE_LABEL = { image: '图像', pdf: 'PDF', tiff: 'TIFF', heic: 'HEIC', docx: 'Word', doc: 'Word(旧)', odt: 'ODT', xlsx: 'Excel', csv: 'CSV', txt: '文本', note: '笔记' };
const OCR_TYPES = ['image', 'pdf', 'tiff', 'heic'];
window.__archive = S; // for debugging/tests

// ---------- utilities ----------
function toast(msg, ms = 2600) { const t = $('#toast'); t.innerHTML = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
const urls = new WeakMap();
function blobUrl(b) { if (!b) return ''; if (!urls.has(b)) urls.set(b, URL.createObjectURL(b)); return urls.get(b); }
const itemText = (it) => (it.pages || []).map((p) => p.text || '').join('\n\n').trim();
const fmtTime = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false });
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
const parseTags = (s) => [...new Set(String(s || '').split(/[,，;；、]/).map((t) => t.trim()).filter(Boolean))];
const debounceMap = new Map();
function debounce(key, fn, ms = 500) { clearTimeout(debounceMap.get(key)); debounceMap.set(key, setTimeout(fn, ms)); }
function confClass(c) { return c == null ? 'na' : c >= 85 ? 'good' : c >= 65 ? 'fair' : 'low'; }
function itemConf(it) { const cs = (it.pages || []).map((p) => p.confidence).filter((c) => c != null); return cs.length ? Math.round(cs.reduce((a, b) => a + b, 0) / cs.length) : null; }
function allTags() { const m = new Map(); for (const it of S.items.values()) for (const t of it.tags || []) m.set(t, (m.get(t) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); }
function itemDateKeys(it) {
  const keys = new Set();
  for (const d of extractDates(it.dates || '')) keys.add(d.key);
  for (const y of String(it.dates || '').match(/\b(1[0-9]\d\d|20\d\d)\b/g) || []) keys.add(y);
  for (const e of S.timeline.values()) if (e.itemId === it.id) keys.add(e.key);
  return [...keys].sort();
}
function inRange(keys, from, to) {
  if (!from && !to) return true;
  return keys.some((k) => (!from || k >= from || from.startsWith(k)) && (!to || k.slice(0, to.length) <= to));
}
async function saveItem(it, immediate = false) {
  it.updatedAt = Date.now();
  S.items.set(it.id, it);
  if (immediate) return db.put('items', it);
  debounce('item-' + it.id, () => db.put('items', it), 400);
}
async function saveMeta(key, value) { S.meta[key] = value; await db.put('meta', { key, value }); }

// ---------- OCR settings ----------
const OCR_DEFAULT = { langs: ['chi_sim', 'eng'], vertical: false, psm: 3, pool: Math.max(1, Math.min(2, Math.floor((navigator.hardwareConcurrency || 2) / 2))), gray: true, upscale: true, contrast: false, threshold: false, invert: false, scale: 2.5, pdfText: true, engineChoice: 'auto', fallback: true };
// Engine: an explicit user choice ('tesseract' | 'gemini') persists and wins; otherwise ('auto') Gemini is the default
// whenever a Gemini key is saved, and Tesseract (fully local) when there is no key.
function getOcr() {
  let o; try { o = { ...OCR_DEFAULT, ...JSON.parse(localStorage.getItem('archive-ocr.ocr')) }; } catch { o = { ...OCR_DEFAULT }; }
  if (o.engine && !o.engineChoice) o.engineChoice = o.engine; // settings saved by an earlier version
  o.engine = o.engineChoice === 'gemini' || o.engineChoice === 'tesseract' ? o.engineChoice : (geminiReady() ? 'gemini' : 'tesseract');
  return o;
}
function setOcr(o) { const { engine, ...rest } = o; localStorage.setItem('archive-ocr.ocr', JSON.stringify(rest)); }
function effectiveLangs(o) {
  let langs = o.langs.length ? [...o.langs] : ['chi_sim'];
  // Vertical mode: use only the vertical Chinese models (Latin models confuse vertical column segmentation).
  if (o.vertical) { const v = langs.filter((l) => l === 'chi_sim' || l === 'chi_tra').map((l) => l + '_vert'); return v.length ? v : ['chi_sim_vert']; }
  return langs;
}
function initOcrSettings() {
  const o = getOcr();
  $('#langChips').innerHTML = LANGS.map(([c, n]) => `<label class="chip"><input type="checkbox" value="${c}" ${o.langs.includes(c) ? 'checked' : ''}><span>${n}</span></label>`).join('');
  $('#optVertical').checked = o.vertical; $('#optPsm').value = String(o.psm); $('#optPool').value = String(o.pool);
  for (const k of ['gray', 'upscale', 'contrast', 'threshold', 'invert']) $('#opt' + k[0].toUpperCase() + k.slice(1)).checked = o[k];
  $('#optScale').value = String(o.scale); $('#optPdfText').checked = o.pdfText;
  $('#optFallback').checked = o.fallback;
  const read = (e) => {
    const prev = getOcr();
    const n = {
      langs: $$('#langChips input:checked').map((i) => i.value), vertical: $('#optVertical').checked, psm: +$('#optPsm').value, pool: +$('#optPool').value,
      gray: $('#optGray').checked, upscale: $('#optUpscale').checked, contrast: $('#optContrast').checked, threshold: $('#optThreshold').checked, invert: $('#optInvert').checked,
      scale: +$('#optScale').value, pdfText: $('#optPdfText').checked,
      engineChoice: e?.target?.name === 'engine' ? e.target.value : prev.engineChoice, fallback: $('#optFallback').checked,
    };
    setOcr(n); applyEngineUI();
  };
  $('#view-import .settings-card').addEventListener('change', (e) => {
    if (e.target.id === 'optVertical') $('#optPsm').value = e.target.checked ? '5' : '3';
    read(e);
  });
  applyEngineUI();
}
function applyEngineUI() {
  const o = getOcr(), gem = o.engine === 'gemini';
  $(gem ? '#engGem' : '#engTess').checked = true;
  document.body.classList.toggle('engine-gemini', gem);
  const note = $('#engNote'); note.hidden = !gem && geminiReady();
  if (!gem) note.innerHTML = o.engineChoice === 'auto'
    ? '提示：在 <a href="#/settings">设置 → Gemini</a> 中添加 Gemini API Key 后，新导入的材料将默认使用更准确的 Gemini 云端识别（页面图像会发送至 Google）。不添加则始终在本机用 Tesseract 识别。'
    : '已选择 Tesseract 本地识别：文件不会离开本机。';
  else note.innerHTML = geminiReady()
    ? `将使用 <b>${esc(geminiModel())}</b> 识别。<b>页面图像会发送至 Google</b>；同时最多 ${getGemini().concurrency} 个请求。<a href="#/settings">Gemini 设置 ›</a>`
    : `<span class="warn">尚未设置 Gemini API Key。</span> 请先到 <a href="#/settings">设置 → Gemini</a> 填写密钥${o.fallback ? '；在此之前将自动改用 Tesseract。' : '。'}`;
  $('#privacyText').textContent = gem ? 'Gemini 云端识别已开启' : '仅在本机处理';
  $('#privacy').classList.toggle('cloud', gem);
  $('#privacy').title = gem ? '当前识别引擎为 Gemini：页面图像会发送至 Google 服务器识别。档案库、笔记等数据仍只保存在本机。' : '所有处理均在本机浏览器内完成，文件不会上传';
}
const langNamesFor = (cfg) => { const m = new Map(LANGS); return (cfg.langs.length ? cfg.langs : ['chi_sim']).map((l) => m.get(l) || l); };
const runnersFor = (cfg, engine = cfg.engine) => engine === 'gemini' ? Math.max(cfg.pool, +getGemini().concurrency || 2) : cfg.pool;
function ocrInfo(cfg, engine = cfg.engine) { return { engine, model: engine === 'gemini' ? geminiModel() : 'tesseract', langs: effectiveLangs(cfg), psm: cfg.psm }; }

// ---------- processing queue ----------
const pool = new OcrPool();
let poolLock = Promise.resolve();
const Q = { tasks: [], running: 0, rows: new Map(), total: 0, done: 0 };
function configurePool(cfg) { poolLock = poolLock.then(() => pool.configure({ langs: effectiveLangs(cfg), psm: cfg.psm, size: cfg.pool })); return poolLock; }

function queueRow(it, file) {
  if ($('#queueList .empty')) $('#queueList').innerHTML = '';
  Q.rows.get(it.id)?.remove();
  const li = document.createElement('li');
  li.dataset.id = it.id;
  li.innerHTML = `<span class="qname">${esc(file.name)}</span><span class="qstatus muted small">排队中</span><div class="bar"><span></span></div><a class="small" href="#/item/${it.id}">查看</a>`;
  $('#queueList').prepend(li);
  Q.rows.set(it.id, li);
}
function updateRow(it) {
  const li = Q.rows.get(it.id); if (!li) return;
  const pages = it.pages || [];
  const prog = pages.length ? pages.reduce((s, p) => s + (p.status === 'done' || p.status === 'error' ? 1 : p.progress || 0), 0) / pages.length : 0;
  $('.bar span', li).style.width = Math.round((it.status === 'done' ? 1 : prog) * 100) + '%';
  const doneN = pages.filter((p) => p.status === 'done').length;
  const c = itemConf(it);
  const errs = pages.filter((p) => p.status === 'error' || p.lastError), fb = pages.filter((p) => p.fallbackFrom).length;
  const gem = pages.some((p) => p.engine === 'gemini');
  const live = pages.find((p) => p.statusText)?.statusText;
  const extra = (gem ? ' · <span class="conf gem">引擎：Gemini</span>' : '') + (fb ? ` · <span class="warn" title="${esc(pages.find((p) => p.fallbackFrom).engineError || '')}">${fb} 页已改用 Tesseract</span>` : '') + (errs.length && it.status !== 'error' ? ` · <span class="err">${errs.length} 页失败：${esc(errs[0].error || errs[0].lastError || '')}</span>` : '');
  $('.qstatus', li).innerHTML = it.status === 'error' ? `<span class="err">失败：${esc(it.error || '')}</span>` : it.status === 'done' ? `完成 · ${pages.length} 页` + (c != null ? ` · 置信度 <b class="conf ${confClass(c)}">${c}%</b>` : '') + extra : pages.length ? `识别中 ${doneN}/${pages.length} 页` + (live ? ` · <span class="muted">${esc(live)}</span>` : '') : '准备中…';
  li.className = it.status;
}
function updateGlobal() {
  const g = $('#globalProgress');
  const active = Q.total > Q.done;
  g.hidden = !active;
  if (active) { $('.bar span', g).style.width = Math.round((Q.done / Q.total) * 100) + '%'; $('small', g).textContent = `正在识别：已完成 ${Q.done} / ${Q.total} 页`; }
  $('#queueSummary').textContent = Q.total ? `共 ${Q.total} 页，已完成 ${Q.done} 页` : '';
}

async function importVisualFiles(files) {
  const cfg = getOcr();
  const tags = parseTags($('#batchTags').value);
  files = files.filter(isImageLike);
  if (!files.length) return;
  if (cfg.engine === 'gemini' && !geminiReady()) toast(cfg.fallback ? '尚未设置 Gemini API Key，本批次将改用 Tesseract 本地识别。' : '尚未设置 Gemini API Key，请先到“设置”填写，否则识别会失败。', 5000);
  else toast(`已加入 ${files.length} 个文件，开始${cfg.engine === 'gemini' ? '由 Gemini ' : ''}识别…`);
  for (const file of files) {
    const it = { id: db.uid('it-'), title: titleFromName(file.name), sourceName: file.webkitRelativePath || file.name, type: OCR_TYPES.includes(ext(file.name)) ? ext(file.name) : (ext(file.name) === 'pdf' ? 'pdf' : 'image'), size: file.size, createdAt: Date.now(), status: 'processing', pages: [], tags: [...tags], dates: '', notes: '', ocr: ocrInfo(cfg) };
    if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'jfif'].includes(ext(file.name))) it.type = 'image';
    if (['tif', 'tiff'].includes(ext(file.name))) it.type = 'tiff';
    if (['heic', 'heif'].includes(ext(file.name))) it.type = 'heic';
    await saveItem(it, true);
    queueRow(it, file);
    Q.tasks.push({ kind: 'open', it, file, cfg });
  }
  pumpQueue(runnersFor(cfg));
  rerenderCurrent();
}
function pumpQueue(n) { while (Q.running < n && Q.tasks.length) { Q.running++; runner().finally(() => { Q.running--; if (Q.tasks.length) pumpQueue(n); else if (!Q.running) onQueueIdle(); }); } }
async function runner() {
  while (Q.tasks.length) {
    const t = Q.tasks.shift();
    try {
      if (t.kind === 'open') {
        const src = await openVisual(t.file, { pdfScale: t.cfg.scale, usePdfText: t.cfg.pdfText });
        t.it.pages = src.pages.map(() => ({ status: 'queued', progress: 0, text: '', confidence: null }));
        if (!t.it.pages.length) throw new Error('未能读取页面');
        Q.total += src.pages.length; updateGlobal();
        const pending = { n: src.pages.length, cleanup: src.cleanup };
        Q.tasks.unshift(...src.pages.map((p, i) => ({ kind: 'page', it: t.it, idx: i, src: p, cfg: t.cfg, pending })));
        updateRow(t.it); await saveItem(t.it, true);
      } else if (t.kind === 'page') {
        await processPage(t.it, t.idx, t.src, t.cfg, t.engine || t.cfg.engine);
        Q.done++; updateGlobal();
        if (--t.pending.n === 0) { t.pending.cleanup?.(); await finishItem(t.it); }
      }
    } catch (e) {
      console.error(e);
      const it = t.it;
      if (t.kind === 'page') {
        const pg = it.pages[t.idx], msg = String(e.message || e);
        pg.statusText = ''; pg.progress = 0;
        if (t.src?.reuse && pg.text) { pg.status = 'done'; pg.lastError = msg; } else { pg.status = 'error'; pg.error = msg; }
        notifyError(msg);
        Q.done++; updateGlobal(); await saveItem(it, true); refreshItemViewIf(it, t.idx); if (--t.pending.n === 0) await finishItem(it);
      }
      else { it.status = 'error'; it.error = String(e.message || e); await saveItem(it, true); }
      updateRow(it);
    }
  }
}
let lastErrToast = 0;
function notifyError(msg) { if (Date.now() - lastErrToast > 4000) { lastErrToast = Date.now(); toast('识别失败：' + esc(msg), 6000); } }
async function tesseractPage(canvas, cfg, onProg) {
  await configurePool(cfg);
  const pre = preprocess(canvas, cfg);
  const data = await pool.recognize(pre, onProg);
  return { text: cleanText(data.text), confidence: Math.round(data.confidence), source: 'ocr', engine: 'tesseract', model: 'tesseract.js ' + effectiveLangs(cfg).join('+'), low: lowConfidenceWords(data, pre.width, pre.height) };
}
async function geminiPage(canvas, cfg, page, it, idx) {
  page.progress = 0.04;
  // Gemini reports no progress: advance the bar asymptotically while waiting for the response.
  const tick = setInterval(() => { page.progress = Math.min(0.92, page.progress + (0.92 - page.progress) * 0.05); updateRow(it); refreshProgressIf(it, idx); }, 400);
  try {
    const r = await ocrCanvas(canvas, { langNames: langNamesFor(cfg), vertical: cfg.vertical, onStatus: (st) => { page.statusText = st; updateRow(it); refreshProgressIf(it, idx); } });
    return { text: r.text, confidence: null, source: 'ocr', engine: 'gemini', model: r.model, low: [], warning: r.truncated ? 'Gemini 输出达到长度上限，本页文字可能不完整' : '' };
  } finally { clearInterval(tick); page.statusText = ''; }
}
async function recognizePage(canvas, cfg, engine, page, it, idx) {
  const prog = (p) => { page.progress = p; updateRow(it); refreshProgressIf(it, idx); };
  if (engine !== 'gemini') return tesseractPage(canvas, cfg, prog);
  try { return await geminiPage(canvas, cfg, page, it, idx); }
  catch (e) {
    if (!cfg.fallback || e.name === 'AbortError') throw e;
    console.warn('Gemini failed, falling back to Tesseract:', e.message);
    page.statusText = 'Gemini 失败，改用 Tesseract…'; page.progress = 0; updateRow(it);
    const r = await tesseractPage(canvas, cfg, prog);
    page.statusText = '';
    return { ...r, fallbackFrom: 'gemini', engineError: String(e.message || e) };
  }
}
async function processPage(it, idx, src, cfg, engine = cfg.engine) {
  const page = it.pages[idx];
  page.status = 'rendering'; updateRow(it); refreshItemViewIf(it, idx);
  const { canvas, text } = await src.render();
  if (!src.reuse) {
    page.image = await canvasToBlob(canvas, 2200);
    page.w = canvas.width; page.h = canvas.height;
    if (idx === 0) it.thumb = await canvasToBlob(canvas, 360, 'image/jpeg', 0.8);
  }
  if (text) {
    Object.assign(page, { text: cleanText(text), confidence: null, source: 'pdf-text', engine: 'pdf-text', model: '', status: 'done', progress: 1, low: [] });
  } else {
    page.status = 'ocr'; page.engine = engine; refreshItemViewIf(it, idx);
    const r = await recognizePage(canvas, cfg, engine, page, it, idx);
    Object.assign(page, { fallbackFrom: null, engineError: '', warning: '', lastError: '', error: '', edited: false, statusText: '' }, r, { status: 'done', progress: 1, at: Date.now() });
  }
  await saveItem(it, true);
  updateRow(it); refreshItemViewIf(it, idx);
}
// Re-OCR existing pages (from the stored page images) through the same queue / progress UI.
function canvasFromBlob(blob) { return createImageBitmap(blob).then((b) => { const cv = document.createElement('canvas'); cv.width = b.width; cv.height = b.height; cv.getContext('2d').drawImage(b, 0, 0); b.close?.(); return cv; }); }
function enqueueReocr(it, idxs, engine, cfg) {
  idxs = idxs.filter((i) => it.pages[i]?.image);
  if (!idxs.length) return 0;
  it.status = 'processing'; it.error = ''; it.ocr = ocrInfo(cfg, engine);
  queueRow(it, { name: it.sourceName || it.title });
  const pending = { n: idxs.length };
  for (const i of idxs) Object.assign(it.pages[i], { status: 'queued', progress: 0, statusText: '' });
  Q.total += idxs.length; updateGlobal(); updateRow(it);
  Q.tasks.push(...idxs.map((i) => ({ kind: 'page', it, idx: i, cfg, engine, pending, src: { reuse: true, render: async () => ({ canvas: await canvasFromBlob(it.pages[i].image), text: '' }) } })));
  return idxs.length;
}
function reocr(list, engine) {
  const cfg = getOcr();
  if (engine === 'gemini' && !geminiReady() && !cfg.fallback) { toast('请先在“设置 → Gemini”中填写 API Key', 4000); location.hash = '#/settings'; return 0; }
  const targets = list.filter((x) => OCR_TYPES.includes(x.it.type) && x.it.status !== 'processing');
  const edited = targets.reduce((n, x) => n + x.idxs.filter((i) => x.it.pages[i]?.edited).length, 0);
  if (edited && !confirm(`其中 ${edited} 页的文字已手动编辑，重新识别将覆盖这些修改。继续吗？`)) return 0;
  let n = 0; for (const x of targets) n += enqueueReocr(x.it, x.idxs, engine, cfg);
  if (!n) { toast('没有可重新识别的图像页'); return 0; }
  toast(`已加入 ${n} 页，正在用 ${engine === 'gemini' ? 'Gemini' : 'Tesseract'} 重新识别…`);
  pumpQueue(runnersFor(cfg, engine));
  return n;
}
async function finishItem(it) {
  it.status = it.pages.every((p) => p.status === 'error') ? 'error' : 'done';
  it.warning = it.pages.some((p) => p.warning) ? it.pages.find((p) => p.warning).warning : (it.warning || '').replace(/Gemini 输出达到长度上限[^。]*/, '');
  if (it.status === 'error') it.error = it.pages[0]?.error || '识别失败';
  await saveItem(it, true);
  await refreshTimelineFor(it);
  S.themes = null;
  updateRow(it);
  if (location.hash.startsWith('#/library')) renderLibrary();
  refreshItemViewIf(it, S.page[it.id] ?? 0);
}
function onQueueIdle() { if (Q.total && Q.done >= Q.total) { toast('全部识别完成 ✓'); Q.total = Q.done = 0; updateGlobal(); } }

async function importDocFiles(files) {
  const tags = parseTags($('#batchTags').value);
  files = files.filter(isDocLike);
  for (const file of files) {
    const it = { id: db.uid('it-'), title: titleFromName(file.name), sourceName: file.webkitRelativePath || file.name, type: ext(file.name), size: file.size, createdAt: Date.now(), status: 'processing', pages: [], tags: [...tags], dates: '', notes: '' };
    queueRow(it, file);
    try {
      const r = await extractDocument(file);
      it.type = r.type; it.pages = [{ text: r.text, confidence: null, source: 'doc', status: 'done' }]; it.status = 'done'; it.warning = r.warning || '';
      if (!r.text) it.warning = (it.warning ? it.warning + ' ' : '') + '未提取到文字。';
    } catch (e) { console.error(e); it.status = 'error'; it.error = String(e.message || e); }
    await saveItem(it, true);
    if (it.status === 'done') await refreshTimelineFor(it);
    updateRow(it);
  }
  S.themes = null;
  if (files.length) toast(`已导入 ${files.length} 个文档`);
  rerenderCurrent();
}
function routeFiles(files) {
  const vis = files.filter(isImageLike), docs = files.filter(isDocLike);
  const skipped = files.length - vis.length - docs.length;
  if (skipped) toast(`已跳过 ${skipped} 个不支持的文件`);
  if (docs.length) importDocFiles(docs);
  if (vis.length) importVisualFiles(vis);
}
async function filesFromDrop(e) {
  const out = [];
  const items = [...(e.dataTransfer.items || [])];
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...e.dataTransfer.files];
  const walk = async (entry, path = '') => {
    if (entry.isFile) { const f = await new Promise((r, j) => entry.file(r, j)); try { Object.defineProperty(f, 'webkitRelativePath', { value: path + f.name }); } catch {} out.push(f); }
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch; do { batch = await new Promise((r, j) => reader.readEntries(r, j)); for (const en of batch) await walk(en, path + entry.name + '/'); } while (batch.length);
    }
  };
  for (const en of entries) await walk(en);
  return out;
}
function initImport() {
  const wire = (zone, input, handler) => {
    input.addEventListener('change', () => { handler([...input.files]); input.value = ''; });
    zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('over')));
    zone.addEventListener('drop', async (e) => { e.preventDefault(); e.stopPropagation(); handler(await filesFromDrop(e)); });
  };
  wire($('#dropVisual'), $('#inVisual'), routeFiles);
  wire($('#dropDocs'), $('#inDocs'), routeFiles);
  $('#pickFolder').addEventListener('click', () => $('#inFolder').click());
  $('#inFolder').addEventListener('change', (e) => { routeFiles([...e.target.files]); e.target.value = ''; });
  // drop anywhere on the page
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => { e.preventDefault(); const f = await filesFromDrop(e); if (f.length) { location.hash = '#/import'; routeFiles(f); } });
}

// ---------- timeline ----------
async function refreshTimelineFor(it) {
  const text = itemText(it);
  const found = extractDates(text);
  const existing = [...S.timeline.values()].filter((e) => e.itemId === it.id && e.auto);
  const keep = new Set();
  const adds = [];
  for (const d of found) {
    const sig = it.id + '|' + d.key + '|' + hash(d.match + d.context);
    if (S.dismissed.has(sig)) continue;
    const id = 'tl-' + hash(sig);
    keep.add(id);
    if (!S.timeline.has(id)) adds.push({ id, sig, itemId: it.id, key: d.key, title: '', context: d.context, match: d.match, note: d.note || '', auto: true, edited: false, createdAt: Date.now() });
  }
  for (const e of existing) if (!keep.has(e.id) && !e.edited) { S.timeline.delete(e.id); await db.del('timeline', e.id); }
  for (const a of adds) S.timeline.set(a.id, a);
  if (adds.length) await db.putMany('timeline', adds);
}
function timelineEntries() {
  const from = $('#tlFrom').value.trim(), to = $('#tlTo').value.trim();
  const terms = parseQuery($('#tlFilter').value);
  return [...S.timeline.values()].filter((e) => {
    if (e.itemId && !S.items.has(e.itemId)) return false;
    if (!inRange([e.key], from, to)) return false;
    if (terms.length && !matchesAll([e.title, e.context, e.match, S.items.get(e.itemId)?.title].join(' '), terms)) return false;
    return true;
  }).sort((a, b) => a.key.localeCompare(b.key) || (a.createdAt - b.createdAt));
}
function renderTimeline() {
  const list = timelineEntries();
  if (!list.length) { $('#tlList').innerHTML = `<p class="empty-big">年表为空。导入含有日期的材料后会自动生成，例如“1937年7月7日”“民国二十六年”“光绪三十年”“July 7, 1937”。</p>`; return; }
  let html = '', lastYear = null;
  for (const e of list) {
    const y = e.key.slice(0, 4);
    if (y !== lastYear) { html += `<h3 class="tl-year">${+y}<small>年</small></h3>`; lastYear = y; }
    const it = S.items.get(e.itemId);
    html += `<article class="tl-entry ${e.auto ? 'auto' : 'manual'}" data-id="${e.id}">
      <div class="tl-date">${esc(displayKey(e.key))}<small>${{ day: '', month: '（月）', year: '（年）' }[precisionOf(e.key)]}</small></div>
      <div class="tl-body">
        ${e.title ? `<h4>${esc(e.title)}</h4>` : ''}
        <p class="tl-context">${highlight(e.context || '', e.match ? [normalize(e.match)] : [])}</p>
        <p class="tl-meta small muted">${it ? `来源：<a href="#/item/${it.id}">${esc(it.title)}</a>` : '手动条目'}${e.note ? ` · ${esc(e.note)}` : ''}${e.auto ? (e.edited ? ' · 已编辑' : ' · 自动提取') : ''}</p>
      </div>
      <div class="tl-actions"><button class="ghost small" data-act="edit">编辑</button><button class="ghost small" data-act="del">删除</button></div>
    </article>`;
  }
  $('#tlList').innerHTML = html;
}
function editTimelineEntry(e) {
  const el = $(`.tl-entry[data-id="${e.id}"]`) || (() => { const d = document.createElement('article'); d.className = 'tl-entry editing'; d.dataset.id = e.id; $('#tlList').prepend(d); return d; })();
  el.classList.add('editing');
  const opts = ['<option value="">（无来源）</option>', ...[...S.items.values()].map((it) => `<option value="${it.id}" ${it.id === e.itemId ? 'selected' : ''}>${esc(it.title)}</option>`)].join('');
  el.innerHTML = `<div class="tl-form">
    <label class="field">日期 <input name="key" value="${esc(e.key)}" placeholder="1937-07-07 / 1937-07 / 1937，也可输入“民国二十六年”"></label>
    <label class="field">事件标题 <input name="title" value="${esc(e.title || '')}" placeholder="如：卢沟桥事变"></label>
    <label class="field">内容 / 语境 <textarea name="context" rows="3">${esc(e.context || '')}</textarea></label>
    <label class="field">来源条目 <select name="itemId">${opts}</select></label>
    <div class="btnrow"><button class="primary" data-act="save">保存</button><button class="ghost" data-act="cancel">取消</button></div></div>`;
  el._entry = e;
}
function initTimeline() {
  ['#tlFilter', '#tlFrom', '#tlTo'].forEach((s) => $(s).addEventListener('input', () => debounce('tl', renderTimeline, 200)));
  $('#tlAdd').addEventListener('click', () => editTimelineEntry({ id: db.uid('tlm-'), key: '', title: '', context: '', itemId: '', auto: false, isNew: true, createdAt: Date.now() }));
  $('#tlRescan').addEventListener('click', async () => { for (const it of S.items.values()) await refreshTimelineFor(it); renderTimeline(); toast('已重新提取日期'); });
  $('#tlList').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button[data-act]'); if (!btn) return;
    const el = btn.closest('.tl-entry'); const id = el.dataset.id;
    const e = S.timeline.get(id) || el._entry;
    if (btn.dataset.act === 'edit') editTimelineEntry(e);
    else if (btn.dataset.act === 'del') {
      if (e.auto) { S.dismissed.add(e.sig); await saveMeta('dismissed', [...S.dismissed]); }
      S.timeline.delete(id); await db.del('timeline', id); renderTimeline(); toast('已删除年表条目');
    } else if (btn.dataset.act === 'cancel') renderTimeline();
    else if (btn.dataset.act === 'save') {
      const f = (n) => $(`[name="${n}"]`, el).value.trim();
      let key = f('key');
      if (!/^\d{3,4}(-\d{2}(-\d{2})?)?$/.test(key)) {
        const d = extractDates(key)[0];
        const m = key.match(/^(\d{3,4})(?:[-/.](\d{1,2}))?(?:[-/.](\d{1,2}))?$/);
        if (d) key = d.key; else if (m) key = makeKey(+m[1], m[2] ? +m[2] : null, m[3] ? +m[3] : null); else { toast('无法识别日期，请使用 1937-07-07 等格式'); return; }
      }
      const n = { ...e, key: key.padStart(4, '0'), title: f('title'), context: f('context'), itemId: f('itemId') || null, edited: true };
      delete n.isNew;
      S.timeline.set(n.id, n); await db.put('timeline', n); renderTimeline(); toast('已保存');
    }
  });
  $('#tlAI').addEventListener('click', async () => {
    const list = timelineEntries();
    if (!list.length) return toast('年表为空');
    const box = $('#tlAIBox'); box.hidden = false; box.innerHTML = '<p class="muted">AI 正在总结年表…</p>';
    try {
      const prompt = '以下是从档案材料中提取的年表条目（日期｜内容｜来源）。请按时期归纳主要事件脉络，指出关键转折点，并标注材料中的疑点或日期冲突。\n\n' + list.map((e) => `${displayKey(e.key)}｜${e.title ? e.title + '：' : ''}${e.context}｜${S.items.get(e.itemId)?.title || '手动'}`).join('\n');
      const out = await chat(prompt);
      await saveMeta('timelineAI', out);
      box.innerHTML = `<h3>AI 年表总结</h3><div class="pre">${esc(out)}</div>`;
    } catch (err) { box.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  });
}

// ---------- library ----------
function fillSelects() {
  const types = [...new Set([...S.items.values()].map((i) => i.type))];
  const typeOpts = '<option value="">全部类型</option>' + types.map((t) => `<option value="${t}">${TYPE_LABEL[t] || t}</option>`).join('');
  const tagOpts = '<option value="">全部标签</option>' + allTags().map(([t, n]) => `<option value="${esc(t)}">${esc(t)} (${n})</option>`).join('');
  for (const [sel, html] of [['#libType', typeOpts], ['#sType', typeOpts + '<option value="note">笔记</option>'], ['#libTag', tagOpts], ['#sTag', tagOpts]]) { const el = $(sel); const v = el.value; el.innerHTML = html; el.value = v; if (el.value !== v) el.value = ''; }
}
function renderLibrary() {
  fillSelects();
  const items = libraryItems();
  $('#libCount').textContent = `共 ${S.items.size} 个条目` + (items.length !== S.items.size ? `，显示 ${items.length} 个` : '');
  renderLibraryCards(items);
}
function libraryItems() {
  const terms = parseQuery($('#libFilter').value), type = $('#libType').value, tag = $('#libTag').value, sort = $('#libSort').value;
  let items = [...S.items.values()].filter((it) => (!type || it.type === type) && (!tag || (it.tags || []).includes(tag)) && (!terms.length || matchesAll([it.title, it.sourceName, (it.tags || []).join(' '), it.notes, itemText(it)].join('\n'), terms)));
  if (sort === 'new') items.sort((a, b) => b.createdAt - a.createdAt);
  else if (sort === 'title') items.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  else items.sort((a, b) => (itemDateKeys(a)[0] || '9999').localeCompare(itemDateKeys(b)[0] || '9999'));
  return items;
}
function renderLibraryCards(items) {
  const box = $('#libItems');
  box.className = 'lib ' + S.libMode + (S.selecting ? ' selecting' : '');
  if (!items.length) { box.innerHTML = `<div class="empty-big"><p class="big">❧</p><p>${S.items.size ? '没有符合条件的条目。' : '档案库还是空的。'}</p><p><a class="button primary" href="#/import">导入图像、PDF 或文档</a></p></div>`; return; }
  box.innerHTML = items.map((it) => {
    const keys = itemDateKeys(it); const c = itemConf(it); const txt = itemText(it);
    const thumb = it.thumb ? `<img src="${blobUrl(it.thumb)}" alt="" loading="lazy">` : `<div class="docicon ${it.type}">${TYPE_LABEL[it.type] || it.type}</div>`;
    const gem = (it.pages || []).some((p) => p.engine === 'gemini');
    return `<a class="lib-card ${it.status} ${S.libSel?.has(it.id) ? 'picked' : ''}" href="#/item/${it.id}" data-id="${it.id}">
      <div class="thumb">${S.selecting ? `<span class="pick" aria-hidden="true">${S.libSel.has(it.id) ? '✓' : ''}</span>` : ''}${thumb}${it.status === 'processing' ? '<span class="badge busy">识别中…</span>' : it.status === 'error' ? '<span class="badge err">失败</span>' : ''}</div>
      <div class="lib-body">
        <h3>${esc(it.title)}</h3>
        <p class="meta small"><span class="type">${TYPE_LABEL[it.type] || it.type}</span>${it.pages?.length > 1 ? ` · ${it.pages.length} 页` : ''}${keys.length ? ` · ${esc(displayKey(keys[0]))}${keys.length > 1 ? ' 起' : ''}` : ''}${c != null ? ` · <span class="conf ${confClass(c)}">${c}%</span>` : ''}${gem ? ' · <span class="conf gem">Gemini</span>' : ''}</p>
        <p class="excerpt small">${esc(txt.slice(0, 120).replace(/\s+/g, ' '))}${txt.length > 120 ? '…' : ''}</p>
        <p class="tags">${(it.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>
      </div></a>`;
  }).join('');
}
async function exportLibrary(fmt) {
  const items = libraryItems().filter((it) => it.status === 'done');
  if (!items.length) return toast('没有可导出的条目');
  const stamp = new Date().toISOString().slice(0, 10);
  const header = (it) => `===== ${it.title}（${it.sourceName}）=====`;
  const pageText = (it) => it.pages.length > 1 ? it.pages.map((p, i) => `--- 第 ${i + 1} 页 ---\n${p.text || ''}`).join('\n\n') : itemText(it);
  if (fmt === 'txt') return download(`档案文字_${stamp}.txt`, items.map((it) => header(it) + '\n' + pageText(it)).join('\n\n\n'));
  const json = items.flatMap((it) => it.pages.map((p, i) => ({ filename: it.sourceName, title: it.title, page: i + 1, text: p.text || '', confidence: p.confidence ?? null, source: p.source || '', engine: p.engine || (p.source === 'ocr' ? 'tesseract' : p.source || ''), model: p.model || '', languages: it.ocr?.langs || null, tags: it.tags || [], edited: !!p.edited })));
  if (fmt === 'json') return download(`档案文字_${stamp}.json`, JSON.stringify(json, null, 2), 'application/json');
  if (fmt === 'docx') { const b = [{ t: 'h1', text: '档案文字汇编' }, { t: 'meta', text: `${items.length} 个条目 · 导出于 ${fmtTime(Date.now())}` }]; for (const it of items) { b.push({ t: 'h2', text: it.title }, { t: 'meta', text: it.sourceName }); it.pages.forEach((p, i) => { if (it.pages.length > 1) b.push({ t: 'h3', text: `第 ${i + 1} 页` }); b.push({ t: 'p', text: p.text || '' }); }); } return exportBlocks(b, `档案文字_${stamp}`, 'docx'); }
  const zip = new JSZip(); const used = new Set();
  for (const it of items) { let n = safeName(it.title), k = 1; while (used.has(n)) n = safeName(it.title) + '_' + ++k; used.add(n); zip.file(n + '.txt', pageText(it)); }
  zip.file('results.json', JSON.stringify(json, null, 2));
  download(`档案文字_${stamp}.zip`, await zip.generateAsync({ type: 'blob' }));
}
function initLibrary() {
  $('#libExport').addEventListener('click', (e) => { const f = e.target.dataset.lexp; if (f) exportLibrary(f); });
  ['#libFilter', '#libType', '#libTag', '#libSort'].forEach((s) => $(s).addEventListener('input', () => debounce('lib', renderLibrary, 150)));
  S.libSel = new Set();
  const selUI = () => { $('#libSelBar').hidden = !S.selecting; $('#libSelN').textContent = S.libSel.size; $('#libSelect').classList.toggle('on', !!S.selecting); };
  $('#libSelect').addEventListener('click', () => { S.selecting = !S.selecting; if (!S.selecting) S.libSel.clear(); selUI(); renderLibrary(); });
  $('#libSelDone').addEventListener('click', () => { S.selecting = false; S.libSel.clear(); selUI(); renderLibrary(); });
  $('#libSelAll').addEventListener('click', () => { for (const it of libraryItems()) if (OCR_TYPES.includes(it.type)) S.libSel.add(it.id); selUI(); renderLibrary(); });
  $('#libSelNone').addEventListener('click', () => { S.libSel.clear(); selUI(); renderLibrary(); });
  $('#libItems').addEventListener('click', (e) => {
    if (!S.selecting) return; const a = e.target.closest('.lib-card'); if (!a) return;
    e.preventDefault(); const id = a.dataset.id; S.libSel.has(id) ? S.libSel.delete(id) : S.libSel.add(id); selUI(); renderLibrary();
  });
  const go = (engine) => {
    const list = [...S.libSel].map((id) => S.items.get(id)).filter(Boolean);
    if (!list.length) return toast('请先点击卡片选择条目');
    const skipped = list.filter((it) => !OCR_TYPES.includes(it.type)).length;
    const n = reocr(list.map((it) => ({ it, idxs: (it.pages || []).map((_, i) => i) })), engine);
    if (n) { if (skipped) toast(`已加入 ${n} 页重新识别；跳过 ${skipped} 个文档类条目`, 4000); S.selecting = false; S.libSel.clear(); selUI(); renderLibrary(); }
  };
  $('#libReGem').addEventListener('click', () => go('gemini'));
  $('#libReTess').addEventListener('click', () => go('tesseract'));
  $$('#view-library .seg button').forEach((b) => b.addEventListener('click', () => { S.libMode = b.dataset.mode; $$('#view-library .seg button').forEach((x) => x.classList.toggle('on', x === b)); renderLibrary(); }));
}

// ---------- item detail ----------
function renderItem(id, pageNo) {
  const it = S.items.get(id); const v = $('#view-item');
  if (!it) { v.innerHTML = '<p class="empty-big">条目不存在或已删除。<a href="#/library">返回档案库</a></p>'; return; }
  const p = Math.min(Math.max(0, pageNo ?? S.page[id] ?? 0), Math.max(0, (it.pages?.length || 1) - 1));
  S.page[id] = p;
  const page = it.pages?.[p] || {};
  const visual = OCR_TYPES.includes(it.type);
  const keys = itemDateKeys(it);
  const linked = [...S.notes.values()].filter((n) => (n.itemIds || []).includes(id));
  const tl = [...S.timeline.values()].filter((e) => e.itemId === id).sort((a, b) => a.key.localeCompare(b.key));
  v.innerHTML = `
  <div class="item-head">
    <a href="#/library" class="ghost button small">‹ 档案库</a>
    <input class="title-input" id="itTitle" value="${esc(it.title)}" aria-label="标题">
    <div class="btnrow wrap">
      ${aiEnabled() ? '<button id="itAI" class="ghost">AI 摘要</button>' : ''}
      ${visual && it.pages.length > 1 ? '<button id="itReGem" class="ghost" title="将本条目的全部页面发送至 Gemini 重新识别">全部页用 Gemini 识别</button>' : ''}
      <button id="itCopy" class="ghost">复制全文</button><button id="itTxt" class="ghost">下载 .txt</button><button id="itDel" class="danger">删除</button>
    </div>
  </div>
  <p class="muted small">来源文件：${esc(it.sourceName)} · ${TYPE_LABEL[it.type] || it.type} · 导入于 ${fmtTime(it.createdAt)}${it.ocr ? (it.ocr.engine === 'gemini' ? ` · 识别引擎 Gemini（${esc(it.ocr.model || '')}）` : ` · 识别语言 ${esc(it.ocr.langs.join('+'))}`) : ''}${it.warning ? ` · <span class="warn">${esc(it.warning)}</span>` : ''}${it.status === 'error' ? ` · <span class="err">${esc(it.error || '')}</span>` : ''}</p>
  <div class="meta-grid">
    <label class="field">档案日期 <input id="itDates" value="${esc(it.dates || '')}" placeholder="如 1937-07-07；民国二十六年；1937—1938"></label>
    <label class="field">标签 / 主题 <input id="itTags" value="${esc((it.tags || []).join(', '))}" placeholder="逗号分隔"></label>
  </div>
  ${keys.length ? `<p class="datechips small">识别出的日期：${keys.slice(0, 12).map((k) => `<span class="chip-s">${esc(displayKey(k))}</span>`).join('')}${keys.length > 12 ? ' …' : ''}</p>` : ''}
  <div class="split ${visual ? '' : 'docmode'}">
    ${visual ? `<figure class="pane image-pane">
      <div class="pane-bar"><span>原件图像 ${it.pages.length > 1 ? `· 第 ${p + 1} / ${it.pages.length} 页` : ''}</span>
        <span class="pane-tools">${it.pages.length > 1 ? `<button class="ghost small" id="pgPrev" ${p === 0 ? 'disabled' : ''}>‹ 上一页</button><button class="ghost small" id="pgNext" ${p >= it.pages.length - 1 ? 'disabled' : ''}>下一页 ›</button>` : ''}
        ${page.engine === 'gemini' ? '' : `<label class="toggle small"><input type="checkbox" id="showLow" ${S.showLow !== false ? 'checked' : ''}> 标出低置信词</label>`}</span></div>
      <div class="imgwrap">${page.image ? `<img id="pageImg" src="${blobUrl(page.image)}" alt="第${p + 1}页">` : `<div class="placeholder">${page.status === 'error' ? '读取失败' : '正在准备图像…'}</div>`}<div class="overlay" id="overlay"></div></div>
    </figure>` : `<aside class="pane docinfo"><div class="docicon big ${it.type}">${TYPE_LABEL[it.type] || it.type}</div><p class="small muted">文字由文档直接提取，可在右侧编辑。</p></aside>`}
    <div class="pane text-pane">
      <div class="pane-bar"><span>${visual ? '识别文字（可编辑）' : '文档文字（可编辑）'} <small class="muted" id="editedFlag">${page.edited ? '· 已编辑' : ''}</small></span>
        <span>${visual ? engineBadge(page) : ''}</span></div>
      ${visual ? pageNotice(page) : ''}
      ${visual && page.status !== 'done' && page.status !== 'error' ? `<div class="progress"><div class="bar"><span style="width:${Math.round((page.progress || 0) * 100)}%"></span></div><small id="pageStatus">${esc(page.statusText || ({ queued: '排队中', rendering: '渲染页面…', ocr: page.engine === 'gemini' ? '正在由 Gemini 识别…' : '识别中…' }[page.status] || ''))}</small></div>` : ''}
      <textarea id="itText" spellcheck="false" placeholder="${visual ? '识别结果将显示在这里' : ''}">${esc(page.text || '')}</textarea>
      <div class="btnrow wrap small-note"><span class="muted small">提示：选中文字后可“引用到笔记”。检索时繁简体通查。</span><span class="btnrow" style="margin:0"><button id="pgT2S" class="ghost small" title="将本页文字中的繁体字转换为简体">繁→简</button>${visual ? '<button id="pgReTess" class="ghost small" title="使用当前 Tesseract 设置在本机重新识别">Tesseract 重识别本页</button><button id="pgReGem" class="ghost small gem-btn" title="将本页图像发送至 Google Gemini 识别">Gemini 重识别本页</button>' : ''}</span></div>
    </div>
  </div>
  <div class="grid-two lower">
    <div class="card"><h3>条目笔记</h3><textarea id="itNotes" rows="5" placeholder="对本条目的考证、备注……">${esc(it.notes || '')}</textarea>
      ${linked.length ? `<h4>关联笔记</h4><ul class="plain">${linked.map((n) => `<li><a href="#/notes/${n.id}">${esc(n.title || '未命名笔记')}</a></li>`).join('')}</ul>` : ''}
      <div id="itAIBox">${it.aiSummary ? `<h4>AI 摘要</h4><div class="pre">${esc(it.aiSummary)}</div>` : ''}</div>
    </div>
    <div class="card"><h3>本条目年表 <a class="small" href="#/timeline">查看全部 ›</a></h3>
      ${tl.length ? `<ul class="mini-tl">${tl.map((e) => `<li><b>${esc(displayKey(e.key))}</b> ${esc(e.title ? e.title + '：' : '')}${esc(e.context)}${e.note ? `<small class="muted"> · ${esc(e.note)}</small>` : ''}</li>`).join('')}</ul>` : '<p class="muted small">未识别到日期。</p>'}
    </div>
  </div>`;
  drawOverlay(it, p);
  const img = $('#pageImg'); if (img && !img.complete) img.onload = () => drawOverlay(it, p);
  const nav = (d) => { location.hash = `#/item/${id}/${p + d + 1}`; };
  $('#pgPrev')?.addEventListener('click', () => nav(-1));
  $('#pgNext')?.addEventListener('click', () => nav(1));
  $('#showLow')?.addEventListener('change', (e) => { S.showLow = e.target.checked; drawOverlay(it, p); });
  $('#itTitle').addEventListener('input', (e) => { it.title = e.target.value; saveItem(it); });
  $('#itDates').addEventListener('input', (e) => { it.dates = e.target.value; saveItem(it); });
  $('#itTags').addEventListener('change', (e) => { it.tags = parseTags(e.target.value); saveItem(it); S.themes = null; });
  $('#itNotes').addEventListener('input', (e) => { it.notes = e.target.value; saveItem(it); });
  const ta = $('#itText');
  ta.addEventListener('input', () => { page.text = ta.value; page.edited = true; $('#editedFlag').textContent = '· 已编辑'; saveItem(it); S.themes = null; debounce('tl-' + id, () => refreshTimelineFor(it), 1500); });
  ['mouseup', 'keyup', 'select'].forEach((ev) => ta.addEventListener(ev, () => showSelPop(ta, it, p)));
  ta.addEventListener('blur', () => setTimeout(() => { if (!$('#selPop').matches(':hover') && document.activeElement?.closest?.('#selPop') == null) $('#selPop').hidden = true; }, 200));
  $('#itCopy').addEventListener('click', async () => { await navigator.clipboard.writeText(itemText(it)).catch(() => {}); toast('已复制全文'); });
  $('#itTxt').addEventListener('click', () => download(safeName(it.title) + '.txt', itemText(it)));
  $('#itDel').addEventListener('click', async () => {
    if (!confirm(`确定删除“${it.title}”？此操作不可撤销（关联的年表条目也会删除）。`)) return;
    S.items.delete(id); await db.del('items', id);
    for (const e of [...S.timeline.values()]) if (e.itemId === id) { S.timeline.delete(e.id); await db.del('timeline', e.id); }
    S.themes = null; toast('已删除'); location.hash = '#/library';
  });
  $('#pgReTess')?.addEventListener('click', () => reocr([{ it, idxs: [p] }], 'tesseract'));
  $('#pgReGem')?.addEventListener('click', () => reocr([{ it, idxs: [p] }], 'gemini'));
  $('#itReGem')?.addEventListener('click', () => reocr([{ it, idxs: it.pages.map((_, i) => i) }], 'gemini'));
  $('#pgT2S').addEventListener('click', () => { page.text = toSimplified(ta.value); page.edited = true; ta.value = page.text; saveItem(it); refreshTimelineFor(it); S.themes = null; toast('已转换为简体'); });
  $('#itAI')?.addEventListener('click', async () => {
    const box = $('#itAIBox'); box.innerHTML = '<p class="muted">AI 正在生成摘要…</p>';
    try {
      it.aiSummary = await chat(`请为以下档案条目写一段 200 字左右的摘要，列出涉及的人物、机构、地点、时间与主要事件，并给出 3-5 个主题标签。\n标题：${it.title}\n\n${itemText(it)}`);
      await saveItem(it, true); box.innerHTML = `<h4>AI 摘要</h4><div class="pre">${esc(it.aiSummary)}</div>`;
    } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  });
}
function drawOverlay(it, p) {
  const ov = $('#overlay'); if (!ov) return;
  const page = it.pages[p];
  ov.innerHTML = S.showLow === false ? '' : (page?.low || []).map(([x, y, w, h, t, c]) => `<span style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%" title="${esc(t)} · ${c}%"></span>`).join('');
}
function refreshItemViewIf(it, idx) { if (location.hash.startsWith('#/item/' + it.id) && (S.page[it.id] ?? 0) === idx && document.activeElement?.id !== 'itText') renderItem(it.id, idx); }
function refreshProgressIf(it, idx) {
  if (!location.hash.startsWith('#/item/' + it.id) || (S.page[it.id] ?? 0) !== idx) return;
  const bar = $('#view-item .progress .bar span'); if (bar) bar.style.width = Math.round((it.pages[idx].progress || 0) * 100) + '%';
  const st = $('#pageStatus'); if (st) st.textContent = `识别中… ${Math.round((it.pages[idx].progress || 0) * 100)}%`;
}
function engineBadge(page) {
  if (page.source === 'pdf-text') return '<span class="conf na">PDF 文字层</span>';
  if (page.engine === 'gemini') return `<span class="conf gem" title="模型：${esc(page.model || '')}。Gemini 不提供置信度，请对照原图核校。">引擎：Gemini</span>`;
  if (page.status !== 'done' && page.confidence == null) return '<span class="conf na">置信度 —</span>';
  return `<span class="conf ${confClass(page.confidence)}" title="Tesseract 平均置信度">置信度 ${page.confidence ?? '—'}${page.confidence != null ? '%' : ''}</span>` + (page.fallbackFrom ? ' <span class="conf fair" title="Gemini 失败后自动改用 Tesseract">已回退</span>' : '');
}
function pageNotice(page) {
  const out = [];
  if (page.status === 'error' && page.error) out.push(`<span class="err">识别失败：${esc(page.error)}</span>`);
  if (page.lastError) out.push(`<span class="err">最近一次重新识别失败：${esc(page.lastError)}（保留原有文字）</span>`);
  if (page.fallbackFrom) out.push(`<span class="warn">Gemini 识别失败（${esc(page.engineError || '')}），本页已自动改用 Tesseract。</span>`);
  if (page.warning) out.push(`<span class="warn">${esc(page.warning)}</span>`);
  if (page.status === 'done' && page.engine && page.source === 'ocr') out.push(`<span class="muted">本页由 ${esc(page.engine === 'gemini' ? 'Gemini · ' + (page.model || '') : (page.model || 'Tesseract'))} 识别${page.at ? ' · ' + fmtTime(page.at) : ''}</span>`);
  return out.length ? `<p class="page-notice small">${out.join('<br>')}</p>` : '';
}

// ---------- quote selection -> note ----------
function noteOptions(selected) {
  return '<option value="__new">＋ 新建笔记</option>' + [...S.notes.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((n) => `<option value="${n.id}" ${n.id === selected ? 'selected' : ''}>${esc(n.title || '未命名笔记')}</option>`).join('');
}
function showSelPop(ta, it, p) {
  const pop = $('#selPop');
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
  if (!sel) { pop.hidden = true; return; }
  pop._ctx = { itemId: it.id, page: p, text: sel };
  $('#selNote').innerHTML = noteOptions(S.currentNote);
  const r = ta.getBoundingClientRect();
  pop.style.top = (window.scrollY + r.top - 52) + 'px'; pop.style.left = (window.scrollX + Math.max(r.left, r.right - 330)) + 'px';
  pop.hidden = false;
}
async function addQuote(noteId, q) {
  let n = noteId && noteId !== '__new' ? S.notes.get(noteId) : null;
  if (!n) { const it = S.items.get(q.itemId); n = newNote(`关于“${it?.title || ''}”的笔记`); }
  n.quotes = [...(n.quotes || []), { itemId: q.itemId, page: q.page, text: q.text, at: Date.now() }];
  n.itemIds = [...new Set([...(n.itemIds || []), q.itemId])];
  n.updatedAt = Date.now(); S.notes.set(n.id, n); await db.put('notes', n); S.currentNote = n.id;
  return n;
}
function initSelPop() {
  $('#selAdd').addEventListener('click', async () => {
    const pop = $('#selPop'); const ctx = pop._ctx; if (!ctx) return;
    const n = await addQuote($('#selNote').value, ctx);
    pop.hidden = true; toast(`已引用到笔记 <a href="#/notes/${n.id}">${esc(n.title)}</a>`, 4000);
  });
}

// ---------- notes ----------
function newNote(title = '新笔记') { const n = { id: db.uid('nt-'), title, body: '', quotes: [], itemIds: [], createdAt: Date.now(), updatedAt: Date.now() }; S.notes.set(n.id, n); db.put('notes', n); return n; }
function noteText(n) { return [n.title, n.body, ...(n.quotes || []).map((q) => q.text)].join('\n'); }
function renderNotes(openId) {
  if (openId) S.currentNote = openId;
  const terms = parseQuery($('#noteFilter').value);
  const notes = [...S.notes.values()].filter((n) => !terms.length || matchesAll(noteText(n), terms)).sort((a, b) => b.updatedAt - a.updatedAt);
  $('#noteList').innerHTML = notes.length ? notes.map((n) => `<li class="${n.id === S.currentNote ? 'on' : ''}"><a href="#/notes/${n.id}"><b>${esc(n.title || '未命名笔记')}</b><small class="muted">${fmtTime(n.updatedAt)} · ${(n.quotes || []).length} 条引文</small></a></li>`).join('') : '<li class="empty">暂无笔记</li>';
  const n = S.notes.get(S.currentNote);
  const ed = $('#noteEditor');
  if (!n) { ed.innerHTML = '<div class="empty-big"><p class="big">✎</p><p>选择或新建一条笔记。<br>在条目详情中选中文字，可直接“引用到笔记”。</p></div>'; return; }
  const itemOpts = [...S.items.values()].filter((it) => !(n.itemIds || []).includes(it.id)).map((it) => `<option value="${it.id}">${esc(it.title)}</option>`).join('');
  ed.innerHTML = `
    <div class="item-head"><input class="title-input" id="ntTitle" value="${esc(n.title)}" placeholder="笔记标题"><div class="btnrow"><button id="ntExport" class="ghost">导出 .md</button><button id="ntDel" class="danger">删除笔记</button></div></div>
    <textarea id="ntBody" rows="10" placeholder="写下您的思考、考证与线索……">${esc(n.body || '')}</textarea>
    <h3>引文 <small class="muted">（来自条目选中的段落）</small></h3>
    ${(n.quotes || []).length ? n.quotes.map((q, i) => { const it = S.items.get(q.itemId); return `<blockquote class="quote">${esc(q.text)}<footer>—— ${it ? `<a href="#/item/${it.id}/${(q.page || 0) + 1}">${esc(it.title)}${it.pages?.length > 1 ? `，第 ${(q.page || 0) + 1} 页` : ''}</a>` : '（条目已删除）'} <button class="ghost small" data-rmq="${i}">移除</button></footer></blockquote>`; }).join('') : '<p class="muted small">暂无引文。</p>'}
    <h3>关联条目</h3>
    <p class="tags">${(n.itemIds || []).map((id) => { const it = S.items.get(id); return it ? `<span class="tag"><a href="#/item/${id}">${esc(it.title)}</a> <button class="x" data-unlink="${id}" title="取消关联">×</button></span>` : ''; }).join('') || '<span class="muted small">无</span>'}</p>
    ${itemOpts ? `<div class="btnrow"><select id="ntLinkSel">${itemOpts}</select><button id="ntLink" class="ghost">关联</button></div>` : ''}`;
  const save = () => { n.updatedAt = Date.now(); db.put('notes', n); };
  $('#ntTitle').addEventListener('input', (e) => { n.title = e.target.value; debounce('note', save); });
  $('#ntTitle').addEventListener('change', () => renderNotes());
  $('#ntBody').addEventListener('input', (e) => { n.body = e.target.value; debounce('note', save); });
  $('#ntDel').addEventListener('click', async () => { if (!confirm('删除这条笔记？')) return; S.notes.delete(n.id); await db.del('notes', n.id); S.currentNote = null; location.hash = '#/notes'; renderNotes(); });
  $('#ntExport').addEventListener('click', () => exportBlocks(noteBlocks(n), safeName(n.title), 'md'));
  $('#ntLink')?.addEventListener('click', () => { n.itemIds = [...new Set([...(n.itemIds || []), $('#ntLinkSel').value])]; save(); renderNotes(); });
}
function noteBlocks(n) {
  const b = [{ t: 'h1', text: n.title || '笔记' }, { t: 'meta', text: '更新于 ' + fmtTime(n.updatedAt) }];
  if (n.body) b.push({ t: 'p', text: n.body });
  for (const q of n.quotes || []) { b.push({ t: 'quote', text: q.text }); b.push({ t: 'meta', text: '—— ' + (S.items.get(q.itemId)?.title || '') }); }
  return b;
}
function initNotes() {
  $('#noteNew').addEventListener('click', () => { const n = newNote(); location.hash = '#/notes/' + n.id; });
  $('#noteFilter').addEventListener('input', () => debounce('nf', () => renderNotes(), 150));
  $('#noteEditor').addEventListener('click', (e) => {
    const n = S.notes.get(S.currentNote); if (!n) return;
    const save = () => { n.updatedAt = Date.now(); db.put('notes', n); };
    const rq = e.target.closest('[data-rmq]'); if (rq) { n.quotes.splice(+rq.dataset.rmq, 1); save(); renderNotes(); }
    const ul = e.target.closest('[data-unlink]'); if (ul) { n.itemIds = n.itemIds.filter((x) => x !== ul.dataset.unlink); save(); renderNotes(); }
  });
}

// ---------- search ----------
let lastResults = [];
function runSearch() {
  const terms = parseQuery($('#q').value);
  const type = $('#sType').value, tag = $('#sTag').value, from = $('#sFrom').value.trim(), to = $('#sTo').value.trim();
  const res = [];
  if (terms.length || type || tag || from || to) {
    if (type !== 'note') for (const it of S.items.values()) {
      if (type && it.type !== type) continue;
      if (tag && !(it.tags || []).includes(tag)) continue;
      if (!inRange(itemDateKeys(it), from, to)) continue;
      const text = itemText(it);
      const hay = [it.title, (it.tags || []).join(' '), it.notes, text].join('\n');
      if (terms.length && !matchesAll(hay, terms)) continue;
      const pageHits = terms.length ? (it.pages || []).map((p, i) => [i, p]).filter(([, p]) => terms.some((k) => normalize(p.text).includes(k))).map(([i]) => i) : [];
      res.push({ kind: 'item', it, snips: terms.length ? [...snippets(text, terms), ...(it.notes && terms.some((k) => normalize(it.notes).includes(k)) ? snippets(it.notes, terms, { max: 1 }).map((s) => '〔条目笔记〕' + s) : [])] : [esc(text.slice(0, 140))], pageHits });
    }
    if ($('#sNotes').checked && (!type || type === 'note') && !tag && terms.length) for (const n of S.notes.values()) {
      if (!matchesAll(noteText(n), terms)) continue;
      res.push({ kind: 'note', n, snips: snippets(noteText(n), terms) });
    }
  }
  lastResults = res.map((r) => ({ ...r, terms }));
  $('#sCount').textContent = terms.length || type || tag || from || to ? `找到 ${res.length} 条结果` + (terms.length ? `（关键词：${terms.join(' + ')}）` : '') : '输入关键词开始检索。支持中文任意子串匹配。';
  $('#sResults').innerHTML = res.map((r) => r.kind === 'item' ? `
    <article class="result"><h3><a href="#/item/${r.it.id}${r.pageHits[0] ? '/' + (r.pageHits[0] + 1) : ''}">${highlight(r.it.title, terms)}</a> <span class="type small">${TYPE_LABEL[r.it.type] || r.it.type}</span>${r.pageHits.length && r.it.pages.length > 1 ? ` <small class="muted">命中页：${r.pageHits.map((i) => `<a href="#/item/${r.it.id}/${i + 1}">${i + 1}</a>`).join('、')}</small>` : ''}</h3>
      ${r.snips.map((s) => `<p class="snip">${s}</p>`).join('')}
      <p class="tags">${(r.it.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p></article>` : `
    <article class="result note"><h3><a href="#/notes/${r.n.id}">${highlight(r.n.title || '未命名笔记', terms)}</a> <span class="type small">笔记</span></h3>${r.snips.map((s) => `<p class="snip">${s}</p>`).join('')}</article>`).join('');
}
function searchBlocks() {
  const terms = lastResults[0]?.terms || parseQuery($('#q').value);
  const b = [{ t: 'h1', text: '检索结果：' + (terms.join(' + ') || '（筛选）') }, { t: 'meta', text: `共 ${lastResults.length} 条 · 导出于 ${fmtTime(Date.now())}` }];
  for (const r of lastResults) {
    const strip = (h) => h.replace(/<\/?mark>/g, '【').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const mark = (h) => { let open = true; return strip(h).replace(/【/g, () => { const s = open ? '【' : '】'; open = !open; return s; }); };
    b.push({ t: 'h2', text: r.kind === 'item' ? r.it.title : '笔记：' + r.n.title });
    if (r.kind === 'item') b.push({ t: 'meta', text: `${TYPE_LABEL[r.it.type] || r.it.type} · ${r.it.sourceName}${(r.it.tags || []).length ? ' · 标签：' + r.it.tags.join('、') : ''}` });
    for (const s of r.snips) b.push({ t: 'quote', text: mark(s) });
  }
  return b;
}
function initSearch() {
  $('#qBtn').addEventListener('click', runSearch);
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
  ['#sType', '#sTag', '#sNotes'].forEach((s) => $(s).addEventListener('change', runSearch));
  ['#sFrom', '#sTo'].forEach((s) => $(s).addEventListener('change', runSearch));
}

// ---------- themes ----------
function computeThemes() {
  const done = [...S.items.values()].filter((it) => it.status === 'done');
  // tags help grouping, but batch-wide tags (on > half of items) would merge everything, so skip those
  const tagCount = new Map(); for (const it of done) for (const t of it.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const docs = done.map((it) => ({ id: it.id, text: itemText(it), tags: (it.tags || []).filter((t) => tagCount.get(t) <= Math.max(1, done.length / 2)) }));
  S.themes = buildThemes(docs, { threshold: +$('#thThreshold').value });
}
function renderThemes() {
  if (!S.themes) computeThemes();
  const aiT = S.meta.themeAI || {};
  $('#thList').innerHTML = S.themes.length ? S.themes.map((t) => `
    <article class="theme card">
      <h3>${esc(t.label)} <small class="muted">${t.items.length} 个条目</small></h3>
      <p class="kw">${t.keywords.map((k) => `<a class="kwchip" href="#/search?q=${encodeURIComponent(k)}">${esc(k)}</a>`).join('')}</p>
      <h4>相关条目</h4>
      <ul class="plain">${t.items.map((x) => { const it = S.items.get(x.id); return it ? `<li><a href="#/item/${it.id}">${esc(it.title)}</a> <small class="muted">${x.keywords.slice(0, 4).map(esc).join(' · ')}</small></li>` : ''; }).join('')}</ul>
      ${t.excerpts.length ? `<h4>代表性摘录</h4>${t.excerpts.map((e) => `<blockquote class="quote small">${highlight(e.text, t.keywords.slice(0, 6))}<footer>—— <a href="#/item/${e.id}">${esc(S.items.get(e.id)?.title || '')}</a></footer></blockquote>`).join('')}` : ''}
      ${aiT[t.label] ? `<div class="ai-box"><h4>AI 主题总结</h4><div class="pre">${esc(aiT[t.label])}</div></div>` : ''}
    </article>`).join('') : '<p class="empty-big">尚无可分析的文字。导入并识别材料后，这里会自动归纳主题。</p>';
  const tags = allTags();
  $('#tagThemes').innerHTML = tags.length ? tags.map(([tag, n]) => `<article class="theme card small"><h3><span class="tag">${esc(tag)}</span> <small class="muted">${n} 个条目</small></h3><ul class="plain">${[...S.items.values()].filter((it) => (it.tags || []).includes(tag)).map((it) => `<li><a href="#/item/${it.id}">${esc(it.title)}</a></li>`).join('')}</ul></article>`).join('') : '<p class="muted small">尚未设置标签。可在导入时填写“本批次标签”，或在条目详情中添加。</p>';
}
function themeBlocks() {
  if (!S.themes) computeThemes();
  const aiT = S.meta.themeAI || {};
  const b = [{ t: 'h1', text: '主题总结' }, { t: 'meta', text: '导出于 ' + fmtTime(Date.now()) }];
  for (const t of S.themes) {
    b.push({ t: 'h2', text: t.label }, { t: 'p', text: '关键词：' + t.keywords.join('、') }, { t: 'p', text: '相关条目：' + t.items.map((x) => S.items.get(x.id)?.title).filter(Boolean).join('；') });
    for (const e of t.excerpts) b.push({ t: 'quote', text: `${e.text}（${S.items.get(e.id)?.title || ''}）` });
    if (aiT[t.label]) b.push({ t: 'h3', text: 'AI 总结' }, { t: 'p', text: aiT[t.label] });
  }
  return b;
}
function initThemes() {
  $('#thRun').addEventListener('click', () => { computeThemes(); renderThemes(); toast(`已生成 ${S.themes.length} 个主题`); });
  $('#thThreshold').addEventListener('change', () => { computeThemes(); renderThemes(); });
  $('#thAI').addEventListener('click', async () => {
    if (!S.themes) computeThemes();
    const aiT = { ...(S.meta.themeAI || {}) };
    try {
      for (const t of S.themes) {
        toast(`AI 正在总结主题：${esc(t.label)}…`, 8000);
        const material = t.items.map((x) => { const it = S.items.get(x.id); return `【${it.title}】\n${itemText(it).slice(0, 2500)}`; }).join('\n\n');
        aiT[t.label] = await chat(`以下档案条目被归为同一主题（关键词：${t.keywords.join('、')}）。请：1) 给出一个更准确的主题名称；2) 用 150-250 字概括该主题下材料反映的内容；3) 列出值得进一步研究的问题。\n\n${material}`);
        await saveMeta('themeAI', aiT); renderThemes();
      }
      toast('AI 主题总结完成');
    } catch (e) { toast('AI 失败：' + esc(e.message), 6000); }
  });
}

// ---------- exports ----------
function timelineRows() { return [['日期', '精度', '事件标题', '内容/语境', '原文日期', '换算说明', '来源条目', '来源文件', '类型'], ...timelineEntries().map((e) => { const it = S.items.get(e.itemId); return [e.key, { day: '日', month: '月', year: '年' }[precisionOf(e.key)], e.title || '', e.context || '', e.match || '', e.note || '', it?.title || '', it?.sourceName || '', e.auto ? (e.edited ? '自动(已编辑)' : '自动') : '手动']; })]; }
function timelineBlocks() {
  const b = [{ t: 'h1', text: '年表' }, { t: 'meta', text: '导出于 ' + fmtTime(Date.now()) }];
  let y = null;
  for (const e of timelineEntries()) {
    if (e.key.slice(0, 4) !== y) { y = e.key.slice(0, 4); b.push({ t: 'h2', text: +y + '年' }); }
    b.push({ t: 'p', text: `${displayKey(e.key)}　${e.title ? e.title + '：' : ''}${e.context}` });
    b.push({ t: 'meta', text: `来源：${S.items.get(e.itemId)?.title || '手动'}${e.note ? ' · ' + e.note : ''}` });
  }
  if (S.meta.timelineAI) b.push({ t: 'h2', text: 'AI 年表总结' }, { t: 'p', text: S.meta.timelineAI });
  return b;
}
function initExportRows() {
  const defs = { search: ['docx', 'md', 'txt'], timeline: ['csv', 'xlsx', 'docx', 'md', 'txt'], themes: ['docx', 'md', 'txt'] };
  for (const el of $$('.export-row[data-export]')) {
    const kind = el.dataset.export;
    el.innerHTML = '<span class="muted small">导出：</span>' + defs[kind].map((f) => `<button class="ghost small" data-fmt="${f}">.${f}</button>`).join('');
    el.addEventListener('click', async (e) => {
      const f = e.target.dataset.fmt; if (!f) return;
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === 'timeline' && f === 'csv') return download(`年表_${stamp}.csv`, rowsToCsv(timelineRows()), 'text/csv;charset=utf-8');
      if (kind === 'timeline' && f === 'xlsx') return download(`年表_${stamp}.xlsx`, rowsToXlsx(timelineRows(), '年表'));
      const blocks = kind === 'search' ? searchBlocks() : kind === 'timeline' ? timelineBlocks() : themeBlocks();
      await exportBlocks(blocks, `${{ search: '检索结果', timeline: '年表', themes: '主题总结' }[kind]}_${stamp}`, f);
    });
  }
}

// ---------- settings, backup ----------
async function backup() {
  toast('正在打包备份…');
  const items = [];
  for (const it of S.items.values()) {
    const c = { ...it, thumb: it.thumb ? await blobToDataURL(it.thumb) : null, pages: [] };
    for (const p of it.pages || []) c.pages.push({ ...p, image: p.image ? await blobToDataURL(p.image) : null });
    items.push(c);
  }
  const data = { app: 'archive-ocr', version: 1, exportedAt: new Date().toISOString(), items, notes: [...S.notes.values()], timeline: [...S.timeline.values()], dismissed: [...S.dismissed], meta: { timelineAI: S.meta.timelineAI || '', themeAI: S.meta.themeAI || {} } };
  download(`档案备份_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
}
async function restore(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'archive-ocr') throw new Error('不是本应用的备份文件');
  for (const c of data.items || []) {
    c.thumb = c.thumb ? await dataURLToBlob(c.thumb) : null;
    for (const p of c.pages || []) p.image = p.image ? await dataURLToBlob(p.image) : null;
    if (c.status === 'processing') c.status = 'done';
    S.items.set(c.id, c);
  }
  await db.putMany('items', data.items || []);
  for (const n of data.notes || []) S.notes.set(n.id, n); await db.putMany('notes', data.notes || []);
  for (const e of data.timeline || []) S.timeline.set(e.id, e); await db.putMany('timeline', data.timeline || []);
  for (const d of data.dismissed || []) S.dismissed.add(d); await saveMeta('dismissed', [...S.dismissed]);
  if (data.meta?.timelineAI) await saveMeta('timelineAI', data.meta.timelineAI);
  if (data.meta?.themeAI) await saveMeta('themeAI', { ...(S.meta.themeAI || {}), ...data.meta.themeAI });
  S.themes = null;
  return (data.items || []).length;
}
function renderGeminiSettings() {
  const g = getGemini();
  $('#gemKey').value = g.key || '';
  const preset = GEMINI_MODELS.filter(([v]) => v !== '__custom'), extra = (g.available || []).filter((n) => !preset.some(([v]) => v === n));
  $('#gemModel').innerHTML = preset.map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join('')
    + (extra.length ? `<optgroup label="您的密钥可用的其他模型">${extra.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</optgroup>` : '')
    + '<option value="__custom">其他模型（手动填写）</option>';
  const known = [...preset.map(([v]) => v), ...extra];
  $('#gemModel').value = known.includes(g.model) || g.model === '__custom' ? g.model : '__custom';
  $('#gemCustom').value = g.model === '__custom' ? g.custom || '' : (known.includes(g.model) ? g.custom || '' : g.model);
  $('#gemConc').value = String(g.concurrency || 2);
  $('#gemCustomRow').hidden = $('#gemModel').value !== '__custom';
}
function aiProviderUI() { const gem = $('#aiProvider').value === 'gemini'; $$('.ai-openai').forEach((e) => (e.hidden = gem)); $$('.ai-gemini').forEach((e) => (e.hidden = !gem)); }
async function renderSettings() {
  renderGeminiSettings();
  const a = getAI(); $('#aiProvider').value = a.provider || 'openai'; $('#aiEndpoint').value = a.endpoint || ''; $('#aiKey').value = a.key || ''; $('#aiModel').value = a.model || ''; $('#aiGemModel').value = a.geminiModel || ''; aiProviderUI();
  if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); const persisted = await navigator.storage.persisted?.(); $('#storageInfo').textContent = `已用约 ${(e.usage / 1048576).toFixed(1)} MB / 可用配额约 ${(e.quota / 1073741824).toFixed(1)} GB · ${S.items.size} 个条目、${S.notes.size} 条笔记、${S.timeline.size} 条年表 · ${persisted ? '已启用持久存储' : '未启用持久存储（浏览器空间紧张时可能清理数据）'}`; }
}
function initSettings() {
  const saveGem = () => setGemini({ key: $('#gemKey').value.trim(), model: $('#gemModel').value, custom: $('#gemCustom').value.trim(), concurrency: +$('#gemConc').value });
  $('#gemModel').addEventListener('change', () => { $('#gemCustomRow').hidden = $('#gemModel').value !== '__custom'; });
  $('#gemSave').addEventListener('click', () => { saveGem(); applyEngineUI(); applyAIVisibility(); $('#gemStatus').textContent = ''; toast(`已保存 Gemini 设置（模型 ${esc(geminiModel())}；密钥仅存于本浏览器）`); });
  $('#gemList').addEventListener('click', async () => {
    saveGem(); if (!geminiReady()) { $('#gemStatus').innerHTML = '<span class="err">请先填写 API Key。</span>'; return; }
    $('#gemStatus').textContent = '正在获取可用模型…';
    try { const names = await listModels(); setGemini({ available: names }); renderGeminiSettings(); $('#gemStatus').innerHTML = `<span class="good">✓</span> 您的密钥可使用 ${names.length} 个模型，已加入“模型”列表。`; }
    catch (e) { $('#gemStatus').innerHTML = `<span class="err">✗ ${esc(e.message)}</span>`; }
  });
  modelEvents.addEventListener('switched', (e) => { toast(`Gemini 模型 ${esc(e.detail.from)} 已不可用，已自动改用 ${esc(e.detail.to)}`, 6000); applyEngineUI(); if (location.hash.startsWith('#/settings')) renderGeminiSettings(); });
  $('#gemClear').addEventListener('click', () => { setGemini({ key: '' }); renderGeminiSettings(); applyEngineUI(); applyAIVisibility(); $('#gemStatus').textContent = ''; toast('已清除 Gemini 密钥'); });
  $('#gemTest').addEventListener('click', async () => {
    saveGem(); applyEngineUI(); applyAIVisibility();
    if (!geminiReady()) { $('#gemStatus').innerHTML = '<span class="err">请先填写 API Key。</span>'; return; }
    $('#gemStatus').textContent = `正在测试 ${geminiModel()}…`;
    try { const r = await testGemini({ onStatus: (m) => { $('#gemStatus').textContent = `正在测试 ${geminiModel()}… ${m}`; } }); $('#gemStatus').innerHTML = `<span class="good">✓ 连接成功</span> · 模型 ${esc(r.model)} · 回复：${esc(r.text.slice(0, 40))}`; }
    catch (e) { $('#gemStatus').innerHTML = `<span class="err">✗ ${esc(e.message)}</span>`; }
  });
  $('#aiProvider').addEventListener('change', aiProviderUI);
  $('#aiSave').addEventListener('click', () => { setAI({ provider: $('#aiProvider').value, endpoint: $('#aiEndpoint').value.trim(), key: $('#aiKey').value.trim(), model: $('#aiModel').value.trim(), geminiModel: $('#aiGemModel').value.trim() }); applyAIVisibility(); toast(aiEnabled() ? '已保存 AI 设置（仅存于本浏览器）' : ($('#aiProvider').value === 'gemini' ? '已保存。请在上方填写 Gemini API Key 后才能使用 AI 总结。' : '已保存。')); });
  $('#aiClear').addEventListener('click', () => { localStorage.removeItem('archive-ocr.ai'); renderSettings(); applyAIVisibility(); toast('已清除'); });
  $('#aiTest').addEventListener('click', async () => { $('#aiSave').click(); $('#aiStatus').textContent = '测试中…'; try { const r = await chat('请只回复“连接成功”。'); $('#aiStatus').textContent = '✓ ' + r.slice(0, 80); } catch (e) { $('#aiStatus').textContent = '✗ ' + e.message; } });
  $('#backupBtn').addEventListener('click', backup);
  $('#restoreBtn').addEventListener('click', () => $('#restoreIn').click());
  $('#restoreIn').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { const n = await restore(f); toast(`已导入备份：${n} 个条目`); renderSettings(); } catch (err) { toast('导入失败：' + esc(err.message), 5000); } });
  $('#persistBtn').addEventListener('click', async () => { const ok = await navigator.storage?.persist?.(); toast(ok ? '已启用持久存储' : '浏览器未授予持久存储'); renderSettings(); });
  $('#wipeBtn').addEventListener('click', async () => {
    if (!confirm('确定清空全部档案、笔记与年表？建议先导出备份。此操作不可撤销。')) return;
    for (const s of ['items', 'notes', 'timeline', 'meta']) await db.clear(s);
    S.items.clear(); S.notes.clear(); S.timeline.clear(); S.dismissed.clear(); S.meta = {}; S.themes = null; toast('已清空'); renderSettings();
  });
}
function applyAIVisibility() { document.body.classList.toggle('ai-on', aiEnabled()); }

// ---------- router ----------
function route() {
  const h = location.hash || '#/library';
  const [path, qs] = h.slice(2).split('?');
  const [view, a, b] = path.split('/');
  const v = view || 'library';
  $$('.view').forEach((s) => (s.hidden = s.id !== 'view-' + v));
  $$('#tabs a').forEach((x) => x.classList.toggle('on', x.dataset.view === v || (v === 'item' && x.dataset.view === 'library')));
  $('#selPop').hidden = true;
  if (v === 'library') renderLibrary();
  else if (v === 'item') renderItem(a, b ? +b - 1 : undefined);
  else if (v === 'search') { fillSelects(); const q = new URLSearchParams(qs || '').get('q'); if (q != null) $('#q').value = q; runSearch(); }
  else if (v === 'timeline') renderTimeline();
  else if (v === 'themes') renderThemes();
  else if (v === 'notes') renderNotes(a);
  else if (v === 'settings') renderSettings();
  window.scrollTo(0, 0);
}
function rerenderCurrent() { const v = (location.hash.slice(2).split(/[/?]/)[0]) || 'library'; if (v === 'library') renderLibrary(); }

async function init() {
  const [items, notes, tl, meta] = await Promise.all([db.getAll('items'), db.getAll('notes'), db.getAll('timeline'), db.getAll('meta')]);
  for (const it of items) { if (it.status === 'processing') { it.status = it.pages?.some((p) => p.status === 'done') ? 'done' : 'error'; it.error = it.error || '上次处理被中断，请重新导入或重新识别'; } S.items.set(it.id, it); }
  for (const n of notes) S.notes.set(n.id, n);
  for (const e of tl) S.timeline.set(e.id, e);
  for (const m of meta) S.meta[m.key] = m.value;
  S.dismissed = new Set(S.meta.dismissed || []);
  initOcrSettings(); initImport(); initLibrary(); initTimeline(); initSearch(); initThemes(); initNotes(); initSettings(); initSelPop(); initExportRows(); applyAIVisibility();
  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = S.items.size ? '#/library' : '#/import'; else route();
  window.__ready = true;
}
init().catch((e) => { console.error(e); document.body.insertAdjacentHTML('afterbegin', `<p class="err" style="padding:1rem">启动失败：${esc(e.message)}</p>`); });
