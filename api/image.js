// Image proxy. The browser cannot call Pollinations directly any more (it asks for a
// Turnstile token), so every image goes through this function.
// POST { prompt, w, h, seed }  ->  image/jpeg bytes
// Engines, first that is configured wins:
//   1. Cloudflare Workers AI  flux-1-schnell  (free daily quota)  env CF_ACCOUNT_ID + CF_API_TOKEN
//      or headers x-cf-account / x-cf-token sent from the user's Settings
//   2. Pollinations with a key (gen.pollinations.ai)   env POLLINATIONS_KEY or header x-pollinations-key
//   3. Pollinations anonymous (free, 1 image every ~45 s per IP). When the limit is hit we
//      answer 429 { retryAfter } and the browser waits and tries again.

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

class RateLimit extends Error {
  constructor(sec) {
    super('rate limited');
    this.retryAfter = sec;
  }
}

const clampDim = (v, d) => Math.max(256, Math.min(1536, Math.round(Number(v) || d)));

async function cloudflare(account, token, prompt, seed) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt.slice(0, 2000), steps: 6, seed }),
    },
  );
  if (r.status === 429) throw new RateLimit(20);
  if (!r.ok) throw new Error('Cloudflare ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  const b64 = d.result?.image;
  if (!b64) throw new Error('Cloudflare: no image');
  return Buffer.from(b64, 'base64');
}

async function pollinationsKeyed(key, prompt, w, h, seed) {
  const q = new URLSearchParams({ model: 'flux', width: w, height: h, seed, nologo: 'true' });
  const r = await fetch(`https://gen.pollinations.ai/image/${encodeURIComponent(prompt.slice(0, 1500))}?${q}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (r.status === 429) throw new RateLimit(10);
  if (!r.ok) throw new Error('Pollinations key ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return Buffer.from(await r.arrayBuffer());
}

async function pollinationsFree(prompt, w, h, seed) {
  const q = new URLSearchParams({ width: w, height: h, seed, nologo: 'true', model: 'flux' });
  const r = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 1200))}?${q}`, {
    headers: { 'User-Agent': 'ai-story-video-studio/1.0' },
    signal: AbortSignal.timeout(80000),
  });
  const type = r.headers.get('content-type') || '';
  if (r.ok && type.startsWith('image/')) return Buffer.from(await r.arrayBuffer());
  const text = await r.text();
  if (r.status === 402 || r.status === 429 || r.status === 503 || /FREE_LIMIT|rate|at its limit/i.test(text)) {
    const m = /Retry after (\d+)\s*s/i.exec(text);
    throw new RateLimit(m ? Number(m[1]) + 2 : 30);
  }
  throw new Error('Pollinations ' + r.status + ': ' + text.slice(0, 200));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-cf-account, x-cf-token, x-pollinations-key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  let body;
  try {
    body = req.method === 'GET' ? req.query || {} : await readBody(req);
  } catch {
    return res.status(400).json({ error: 'bad json' });
  }
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const w = clampDim(body.w, 768);
  const h = clampDim(body.h, 1344);
  const seed = Math.abs(parseInt(body.seed, 10) || 1) % 2147483647;

  const cfAcc = req.headers['x-cf-account'] || process.env.CF_ACCOUNT_ID;
  const cfTok = req.headers['x-cf-token'] || process.env.CF_API_TOKEN;
  const pKey = req.headers['x-pollinations-key'] || process.env.POLLINATIONS_KEY;

  const engines = [];
  if (cfAcc && cfTok) engines.push(['cloudflare', () => cloudflare(cfAcc, cfTok, prompt, seed)]);
  if (pKey) engines.push(['pollinations-key', () => pollinationsKeyed(pKey, prompt, w, h, seed)]);
  engines.push(['pollinations-free', () => pollinationsFree(prompt, w, h, seed)]);

  let rate = null;
  const errors = [];
  for (const [name, run] of engines) {
    try {
      const buf = await run();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('X-Image-Engine', name);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.status(200).send(buf);
    } catch (e) {
      if (e instanceof RateLimit) rate = Math.max(rate || 0, e.retryAfter);
      else errors.push(e.message);
      console.warn('[image]', name, e.message);
    }
  }
  if (rate) return res.status(429).json({ error: 'free limit, please wait', retryAfter: rate });
  return res.status(502).json({ error: errors.join(' | ').slice(0, 400) || 'image failed' });
}
