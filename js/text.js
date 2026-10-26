import { T2S } from './t2s.js';
// Tokenization, search, TF-IDF keywords and theme clustering. Works for Chinese via character n-grams.
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const STOP_CHARS = new Set('的了是在和与與及也而之其于於为為以所这這那有个個们們中上下不就都把被等对對或但并並即从從到由向将將此彼乃则則者矣焉哉乎兮曰又亦且若如因已经經还還很更最再才只每各该該该本该另某其些么麼呢吗嗎吧啊着著过過给給让讓使由於之一'.split(''));
const STOP_BIGRAMS = new Set(['我们', '他们', '你们', '一个', '没有', '可以', '这个', '那个', '因为', '所以', '如果', '已经', '以及', '进行', '进行', '时候', '什么', '自己', '这些', '那些', '其中', '方面', '问题', '情况', '工作', '同时', '由于', '但是', '而且', '就是', '还是', '只是', '不是', '这样', '那样', '以后', '以前', '之后', '之前', '当时', '目前', '现在', '今天', '关于', '对于', '通过', '根据', '一些', '一般', '可能', '应该', '需要', '表示', '认为', '成为', '开始', '公元', '民国', '民國']);
const DATE_CHARS = /[年月日号號〇○零一二三四五六七八九十廿卅百千两元初]/;
const EN_STOP = new Set('the a an and or but of to in on at for from by with as is are was were be been being this that these those it its into than then there their they them he she his her we our you your i not no yes do does did done have has had will would shall should can could may might must also which who whom whose what when where why how all any each other some such only own same so too very just over under again further once here more most about above below between both during before after up down out off upon per via et la le les de des du un une der die das und den dem ein eine el los las del y que en il di che non est ad cum'.split(' '));

// NFKC + lowercase + fold Traditional -> Simplified (length preserving per char), so 學堂 matches 学堂.
export function normalize(s) {
  const t = (s || '').normalize('NFKC').toLowerCase();
  let out = '';
  for (const ch of t) out += T2S.get(ch) || ch;
  return out;
}
export function toSimplified(s) { let o = ''; for (const ch of s || '') o += T2S.get(ch) || ch; return o; }

export function tokenize(text) {
  const t = normalize(text);
  const toks = [];
  let m;
  CJK_RUN.lastIndex = 0;
  while ((m = CJK_RUN.exec(t))) {
    const run = m[0];
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (STOP_CHARS.has(bg[0]) || STOP_CHARS.has(bg[1])) continue;
      if (STOP_BIGRAMS.has(bg)) continue;
      if (DATE_CHARS.test(bg[0]) && DATE_CHARS.test(bg[1])) continue;
      if (/[年月日号號]/.test(bg)) continue;
      if (/[〇○零一二三四五六七八九十廿卅百千]/.test(bg[1]) && !/[〇○零一二三四五六七八九十廿卅百千第]/.test(bg[0])) continue;
      toks.push(bg);
    }
  }
  const lat = t.replace(CJK_RUN, ' ').match(/[a-zà-ɏ][a-zà-ɏ'’-]{2,}/g) || [];
  for (const w of lat) if (!EN_STOP.has(w)) toks.push(w);
  return toks;
}

function counts(arr) { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; }

// Build TF-IDF vectors. docs: [{id, text}]
export function tfidf(docs, topN = 80) {
  const tfs = docs.map((d) => counts(tokenize(d.text)));
  const df = new Map();
  for (const tf of tfs) for (const k of tf.keys()) df.set(k, (df.get(k) || 0) + 1);
  const N = docs.length;
  return docs.map((d, i) => {
    const tf = tfs[i];
    const v = new Map();
    for (const [k, c] of tf) {
      const isCjk = CJK.test(k);
      if (!isCjk && c < 1) continue;
      const w = (1 + Math.log(c)) * (N >= 3 ? Math.log((N + 1) / (df.get(k) + 0.5)) : 1);
      v.set(k, w);
    }
    const top = [...v.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
    const norm = Math.sqrt(top.reduce((s, [, w]) => s + w * w, 0)) || 1;
    return { id: d.id, vec: new Map(top.map(([k, w]) => [k, w / norm])) };
  });
}

function cosine(a, b) { let s = 0; const [x, y] = a.size < b.size ? [a, b] : [b, a]; for (const [k, w] of x) { const v = y.get(k); if (v) s += w * v; } return s; }

// Extend bigram keywords to longer n-grams when they co-occur (卢沟 + 沟桥 -> 卢沟桥).
export function refineKeywords(keys, corpus, limit = 8) {
  const t = normalize(corpus);
  const countOf = (s) => { let n = 0, i = -1; while ((i = t.indexOf(s, i + 1)) !== -1) n++; return n; };
  const out = [];
  for (const k of keys) {
    let best = k;
    if (CJK.test(k) && k.length === 2) {
      const base = countOf(k);
      const cands = new Map();
      let i = -1;
      while ((i = t.indexOf(k, i + 1)) !== -1) {
        for (const [a, b] of [[i - 1, i + 2], [i, i + 3], [i - 1, i + 3], [i - 2, i + 2], [i, i + 4]]) {
          if (a < 0 || b > t.length) continue;
          const s = t.slice(a, b);
          if ([...s].every((c) => CJK.test(c) && !STOP_CHARS.has(c)) && !/[年月日]/.test(s)) cands.set(s, (cands.get(s) || 0) + 1);
        }
      }
      let bestC = 0;
      for (const [s, c] of cands) if (c >= Math.max(2, base * 0.75) && (c > bestC || (c === bestC && s.length > best.length))) { best = s; bestC = c; }
    }
    // merge overlapping fragments: 卢沟桥事 + 沟桥事变 -> 卢沟桥事变
    let merged = false;
    for (let j = 0; j < out.length && !merged; j++) {
      const o = out[j];
      if (o.includes(best)) { merged = true; break; }
      if (best.includes(o)) { out[j] = best; merged = true; break; }
      for (let ov = Math.min(o.length, best.length) - 1; ov >= 1; ov--) {
        if (o.length + best.length - ov <= 5 && o.endsWith(best.slice(0, ov)) && countOf(o + best.slice(ov)) >= 2) { out[j] = o + best.slice(ov); merged = true; break; }
        if (o.length + best.length - ov <= 5 && best.endsWith(o.slice(0, ov)) && countOf(best + o.slice(ov)) >= 2) { out[j] = best + o.slice(ov); merged = true; break; }
      }
    }
    if (!merged) out.push(best);
    if (out.length >= limit) break;
  }
  return out;
}

export function itemKeywords(vecEntry, n = 8) { return [...vecEntry.vec.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k); }

// Greedy centroid clustering into themes.
export function buildThemes(docs, { threshold = 0.1, maxThemes = 12 } = {}) {
  docs = docs.filter((d) => (d.text || '').trim().length > 0);
  if (!docs.length) return [];
  const vecs = tfidf(docs);
  // user tags are strong thematic signals: add them as extra features, then renormalize
  vecs.forEach((v, i) => {
    const tags = docs[i].tags || [];
    if (!tags.length) return;
    for (const t of tags) v.vec.set('#' + normalize(t), 0.6);
    const norm = Math.sqrt([...v.vec.values()].reduce((s, w) => s + w * w, 0)) || 1;
    for (const [k, w] of v.vec) v.vec.set(k, w / norm);
  });
  const byId = new Map(docs.map((d) => [d.id, d]));
  const order = vecs.map((v, i) => ({ v, len: docs[i].text.length })).sort((a, b) => b.len - a.len).map((x) => x.v);
  const clusters = [];
  for (const v of order) {
    let best = null, bestS = 0;
    for (const c of clusters) { const s = cosine(v.vec, c.centroidNorm); if (s > bestS) { bestS = s; best = c; } }
    if (best && bestS >= threshold) { best.members.push(v); addTo(best, v); }
    else { const c = { members: [v], centroid: new Map() }; addTo(c, v); clusters.push(c); }
  }
  function addTo(c, v) {
    for (const [k, w] of v.vec) c.centroid.set(k, (c.centroid.get(k) || 0) + w);
    const norm = Math.sqrt([...c.centroid.values()].reduce((s, w) => s + w * w, 0)) || 1;
    c.centroidNorm = new Map([...c.centroid].map(([k, w]) => [k, w / norm]));
  }
  clusters.sort((a, b) => b.members.length - a.members.length);
  return clusters.slice(0, maxThemes).map((c, i) => {
    const corpus = c.members.map((m) => byId.get(m.id).text).join('\n');
    const ncorp = normalize(corpus);
    const freq = (k) => { let n = 0, i = -1; while ((i = ncorp.indexOf(k, i + 1)) !== -1) n++; return n; };
    // prefer terms that recur (filters bigram boundary noise), then by weight
    const tagKeys = [...c.centroid.entries()].filter(([k]) => k[0] === '#').sort((a, b) => b[1] - a[1]).map(([k]) => k.slice(1));
    const raw = [...c.centroid.entries()].filter(([k]) => k[0] !== '#').sort((a, b) => (freq(b[0]) >= 2) - (freq(a[0]) >= 2) || b[1] - a[1]).slice(0, 30).map(([k]) => k);
    const keywords = [...new Set([...tagKeys.slice(0, 2), ...refineKeywords(raw, corpus, 10)])].slice(0, 10);
    const items = c.members.map((m) => ({ id: m.id, score: cosine(m.vec, c.centroidNorm), keywords: refineKeywords(itemKeywords(m, 20).filter((k) => k[0] !== '#'), byId.get(m.id).text, 5) })).sort((a, b) => b.score - a.score);
    return { id: 'theme-' + i, label: keywords.slice(0, 3).join(' · ') || '未命名主题', keywords, items, excerpts: excerpts(c.members.map((m) => byId.get(m.id)), keywords.slice(0, 6)) };
  });
}

export function splitSentences(text) {
  return (text || '').replace(/\r/g, '').split(/(?<=[。！？；!?;\n])|(?<=\.)\s+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 6);
}

function excerpts(docs, keywords, n = 3) {
  const scored = [];
  for (const d of docs) for (const s of splitSentences(d.text)) {
    const ns = normalize(s);
    const hits = keywords.filter((k) => ns.includes(k)).length;
    if (hits) scored.push({ id: d.id, text: s.length > 160 ? s.slice(0, 160) + '…' : s, score: hits + Math.min(s.length, 80) / 400 });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = [], seen = new Set();
  for (const s of scored) { if (seen.has(s.text)) continue; seen.add(s.text); out.push(s); if (out.length >= n) break; }
  return out;
}

// ---- Search ----
export function parseQuery(q) {
  const terms = [];
  const re = /"([^"]+)"|“([^”]+)”|(\S+)/g; let m;
  while ((m = re.exec(q || ''))) terms.push(normalize(m[1] || m[2] || m[3]));
  return terms.filter(Boolean);
}
export function matchesAll(text, terms) { const t = normalize(text); return terms.every((k) => t.includes(k)); }

export function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

export function highlight(text, terms) {
  if (!terms.length) return escapeHtml(text);
  const t = normalize(text);
  // NFKC can change length; fall back to index mapping only when lengths agree
  const src = t.length === text.length ? text : t;
  const marks = [];
  for (const k of terms) { let i = -1; while ((i = t.indexOf(k, i + 1)) !== -1) marks.push([i, i + k.length]); }
  marks.sort((a, b) => a[0] - b[0]);
  let out = '', pos = 0;
  for (const [a, b] of marks) { if (a < pos) continue; out += escapeHtml(src.slice(pos, a)) + '<mark>' + escapeHtml(src.slice(a, b)) + '</mark>'; pos = b; }
  return out + escapeHtml(src.slice(pos));
}

export function snippets(text, terms, { radius = 40, max = 3 } = {}) {
  const t = normalize(text);
  const src = t.length === text.length ? text : t;
  const spots = [];
  for (const k of terms) { let i = -1, c = 0; while ((i = t.indexOf(k, i + 1)) !== -1 && c < 3) { spots.push(i); c++; } }
  spots.sort((a, b) => a - b);
  const ranges = [];
  for (const p of spots) {
    const a = Math.max(0, p - radius), b = Math.min(src.length, p + radius * 2);
    const last = ranges[ranges.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else ranges.push([a, b]);
  }
  return ranges.slice(0, max).map(([a, b]) => (a > 0 ? '…' : '') + highlight(src.slice(a, b).replace(/\s+/g, ' '), terms) + (b < src.length ? '…' : ''));
}
