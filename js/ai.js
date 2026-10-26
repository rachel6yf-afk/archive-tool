// Optional AI summaries. Provider: 'openai' (any OpenAI-compatible endpoint) or 'gemini' (reuses the Gemini key from the Gemini settings).
// Settings (incl. keys) live only in localStorage and are never written to backups.
import { geminiReady, geminiChat, geminiModel } from './gemini.js';
const KEY = 'archive-ocr.ai';
export function getAI() { try { return { provider: 'openai', ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return { provider: 'openai' }; } }
export function setAI(s) { localStorage.setItem(KEY, JSON.stringify(s)); }
export function aiEnabled() { const s = getAI(); return s.provider === 'gemini' ? geminiReady() : !!(s.endpoint && s.model); }
export function aiLabel() { const s = getAI(); return s.provider === 'gemini' ? 'Gemini · ' + (s.geminiModel || geminiModel()) : s.model || ''; }
function url(endpoint) { const e = endpoint.trim().replace(/\/+$/, ''); return /\/chat\/completions$/.test(e) ? e : e + '/chat/completions'; }
const SYSTEM = '你是一名严谨的历史档案研究助理。请使用简体中文，基于提供的材料作答，不要编造材料中没有的信息；引用时注明来源条目标题。';
export async function chat(prompt, { system = SYSTEM, maxChars } = {}) {
  const s = getAI();
  if (s.provider === 'gemini') {
    if (!geminiReady()) throw new Error('请先在“设置 → Gemini”中填写 Gemini API Key。');
    const lim = maxChars || 200000; // Gemini has a very long context window
    if (prompt.length > lim) prompt = prompt.slice(0, lim) + '\n……（材料过长，已截断）';
    return (await geminiChat(prompt, { system, model: s.geminiModel || undefined })).trim();
  }
  if (!s.endpoint || !s.model) throw new Error('请先在“设置”中填写 AI 接口地址和模型。');
  const lim = maxChars || 14000;
  if (prompt.length > lim) prompt = prompt.slice(0, lim) + '\n……（材料过长，已截断）';
  const headers = { 'Content-Type': 'application/json' };
  if (s.key) headers.Authorization = 'Bearer ' + s.key;
  const r = await fetch(url(s.endpoint), { method: 'POST', headers, body: JSON.stringify({ model: s.model, temperature: 0.3, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }) });
  if (!r.ok) throw new Error(`AI 接口返回 ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || '(空响应)';
}
