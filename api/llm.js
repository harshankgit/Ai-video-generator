// LLM proxy. Uses Google Gemini (free tier) when GEMINI_API_KEY is set on the server,
// otherwise the free, key-less Pollinations text API.
// POST { messages: [{role, content}], json: true }  ->  { content: "..." }

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(JSON.parse(req.body || '{}'));
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export async function callGemini(apiKey, messages, json) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const models = [process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'].filter(Boolean);
  let last;
  for (const model of models) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents,
        generationConfig: { temperature: 0.9, ...(json ? { responseMimeType: 'application/json' } : {}) },
      }),
      signal: AbortSignal.timeout(110000),
    });
    if (r.status === 404 || r.status === 400) {
      last = new Error('Gemini ' + model + ' ' + r.status + ': ' + (await r.text()).slice(0, 200));
      continue;
    }
    if (!r.ok) throw new Error('Gemini ' + r.status + ': ' + (await r.text()).slice(0, 300));
    const d = await r.json();
    const text = d.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    if (text) return text;
    last = new Error('Gemini empty answer');
  }
  throw last || new Error('Gemini failed');
}

export class RateLimit extends Error {
  constructor(sec) {
    super('Free limit reached, retry after ' + sec + 's');
    this.retryAfter = sec;
  }
}

export async function callPollinationsKeyed(key, messages, json) {
  const r = await fetch('https://gen.pollinations.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'openai', messages, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
    signal: AbortSignal.timeout(110000),
  });
  if (r.status === 429) throw new RateLimit(10);
  if (!r.ok) throw new Error('Pollinations key ' + r.status + ': ' + (await r.text()).slice(0, 300));
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '';
}

export async function callPollinations(messages, json) {
  const r = await fetch('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai',
      messages,
      referrer: 'ai-story-video-studio',
      reasoning_effort: 'low',
      max_tokens: 12000,
      seed: Math.floor(Math.random() * 1e6),
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(110000),
  });
  if (!r.ok) {
    const text = await r.text();
    if (r.status === 402 || r.status === 429 || /FREE_LIMIT/i.test(text)) {
      const m = /Retry after (\d+)\s*s/i.exec(text);
      throw new RateLimit(m ? Number(m[1]) + 2 : 30);
    }
    throw new Error('Pollinations ' + r.status + ': ' + text.slice(0, 300));
  }
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-pollinations-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const body = await readBody(req);
    const messages = Array.isArray(body.messages) ? body.messages.slice(0, 20) : [];
    if (!messages.length) return res.status(400).json({ error: 'messages required' });
    const key = process.env.GEMINI_API_KEY;
    let content;
    let engine;
    if (key) {
      try {
        content = await callGemini(key, messages, body.json);
        engine = 'gemini';
      } catch (e) {
        console.warn(e.message);
      }
    }
    const pKey = req.headers['x-pollinations-key'] || process.env.POLLINATIONS_KEY;
    if (!content && pKey) {
      try {
        content = await callPollinationsKeyed(pKey, messages, body.json);
        engine = 'pollinations-key';
      } catch (e) {
        console.warn(e.message);
      }
    }
    if (!content) {
      content = await callPollinations(messages, body.json);
      engine = 'pollinations';
    }
    return res.status(200).json({ content, engine });
  } catch (e) {
    if (e instanceof RateLimit) return res.status(429).json({ error: e.message, retryAfter: e.retryAfter });
    console.error(e);
    return res.status(500).json({ error: e.message || 'LLM failed' });
  }
}
