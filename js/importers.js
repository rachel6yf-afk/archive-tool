// Turn files into archive items. Images/PDF/TIFF/HEIC -> page sources for OCR; Word/Excel/CSV/TXT -> text.
let pdfjs = null;
async function getPdfjs() {
  if (pdfjs) return pdfjs;
  try {
    pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  } catch (e) {
    pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4/legacy/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/legacy/build/pdf.worker.min.mjs';
  }
  return pdfjs;
}

export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'webp', 'bmp', 'gif', 'heic', 'heif', 'pdf', 'jfif'];
export const DOC_EXT = ['docx', 'doc', 'xlsx', 'xls', 'csv', 'txt', 'md', 'ods', 'odt'];
export const ext = (name) => (name.split('.').pop() || '').toLowerCase();
export const isImageLike = (f) => IMAGE_EXT.includes(ext(f.name)) || /^image\//.test(f.type) || f.type === 'application/pdf';
export const isDocLike = (f) => DOC_EXT.includes(ext(f.name));
export const titleFromName = (n) => n.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');

function canvasFromBitmap(bmp) { const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0); return c; }
async function blobToCanvas(blob) {
  try { return canvasFromBitmap(await createImageBitmap(blob)); }
  catch {
    const url = URL.createObjectURL(blob);
    try { const img = new Image(); img.src = url; await img.decode(); return canvasFromBitmap(img); } finally { URL.revokeObjectURL(url); }
  }
}

// Returns { type, pages: [{ render: async (opts) => ({canvas, text?}) }], cleanup }
export async function openVisual(file, { pdfScale = 2.5, usePdfText = true } = {}) {
  const e = ext(file.name);
  if (e === 'pdf' || file.type === 'application/pdf') {
    const lib = await getPdfjs();
    const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) pages.push({
      render: async () => {
        const page = await pdf.getPage(i);
        let text = null;
        if (usePdfText) {
          const tc = await page.getTextContent();
          const t = tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('');
          if (t.replace(/\s/g, '').length >= 20) text = t;
        }
        const vp = page.getViewport({ scale: pdfScale });
        const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        page.cleanup();
        return { canvas: c, text };
      },
    });
    return { type: 'pdf', pages, cleanup: () => pdf.destroy() };
  }
  if (e === 'tif' || e === 'tiff' || file.type === 'image/tiff') {
    const buf = await file.arrayBuffer();
    const ifds = UTIF.decode(buf).filter((f) => f.t256 && f.t257);
    return {
      type: 'tiff',
      pages: ifds.map((ifd) => ({
        render: async () => {
          UTIF.decodeImage(buf, ifd);
          const rgba = UTIF.toRGBA8(ifd);
          const c = document.createElement('canvas'); c.width = ifd.width; c.height = ifd.height;
          c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, ifd.width * ifd.height * 4), ifd.width, ifd.height), 0, 0);
          return { canvas: c };
        },
      })),
    };
  }
  if (e === 'heic' || e === 'heif' || /heic|heif/.test(file.type)) {
    let out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92, multiple: true });
    if (!Array.isArray(out)) out = [out];
    return { type: 'heic', pages: out.map((b) => ({ render: async () => ({ canvas: await blobToCanvas(b) }) })) };
  }
  return { type: 'image', pages: [{ render: async () => ({ canvas: await blobToCanvas(file) }) }] };
}

// Legacy .doc: heuristic extraction of UTF-16LE text runs (works for many Word 97-2003 files).
function extractDocBinary(buf) {
  const u8 = new Uint8Array(buf);
  const out = []; let cur = '';
  for (let i = 0; i + 1 < u8.length; i += 2) {
    const code = u8[i] | (u8[i + 1] << 8);
    const ok = (code >= 0x20 && code < 0x7f) || code === 0x0d || code === 0x0a || code === 0x09 || (code >= 0x3000 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef) || (code >= 0xc0 && code <= 0x24f) || code === 0x2018 || code === 0x2019 || code === 0x201c || code === 0x201d;
    if (ok) cur += code === 0x0d ? '\n' : String.fromCharCode(code);
    else { if (cur.replace(/\s/g, '').length >= 6) out.push(cur); cur = ''; }
  }
  if (cur.replace(/\s/g, '').length >= 6) out.push(cur);
  // keep runs that look like prose (CJK or several words)
  return out.filter((s) => /[\u4e00-\u9fff]{2,}|[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(s) && !/^(Microsoft|Times New Roman|Normal|Default Paragraph|WordDocument|SummaryInformation)/.test(s.trim())).join('\n').trim();
}

function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { try { return new TextDecoder('gb18030').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); } }
}

export async function extractDocument(file) {
  const e = ext(file.name);
  const buf = await file.arrayBuffer();
  if (e === 'docx' || e === 'odt') {
    if (e === 'odt') return { type: 'odt', text: await odtText(buf) };
    const r = await mammoth.extractRawText({ arrayBuffer: buf });
    return { type: 'docx', text: r.value.replace(/\n{3,}/g, '\n\n').trim(), warning: r.messages?.length ? r.messages.map((m) => m.message).join('; ') : '' };
  }
  if (e === 'doc') return { type: 'doc', text: extractDocBinary(buf), warning: '旧版 .doc 为实验性提取，格式和部分文字可能丢失；建议另存为 .docx。' };
  if (e === 'txt' || e === 'md') return { type: 'txt', text: decodeText(buf) };
  if (['xlsx', 'xls', 'csv', 'ods'].includes(e)) {
    const wb = e === 'csv' ? XLSX.read(decodeText(buf), { type: 'string', cellDates: true }) : XLSX.read(buf, { type: 'array', cellDates: true });
    const parts = [];
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, dateNF: 'yyyy-mm-dd', blankrows: false, defval: '' });
      const lines = rows.map((r) => r.map((c) => String(c ?? '').trim()).join('\t').replace(/\t+$/, '')).filter((l) => l.trim());
      if (lines.length) parts.push((wb.SheetNames.length > 1 ? `【工作表：${name}】\n` : '') + lines.join('\n'));
    }
    return { type: e === 'csv' ? 'csv' : 'xlsx', text: parts.join('\n\n') };
  }
  throw new Error('不支持的文件类型：' + e);
}

async function odtText(buf) {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('content.xml').async('string');
  return xml.replace(/<text:p[^>]*>/g, '\n').replace(/<text:tab\/>/g, '\t').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}
