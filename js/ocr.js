// OCR worker pool (Tesseract.js), page rasterization and preprocessing.
const VENDOR = new URL('../vendor/', import.meta.url).href;
const CDN_LANG = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data';
let localOK = null;
async function checkLocal() {
  if (localOK !== null) return localOK;
  try { const r = await fetch(VENDOR + 'tesseract/worker.min.js', { method: 'HEAD' }); localOK = r.ok; } catch { localOK = false; }
  return localOK;
}
async function hasLocalLang(l) { try { return (await fetch(`${VENDOR}lang/${l}.traineddata.gz`, { method: 'HEAD' })).ok; } catch { return false; } }

export const LANGS = [
  ['chi_sim', '简体中文'], ['chi_tra', '繁体中文'], ['eng', '英语'], ['jpn', '日语'], ['fra', '法语'], ['deu', '德语'],
  ['spa', '西班牙语'], ['ita', '意大利语'], ['por', '葡萄牙语'], ['nld', '荷兰语'], ['rus', '俄语'], ['lat', '拉丁语'],
];

// Remove spaces Tesseract inserts between CJK characters (important for search & reading).
export function cleanText(t) {
  const C = '\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
  return (t || '')
    .replace(new RegExp(`([${C}])[ \\t]+(?=[${C}])`, 'g'), '$1')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export class OcrPool {
  constructor() { this.workers = []; this.key = ''; this.queue = []; this.creating = null; }
  async configure({ langs, psm, size }) {
    const key = JSON.stringify([langs, psm, size]);
    if (key === this.key && this.workers.length) return;
    await this.idle();
    await this.terminate();
    this.key = key;
    this.creating = this._create(langs, psm, size);
    await this.creating; this.creating = null;
  }
  async _create(langs, psm, size) {
    const local = await checkLocal();
    const allLocal = local && (await Promise.all(langs.map(hasLocalLang))).every(Boolean);
    const opts = {};
    if (local) { opts.workerPath = VENDOR + 'tesseract/worker.min.js'; opts.corePath = VENDOR + 'tesseract/'; }
    if (allLocal) { opts.langPath = VENDOR + 'lang'; opts.cacheMethod = 'none'; }
    else if (!local) { /* full CDN defaults */ }
    for (let i = 0; i < size; i++) {
      const slot = { busy: false, job: null };
      slot.w = await Tesseract.createWorker(langs, 1 /* LSTM: best for printed text */, {
        ...opts,
        logger: (m) => { if (slot.job && m.status === 'recognizing text') slot.job.onProgress?.(m.progress); },
      });
      await slot.w.setParameters({
        tessedit_pageseg_mode: String(psm),
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      });
      this.workers.push(slot);
    }
    this._pump();
  }
  recognize(canvas, onProgress) {
    return new Promise((resolve, reject) => { this.queue.push({ canvas, onProgress, resolve, reject }); this._pump(); });
  }
  _pump() {
    for (const slot of this.workers) {
      if (slot.busy || !this.queue.length) continue;
      const job = this.queue.shift();
      slot.busy = true; slot.job = job;
      slot.w.recognize(job.canvas).then((r) => job.resolve(r.data), job.reject).finally(() => {
        slot.busy = false; slot.job = null; this._pump(); this._checkIdle();
      });
    }
  }
  _checkIdle() { if (!this.queue.length && this.workers.every((w) => !w.busy)) { const f = this._idleWaiters || []; this._idleWaiters = []; f.forEach((r) => r()); } }
  idle() { if (!this.queue.length && this.workers.every((w) => !w.busy)) return Promise.resolve(); return new Promise((r) => (this._idleWaiters = [...(this._idleWaiters || []), r])); }
  async terminate() { for (const s of this.workers) try { await s.w.terminate(); } catch {} this.workers = []; }
}

// ---------- Preprocessing ----------
export function preprocess(src, { gray = true, contrast = false, threshold = false, invert = false, upscale = true } = {}) {
  let w = src.width, h = src.height;
  // Upscale small scans: Tesseract prefers ~300 dpi text (x-height 20px+).
  let scale = 1;
  if (upscale && Math.max(w, h) < 1400) scale = Math.min(2.5, 1400 / Math.max(w, h));
  const MAX = 5000; if (Math.max(w, h) * scale > MAX) scale = MAX / Math.max(w, h);
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  if (!gray && !contrast && !threshold && !invert) return c;
  const img = ctx.getImageData(0, 0, c.width, c.height); const d = img.data;
  const lum = new Uint8ClampedArray(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) lum[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  if (contrast) {
    const hist = new Uint32Array(256); for (const v of lum) hist[v]++;
    const n = lum.length; let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > n * 0.01) { lo = i; break; } }
    acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > n * 0.01) { hi = i; break; } }
    const r = Math.max(1, hi - lo); for (let j = 0; j < lum.length; j++) lum[j] = ((lum[j] - lo) * 255) / r;
  }
  if (threshold) {
    const hist = new Uint32Array(256); for (const v of lum) hist[v]++;
    const total = lum.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, t = 127;
    for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = total - wB; if (!wF) break; sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2; if (between > best) { best = between; t = i; } }
    for (let j = 0; j < lum.length; j++) lum[j] = lum[j] > t ? 255 : 0;
  }
  if (invert) for (let j = 0; j < lum.length; j++) lum[j] = 255 - lum[j];
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { d[i] = d[i + 1] = d[i + 2] = lum[j]; }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function canvasToBlob(canvas, maxDim = 2200, type = 'image/jpeg', q = 0.85) {
  let c = canvas;
  const m = Math.max(canvas.width, canvas.height);
  if (m > maxDim) {
    c = document.createElement('canvas'); const s = maxDim / m;
    c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(canvas, 0, 0, c.width, c.height);
  }
  return new Promise((r) => c.toBlob(r, type, q));
}

// Words with low confidence, as fractional boxes (resolution independent).
export function lowConfidenceWords(data, W, H, limit = 55) {
  let words = data.words;
  if (!words && data.blocks) { words = []; for (const b of data.blocks) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) words.push(w); }
  return (words || []).filter((w) => w.confidence < limit && w.text.trim()).slice(0, 400)
    .map((w) => [w.bbox.x0 / W, w.bbox.y0 / H, (w.bbox.x1 - w.bbox.x0) / W, (w.bbox.y1 - w.bbox.y0) / H, w.text, Math.round(w.confidence)]);
}
