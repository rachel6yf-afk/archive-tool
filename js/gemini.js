// Google Gemini (cloud) OCR + text generation, called directly from the browser via the REST API.
// The API key lives ONLY in localStorage ('archive-ocr.gemini') and is never written to backups or exports.
const KEY = 'archive-ocr.gemini';
const API = 'https://generativelanguage.googleapis.com/v1beta/models/';
// Default verified live on 2026-10-26: gemini-2.5-flash is "no longer available to new users"; the current stable Flash is gemini-3.8-flash.
export const GEMINI_MODELS = [
  ['gemini-3.8-flash', 'gemini-3.8-flash（推荐：当前 Flash，快速准确）'],
  ['gemini-flash-latest', 'gemini-flash-latest（始终指向最新 Flash）'],
  ['gemini-2.5-flash', 'gemini-2.5-flash（旧版；新用户可能已无法使用）'],
  ['gemini-pro-latest', 'gemini-pro-latest（Pro：更强、较慢、配额少）'],
  ['gemini-2.5-pro', 'gemini-2.5-pro（旧版 Pro）'],
  ['__custom', '其他模型（手动填写）'],
];
export const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULTS = { key: '', model: DEFAULT_MODEL, custom: '', concurrency: 2 };
export function getGemini() { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return { ...DEFAULTS }; } }
export function setGemini(s) { localStorage.setItem(KEY, JSON.stringify({ ...getGemini(), ...s })); }
export function clearGemini() { localStorage.removeItem(KEY); }
export function geminiModel(s = getGemini()) { return (s.model === '__custom' ? s.custom : s.model || DEFAULT_MODEL).trim().replace(/^models\//, '') || DEFAULT_MODEL; }
export function geminiReady() { return !!getGemini().key; }

// ---------- errors ----------
export class GeminiError extends Error {
  constructor(message, { status = 0, code = '', retryable = false, retryAfter = 0, partial = '' } = {}) { super(message); this.name = 'GeminiError'; Object.assign(this, { status, code, retryable, retryAfter, partial }); }
}
function parseDelay(s) { const m = String(s || '').match(/([\d.]+)\s*s/); return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0; }
async function toError(r) {
  let j = null, raw = '';
  try { raw = await r.text(); j = JSON.parse(raw); } catch { /* not json */ }
  const e = j?.error || {}; const msg = e.message || raw.slice(0, 200);
  const details = e.details || [];
  const reason = details.find((d) => d.reason)?.reason || e.status || '';
  const retryAfter = parseDelay(details.find((d) => d.retryDelay)?.retryDelay) || (+r.headers.get('retry-after') || 0) * 1000;
  const s = r.status;
  if (s === 400 && /API_KEY_INVALID|API key not valid|API key expired/i.test(raw)) return new GeminiError('Gemini 密钥无效或已过期，请在“设置”中检查 API Key。', { status: s, code: 'invalid_key' });
  if (s === 400 && /location is not supported|FAILED_PRECONDITION/i.test(raw)) return new GeminiError('当前所在地区不支持使用 Gemini API（Google 返回：' + msg.slice(0, 120) + '）。', { status: s, code: 'region' });
  if (s === 401 || s === 403) return new GeminiError('Gemini 拒绝访问（' + s + '）：密钥无权限，或该项目未启用 Generative Language API。' + (msg ? '（' + msg.slice(0, 120) + '）' : ''), { status: s, code: 'forbidden' });
  if (s === 404) return new GeminiError('找不到该模型或模型已停用（404）。请在“设置 → Gemini”中更换模型。' + (msg ? '（Google：' + msg.slice(0, 220) + '）' : ''), { status: s, code: 'model' });
  if (s === 400 && /thinking/i.test(raw)) return new GeminiError('该模型不支持当前的思考（thinking）参数。', { status: s, code: 'thinking' });
  if (s === 413) return new GeminiError('图像过大，请求被拒绝（413）。', { status: s, code: 'too_large' });
  if (s === 429) {
    const daily = /PerDay|per day|daily/i.test(raw);
    return new GeminiError(daily ? 'Gemini 今日免费配额已用完（429）。可明天再试、改用 Tesseract，或在 Google AI Studio 开通付费。' : 'Gemini 请求过于频繁或超出配额（429）。', { status: s, code: 'quota', retryable: !daily, retryAfter });
  }
  if (s >= 500) return new GeminiError(`Gemini 服务暂时不可用（${s}${reason ? ' ' + reason : ''}）${/high demand|overloaded/i.test(raw) ? '：该模型当前请求量过高' : ''}，请稍后再试，或在设置中换用其他模型。`, { status: s, code: 'server', retryable: true, retryAfter });
  return new GeminiError(`Gemini 请求失败（${s}）：${msg.slice(0, 200)}`, { status: s, code: 'http' });
}
const BLOCK_MSG = { SAFETY: '内容被 Gemini 安全策略拦截（SAFETY）', RECITATION: 'Gemini 因“疑似复述已出版内容”（RECITATION）中止了输出', PROHIBITED_CONTENT: '内容被 Gemini 判定为禁止内容', BLOCKLIST: '内容触发 Gemini 屏蔽词', SPII: '内容含敏感个人信息，Gemini 拒绝输出', OTHER: 'Gemini 拒绝处理该请求（OTHER）', IMAGE_SAFETY: '图像被 Gemini 安全策略拦截' };

// ---------- model discovery ----------
export async function listModels(key = getGemini().key) {
  const r = await fetch(API.replace(/\/$/, '') + '?pageSize=200', { headers: { 'x-goog-api-key': key } });
  if (!r.ok) throw await toError(r);
  const j = await r.json();
  return (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, '')).filter((n) => /^gemini-/.test(n) && !/tts|image|live|audio|embed|customtools/.test(n));
}
// Newest stable "gemini-X.Y-flash" (no -lite/-preview); falls back to the gemini-flash-latest alias.
export function pickBestFlash(names) {
  const v = names.map((n) => [n, n.match(/^gemini-(\d+(?:\.\d+)?)-flash$/)]).filter(([, m]) => m).sort((a, b) => parseFloat(b[1][1]) - parseFloat(a[1][1]));
  return v[0]?.[0] || (names.includes('gemini-flash-latest') ? 'gemini-flash-latest' : null);
}
export const modelEvents = new EventTarget();

// ---------- concurrency limiter ----------
let active = 0; const waiting = [];
async function acquire() { const lim = Math.max(1, Math.min(4, +getGemini().concurrency || 2)); if (active < lim) { active++; return; } await new Promise((r) => waiting.push(r)); active++; }
function release() { active--; const n = waiting.shift(); if (n) n(); }
export const _limiterState = () => ({ active, waiting: waiting.length });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const RETRY = { max: 4, serverMax: 2, baseMs: 1500, capMs: 60000 };

// Low-level generateContent with retry/backoff on 429/5xx/network errors.
const noThinking = new Set(); // models that rejected our thinkingConfig in this session
export async function generate(body, { model = geminiModel(), key = getGemini().key, onStatus, signal, maxRetries = RETRY.max, timeoutMs = 120000 } = {}) {
  if (!key) throw new GeminiError('尚未设置 Gemini API Key，请先在“设置”中填写。', { code: 'no_key' });
  let url = API + encodeURIComponent(model) + ':generateContent', modelSwitched = false;
  await acquire();
  try {
    for (let attempt = 0; ; attempt++) {
      let r, timedOut = false;
      if (noThinking.has(model) && body.generationConfig) delete body.generationConfig.thinkingConfig;
      const ac = new AbortController(), tm = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
      const onAbort = () => ac.abort(); signal?.addEventListener('abort', onAbort);
      try {
        r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: ac.signal });
        if (r.ok) { const j = await r.json(); return parseResponse(j); }
      } catch (e) {
        if (e instanceof GeminiError) throw e;
        if (signal?.aborted) throw e;
        const err = timedOut
          ? new GeminiError(`请求超时（${Math.round(timeoutMs / 1000)} 秒无响应），Gemini 服务可能繁忙。`, { code: 'timeout', retryable: true })
          : new GeminiError('网络错误：无法连接 Google Gemini 服务（请检查网络或代理设置；部分地区需特殊网络环境才能访问）。', { code: 'network', retryable: true });
        if (attempt >= (timedOut ? Math.min(1, maxRetries) : maxRetries)) throw err; // a hung request is retried only once
        const wait = Math.min(RETRY.capMs, RETRY.baseMs * 2 ** attempt);
        onStatus?.(`${timedOut ? '请求超时' : '网络错误'}，${Math.round(wait / 1000)} 秒后重试（第 ${attempt + 1}/${maxRetries} 次）`); await sleep(wait); continue;
      } finally { clearTimeout(tm); signal?.removeEventListener('abort', onAbort); }
      const err = await toError(r);
      if (err.code === 'thinking' && body.generationConfig?.thinkingConfig) { noThinking.add(model); delete body.generationConfig.thinkingConfig; attempt--; continue; }
      if (err.code === 'model' && !modelSwitched && getGemini().model !== '__custom' && model === geminiModel()) {
        // The chosen preset model was retired: pick the newest available Flash via ListModels, persist it and retry once.
        modelSwitched = true;
        const best = pickBestFlash(await listModels(key).catch(() => []));
        if (best && best !== model) {
          setGemini({ model: GEMINI_MODELS.some(([v]) => v === best) ? best : '__custom', custom: GEMINI_MODELS.some(([v]) => v === best) ? '' : best });
          modelEvents.dispatchEvent(new CustomEvent('switched', { detail: { from: model, to: best } }));
          onStatus?.(`模型 ${model} 已不可用，自动改用 ${best}`);
          model = best; url = API + encodeURIComponent(model) + ':generateContent'; attempt--; continue;
        }
      }
      // 5xx "overloaded" is retried at most twice: every attempt counts against the free daily request quota.
      const lim = err.code === 'server' ? Math.min(RETRY.serverMax, maxRetries) : maxRetries;
      if (!err.retryable || attempt >= lim) throw err;
      const wait = Math.min(RETRY.capMs, Math.max(err.retryAfter || 0, RETRY.baseMs * 2 ** attempt) + Math.random() * 300);
      onStatus?.(`${err.status === 429 ? '触发速率限制' : '服务繁忙'}，${Math.max(1, Math.round(wait / 1000))} 秒后重试（第 ${attempt + 1}/${lim} 次）`);
      await sleep(wait);
    }
  } finally { release(); }
}
function parseResponse(j) {
  const fb = j.promptFeedback?.blockReason;
  if (fb) throw new GeminiError((BLOCK_MSG[fb] || 'Gemini 拒绝了该请求（' + fb + '）') + '。', { code: 'blocked' });
  const c = j.candidates?.[0];
  if (!c) throw new GeminiError('Gemini 返回了空结果。', { code: 'empty' });
  const text = (c.content?.parts || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
  const fr = c.finishReason || 'STOP';
  if (fr !== 'STOP' && fr !== 'MAX_TOKENS' && BLOCK_MSG[fr]) throw new GeminiError(BLOCK_MSG[fr] + (text ? '（已返回部分文字）' : '') + '。', { code: 'blocked', partial: text });
  return { text, finishReason: fr, usage: j.usageMetadata || null, modelVersion: j.modelVersion || '' };
}

// ---------- OCR ----------
export function buildOcrPrompt({ langNames = [], vertical = false } = {}) {
  return [
    '你是一名专业的历史档案文字转录员。请逐字转录这张档案图像中的全部文字。',
    '要求：',
    '1. 忠实转录：严格保留原文字形。原文是繁体就输出繁体，是简体就输出简体，异体字、旧字形照录；不要做繁简转换，不要改正错别字或病句，不要改写、补全、润色或现代化用语；不要自行添加原文没有的标点，原文已有的标点照录。',
    '2. 阅读顺序：竖排文字按“从右到左逐列、每列自上而下”的顺序阅读，并按阅读顺序转录为横排文本；横排文字按从左到右、自上而下；多栏版面按栏依次转录。',
    '3. 保留原有的分段与换行，段落之间空一行；表格逐行转录，单元格之间用“ | ”分隔。',
    '4. 无法辨认的字，每个字用一个 □ 表示，不要猜测补字。',
    '5. 页眉、页脚、页码、边注、眉批、手写批语、印章、戳记中的文字也要转录，并在方括号中标明类型，例如：【印】某某之印、【批注】……、【页眉】……、【页码】3、【戳记】……。',
    '6. 只输出转录文本本身，不要任何解释、说明、标题、Markdown 格式或代码块。如果图像中没有文字，只输出：【无文字】',
    langNames.length ? `提示：本页可能包含的文字：${langNames.join('、')}。` : '',
    vertical ? '提示：本页为竖排（直行）版式，请按自右向左的列顺序转录。' : '',
  ].filter(Boolean).join('\n');
}
// Encode a canvas for upload: JPEG, long side ≤ maxSide (enough for small CJK characters), shrinking until under maxBytes.
export async function encodeCanvas(canvas, { maxSide = 3072, quality = 0.9, maxBytes = 4.5 * 1048576 } = {}) {
  let side = Math.max(canvas.width, canvas.height), scale = Math.min(1, maxSide / side), q = quality;
  for (let i = 0; i < 6; i++) {
    const w = Math.max(1, Math.round(canvas.width * scale)), h = Math.max(1, Math.round(canvas.height * scale));
    let c = canvas;
    if (scale < 1) { c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(canvas, 0, 0, w, h); }
    else { c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(canvas, 0, 0); }
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
    if (blob.size <= maxBytes || i === 5) return { data: await blobToBase64(blob), mimeType: 'image/jpeg', width: w, height: h, bytes: blob.size };
    if (q > 0.8) q -= 0.05; else scale *= 0.85;
  }
}
function blobToBase64(blob) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); }); }
function stripFences(t) { return t.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/, '').trim(); }

export async function ocrCanvas(canvas, { langNames, vertical, onStatus, signal } = {}) {
  const model = geminiModel();
  const img = await encodeCanvas(canvas);
  const generationConfig = { temperature: 0, maxOutputTokens: 32768 };
  const tc = thinkingFor(model); if (tc) generationConfig.thinkingConfig = tc; // pure transcription needs little or no "thinking"
  const body = {
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: img.mimeType, data: img.data } }, { text: buildOcrPrompt({ langNames, vertical }) }] }],
    generationConfig,
    safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map((category) => ({ category, threshold: 'BLOCK_NONE' })),
  };
  onStatus?.('正在上传并由 Gemini 识别…');
  const r = await generate(body, { model, onStatus, signal });
  let text = stripFences(r.text);
  if (/^【无文字】$/.test(text)) text = '';
  return { text, model: /^gemini-/.test(r.modelVersion || '') ? r.modelVersion : geminiModel(), finishReason: r.finishReason, truncated: r.finishReason === 'MAX_TOKENS', image: { w: img.width, h: img.height, bytes: img.bytes } };
}

// ---------- text generation (AI summaries) ----------
export async function geminiChat(prompt, { system, model, temperature = 0.3 } = {}) {
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const r = await generate(body, { model: model || geminiModel() });
  return r.text || '(空响应)';
}
function thinkingFor(model) {
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-(\d+(\.\d+)?-flash|flash-latest)/.test(model) && !/^gemini-2/.test(model)) return { thinkingLevel: 'low' };
  return null;
}
export async function testGemini({ onStatus } = {}) {
  const tc = thinkingFor(geminiModel());
  const r = await generate({ contents: [{ role: 'user', parts: [{ text: '请只回复“连接成功”四个字。' }] }], generationConfig: { temperature: 0, ...(tc ? { thinkingConfig: tc } : {}) } }, { maxRetries: 1, timeoutMs: 60000, onStatus });
  return { text: r.text, model: geminiModel() };
}
