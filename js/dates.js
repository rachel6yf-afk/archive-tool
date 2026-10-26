// Date extraction for Chinese & Western formats. Pure functions, no DOM.
const CN_DIGIT = { '〇': 0, '○': 0, '零': 0, 'О': 0, '一': 1, '壹': 1, '二': 2, '贰': 2, '貳': 2, '两': 2, '兩': 2, '三': 3, '叁': 3, '參': 3, '四': 4, '肆': 4, '五': 5, '伍': 5, '六': 6, '陆': 6, '陸': 6, '七': 7, '柒': 7, '八': 8, '捌': 8, '九': 9, '玖': 9 };

// Parse Chinese numerals: positional (二十六, 廿三) or digit-by-digit (一九三七).
export function cnToNumber(s) {
  if (s == null) return NaN;
  s = String(s).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s === '元' || s === '正') return 1;
  if (s === '冬') return 11;
  if (s === '腊' || s === '臘') return 12;
  s = s.replace(/^初/, '');
  s = s.replace(/廿/g, '二十').replace(/卅/g, '三十').replace(/拾/g, '十').replace(/佰/g, '百');
  if (!/[十百千]/.test(s)) {           // digit-wise
    let n = 0;
    for (const ch of s) { if (!(ch in CN_DIGIT)) return NaN; n = n * 10 + CN_DIGIT[ch]; }
    return n;
  }
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch in CN_DIGIT) cur = CN_DIGIT[ch];
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
    else if (ch === '千') { total += (cur || 1) * 1000; cur = 0; }
    else return NaN;
  }
  return total + cur;
}

// Era name -> Gregorian year of era year 1. lunar: month/day are lunar calendar.
export const ERAS = {
  '民国': { base: 1912, lunar: false, label: '民国' }, '民國': { base: 1912, lunar: false, label: '民国' },
  '中华民国': { base: 1912, lunar: false, label: '民国' }, '中華民國': { base: 1912, lunar: false, label: '民国' },
  '顺治': { base: 1644, lunar: true }, '順治': { base: 1644, lunar: true },
  '康熙': { base: 1662, lunar: true }, '雍正': { base: 1723, lunar: true }, '乾隆': { base: 1736, lunar: true },
  '嘉庆': { base: 1796, lunar: true }, '嘉慶': { base: 1796, lunar: true }, '道光': { base: 1821, lunar: true },
  '咸丰': { base: 1851, lunar: true }, '咸豐': { base: 1851, lunar: true }, '同治': { base: 1862, lunar: true },
  '光绪': { base: 1875, lunar: true }, '光緒': { base: 1875, lunar: true }, '宣统': { base: 1909, lunar: true }, '宣統': { base: 1909, lunar: true },
  '明治': { base: 1868, lunar: false }, '大正': { base: 1912, lunar: false }, '昭和': { base: 1926, lunar: false },
};
const ERA_RE = Object.keys(ERAS).sort((a, b) => b.length - a.length).join('|');
const CN = '[〇○零一二三四五六七八九十廿卅百千两壹贰貳叁參肆伍陆陸柒捌玖拾]';
const MONTHS_EN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

const pad = (n, w = 2) => String(n).padStart(w, '0');
function valid(y, m, d) {
  if (!(y >= 100 && y <= 2200)) return false;
  if (m != null && !(m >= 1 && m <= 12)) return false;
  if (d != null && !(d >= 1 && d <= 31)) return false;
  return true;
}
export function makeKey(y, m, d) { return pad(y, 4) + (m ? '-' + pad(m) : '') + (m && d ? '-' + pad(d) : ''); }
export function precisionOf(key) { return key.length >= 10 ? 'day' : key.length >= 7 ? 'month' : 'year'; }
export function displayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return `${y}年` + (m ? `${m}月` : '') + (d ? `${d}日` : '');
}

// Sentence-ish context around a match.
export function contextAround(text, start, end, max = 90) {
  const isStop = (i) => /[。！？；!?;]/.test(text[i]) || (text[i] === '\n' && !/[，、,：:（(]\s*$/.test(text.slice(Math.max(0, i - 3), i))) || (text[i] === '.' && /\s/.test(text[i + 1] || ' ') && !/\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mr|Mrs|Dr|St|No)$/.test(text.slice(Math.max(0, i - 5), i)));
  let a = start, b = end;
  while (a > 0 && start - a < max && !isStop(a - 1)) a--;
  while (b < text.length && b - end < max && !isStop(b)) b++;
  if (b < text.length && isStop(b)) b++;
  let s = text.slice(a, b).replace(/\s+/g, ' ').trim();
  if (a > 0 && !isStop(a - 1)) s = '…' + s;
  if (b < text.length && !isStop(b - 1)) s += '…';
  return s;
}

export function extractDates(text) {
  if (!text) return [];
  const out = [];
  const taken = [];
  const overlaps = (s, e) => taken.some(([a, b]) => s < b && e > a);
  function add(m, y, mo, d, extra = {}) {
    const s = m.index, e = m.index + m[0].length;
    if (overlaps(s, e)) return;
    if (!valid(y, mo, d)) return;
    taken.push([s, e]);
    const key = makeKey(y, mo, d);
    out.push({ key, precision: precisionOf(key), match: m[0].trim(), index: s, context: contextAround(text, s, e), ...extra });
  }
  const run = (re, fn) => { re.lastIndex = 0; let m; while ((m = re.exec(text))) fn(m); };

  // 1. Era dates: 民国二十六年七月七日, 光绪三十年, 宣統元年
  run(new RegExp(`(${ERA_RE})\\s*(元|${CN}{1,4}|\\d{1,3})\\s*年(?:\\s*(闰|閏)?\\s*(${CN}{1,3}|\\d{1,2}|正|冬|腊|臘)\\s*月(?:\\s*(初?${CN}{1,3}|\\d{1,2})\\s*[日号號])?)?`, 'g'), (m) => {
    const era = ERAS[m[1]]; const n = cnToNumber(m[2]);
    if (!(n >= 1 && n <= 70)) return;
    const y = era.base + n - 1;
    const mo = m[4] ? cnToNumber(m[4]) : null; const d = m[5] ? cnToNumber(m[5]) : null;
    if (era.lunar) {
      add(m, y, null, null, { era: m[1], note: `${m[1]}${m[2]}年 ≈ 公元${y}年` + (mo ? `（原文为农历${m[4]}月${m[5] ? m[5] + '日' : ''}，未换算）` : '') });
    } else add(m, y, mo, d, { era: m[1], note: `${m[1]}${m[2]}年 = 公元${y}年` });
  });
  // 2. Arabic numerals with 年月日: 1937年7月7日
  run(/(\d{3,4})\s*年(?:\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*[日号號])?)?/g, (m) => add(m, +m[1], m[2] ? +m[2] : null, m[3] ? +m[3] : null));
  // 3. Chinese digit-wise year: 一九三七年七月七日
  run(new RegExp(`([〇○零一二三四五六七八九]{4})\\s*年(?:\\s*(${CN}{1,3})\\s*月(?:\\s*(${CN}{1,3})\\s*[日号號])?)?`, 'g'), (m) =>
    add(m, cnToNumber(m[1]), m[2] ? cnToNumber(m[2]) : null, m[3] ? cnToNumber(m[3]) : null));
  // 4. ISO-like 1937-07-07 / 1937.7.7 / 1937/07/07
  run(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g, (m) => add(m, +m[1], +m[2], +m[3]));
  // 5. July 7, 1937 / Jul. 7th 1937
  run(new RegExp(`\\b${MON_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), (m) => add(m, +m[3], MONTHS_EN[m[1].slice(0, 3).toLowerCase()], +m[2]));
  // 6. 7 July 1937
  run(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON_RE}\\.?,?\\s+(\\d{4})\\b`, 'gi'), (m) => add(m, +m[3], MONTHS_EN[m[2].slice(0, 3).toLowerCase()], +m[1]));
  // 7. 7/7/1937 (US M/D/Y; if first > 12 treat as D/M/Y)
  run(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g, (m) => {
    let a = +m[1], b = +m[2];
    if (a > 12 && b <= 12) [a, b] = [b, a];
    add(m, +m[3], a, b);
  });
  // 8. July 1937
  run(new RegExp(`\\b${MON_RE}\\.?,?\\s+(\\d{4})\\b`, 'gi'), (m) => add(m, +m[2], MONTHS_EN[m[1].slice(0, 3).toLowerCase()], null));
  // 9. "in 1937"
  run(/\b(?:in|since|by|during|until|from|year)\s+(1[5-9]\d\d|20\d\d)\b/gi, (m) => add(m, +m[1], null, null));
  return out.sort((a, b) => a.index - b.index);
}
