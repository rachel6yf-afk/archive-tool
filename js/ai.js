// Optional OpenAI-compatible chat completions. Settings (incl. key) live only in localStorage.
const KEY = 'archive-ocr.ai';
export function getAI() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
export function setAI(s) { localStorage.setItem(KEY, JSON.stringify(s)); }
export function aiEnabled() { const s = getAI(); return !!(s.endpoint && s.model); }
function url(endpoint) { const e = endpoint.trim().replace(/\/+$/, ''); return /\/chat\/completions$/.test(e) ? e : e + '/chat/completions'; }
export async function chat(prompt, { system = '你是一名严谨的历史档案研究助理。请使用简体中文，基于提供的材料作答，不要编造材料中没有的信息；引用时注明来源条目标题。', maxChars = 14000 } = {}) {
  const s = getAI();
  if (!s.endpoint || !s.model) throw new Error('请先在“设置”中填写 AI 接口地址和模型。');
  if (prompt.length > maxChars) prompt = prompt.slice(0, maxChars) + '\n……（材料过长，已截断）';
  const headers = { 'Content-Type': 'application/json' };
  if (s.key) headers.Authorization = 'Bearer ' + s.key;
  const r = await fetch(url(s.endpoint), { method: 'POST', headers, body: JSON.stringify({ model: s.model, temperature: 0.3, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }) });
  if (!r.ok) throw new Error(`AI 接口返回 ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content?.trim() || '(空响应)';
}
