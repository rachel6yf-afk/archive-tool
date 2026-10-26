// Export helpers: download, .docx (built with JSZip), .md, .txt, .csv, .xlsx, JSON backup.
export function download(name, data, type = 'text/plain;charset=utf-8') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export const safeName = (s) => (s || 'export').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80);
const xmlEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

// blocks: [{t:'h1'|'h2'|'h3'|'p'|'quote'|'meta', text}]
export function blocksToMarkdown(blocks) {
  return blocks.map((b) => {
    const txt = b.text ?? '';
    if (b.t === 'h1') return `# ${txt}\n`; if (b.t === 'h2') return `## ${txt}\n`; if (b.t === 'h3') return `### ${txt}\n`;
    if (b.t === 'quote') return txt.split('\n').map((l) => '> ' + l).join('\n') + '\n';
    if (b.t === 'meta') return `*${txt}*\n`;
    return txt + '\n';
  }).join('\n');
}
export function blocksToText(blocks) {
  return blocks.map((b) => {
    const txt = b.text ?? '';
    if (b.t === 'h1') return `${txt}\n${'='.repeat(Math.min(40, txt.length * 2))}`;
    if (b.t === 'h2') return `\n【${txt}】`; if (b.t === 'h3') return `■ ${txt}`;
    if (b.t === 'quote') return txt.split('\n').map((l) => '    ' + l).join('\n');
    return txt;
  }).join('\n');
}
export async function blocksToDocx(blocks) {
  const para = (b) => {
    const style = { h1: 'Heading1', h2: 'Heading2', h3: 'Heading3', quote: 'Quote', meta: 'Meta' }[b.t];
    const runs = String(b.text ?? '').split('\n').map((line, i) => (i ? '<w:r><w:br/></w:r>' : '') + `<w:r><w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r>`).join('');
    return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs}</w:p>`;
  };
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocks.map(para).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const font = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="SimSun"/>';
  const st = (id, name, sz, extra = '') => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/>${extra}</w:pPr><w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="22"/><w:lang w:val="zh-CN" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
${st('Heading1', 'heading 1', 36)}${st('Heading2', 'heading 2', 28)}${st('Heading3', 'heading 3', 24)}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="567"/></w:pPr><w:rPr><w:color w:val="555555"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Meta"/><w:basedOn w:val="Normal"/><w:rPr><w:i/><w:color w:val="777777"/><w:sz w:val="18"/></w:rPr></w:style>
</w:styles>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('word/document.xml', doc);
  zip.file('word/styles.xml', styles);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
export async function exportBlocks(blocks, base, fmt) {
  if (fmt === 'docx') return download(base + '.docx', await blocksToDocx(blocks));
  if (fmt === 'md') return download(base + '.md', blocksToMarkdown(blocks), 'text/markdown;charset=utf-8');
  return download(base + '.txt', blocksToText(blocks));
}
export function rowsToCsv(rows) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '\ufeff' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
export function rowsToXlsx(rows, sheet = 'Sheet1') {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = rows[0].map((_, i) => ({ wch: Math.min(60, Math.max(8, ...rows.slice(0, 200).map((r) => String(r[i] ?? '').length * 1.6))) }));
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  return new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
export const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
export async function dataURLToBlob(u) { return (await fetch(u)).blob(); }
