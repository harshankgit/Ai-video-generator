// LLM access. Order of preference:
// 1) user's own free Gemini key (Settings, stored only in this browser) – called directly
// 2) our /api/llm function (server GEMINI_API_KEY / Pollinations key / free Pollinations)
// Free tiers are rate limited: when the server answers 429 {retryAfter} we wait and retry.

const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'];

export function getSettings() {
  try {
    return JSON.parse(localStorage.getItem('studio-settings') || '{}');
  } catch {
    return {};
  }
}
export function saveSettings(s) {
  localStorage.setItem('studio-settings', JSON.stringify({ ...getSettings(), ...s }));
}

// Headers carrying the user's optional free keys to our server functions.
export function keyHeaders() {
  const s = getSettings();
  const h = {};
  if (s.pollinationsKey) h['x-pollinations-key'] = s.pollinationsKey.trim();
  if (s.cfAccount && s.cfToken) {
    h['x-cf-account'] = s.cfAccount.trim();
    h['x-cf-token'] = s.cfToken.trim();
  }
  return h;
}

// Global "waiting for free limit" listener so the UI can show a countdown.
let waitListener = null;
export function onWait(fn) {
  waitListener = fn;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitWithCountdown(sec, what, signal) {
  for (let s = Math.ceil(sec); s > 0; s--) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    waitListener?.(`⏳ Free limit: ${what} – ${s}s wait...`);
    await sleep(1000);
  }
  waitListener?.('');
}

export class RateLimitError extends Error {
  constructor(sec, msg) {
    super(msg || 'rate limited');
    this.retryAfter = sec;
  }
}

let geminiModelOk = null;
async function geminiDirect(key, messages, json) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = {
    contents,
    generationConfig: { temperature: 0.9, ...(json ? { responseMimeType: 'application/json' } : {}) },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const models = geminiModelOk ? [geminiModelOk, ...GEMINI_MODELS.filter((m) => m !== geminiModelOk)] : GEMINI_MODELS;
  let lastErr;
  for (const model of models) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) },
    );
    if (r.status === 429) throw new RateLimitError(20, 'Gemini rate limit');
    if (!r.ok) {
      lastErr = new Error('Gemini ' + r.status + ': ' + (await r.text()).slice(0, 200));
      if (r.status === 404 || r.status === 400) continue;
      throw lastErr;
    }
    const d = await r.json();
    const text = d.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    if (!text) {
      lastErr = new Error('Gemini empty response');
      continue;
    }
    geminiModelOk = model;
    return text;
  }
  throw lastErr || new Error('Gemini failed');
}

async function serverLlm(messages, json) {
  const r = await fetch('/api/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...keyHeaders() },
    body: JSON.stringify({ messages, json }),
    signal: AbortSignal.timeout(130000),
  });
  if (r.status === 429) {
    const d = await r.json().catch(() => ({}));
    throw new RateLimitError(d.retryAfter || 30, d.error);
  }
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error('AI server ' + r.status + (d.error ? ': ' + String(d.error).slice(0, 160) : ''));
  }
  const d = await r.json();
  if (!d.content) throw new Error('AI server empty answer');
  return d.content;
}

export function extractJson(text) {
  if (typeof text !== 'string') return text;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(t);
  } catch {}
  const start = t.search(/[\[{]/);
  if (start >= 0) {
    const open = t[start];
    const close = open === '{' ? '}' : ']';
    const end = t.lastIndexOf(close);
    if (end > start) {
      const slice = t.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {}
      try {
        return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
      } catch {}
    }
  }
  throw new Error('AI did not return valid JSON');
}

export async function chat(messages, { json = true, retries = 4, validate, signal } = {}) {
  const key = getSettings().geminiKey?.trim();
  const engines = [];
  if (key) engines.push((m, j) => geminiDirect(key, m, j));
  engines.push(serverLlm);
  let lastErr;
  let waits = 0;
  for (let attempt = 0; attempt < retries; attempt++) {
    let rateLimited = 0;
    for (const engine of engines) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      try {
        const text = await engine(messages, json);
        if (!json) return text;
        const obj = extractJson(text);
        if (validate && !validate(obj)) throw new Error('AI answer missing fields');
        return obj;
      } catch (e) {
        lastErr = e;
        if (e instanceof RateLimitError) rateLimited = Math.max(rateLimited, e.retryAfter);
        console.warn('LLM engine failed', e);
      }
    }
    if (rateLimited && waits < 12) {
      waits++;
      attempt--; // rate limit waits don't consume normal retries
      await waitWithCountdown(rateLimited, 'AI story writer', signal);
    } else {
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr || new Error('AI failed');
}
