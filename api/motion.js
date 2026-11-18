// Real-motion AI video clips (image -> video).
// engine "free": Hugging Face ZeroGPU Space (Wan 2.2 image-to-video). Free daily GPU quota
//               (anonymous small, free HF account ~5 min/day). Whole job done here, returns video/mp4.
// engine "paid": fal.ai queue API (user's FAL key). Actions: submit -> status -> result.

const HF_BASE = process.env.HF_SPACE_URL || 'https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space';
const HF_NEG = 'static image, still, frozen, blurry, deformed hands, extra fingers, distorted face, ugly, watermark, text, subtitles, low quality, jitter';
const FAL_DEFAULT = process.env.FAL_MODEL || 'fal-ai/kling-video/o3/standard/image-to-video';

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

class Quota extends Error { constructor(msg, retryAfter = 0) { super(msg); this.quota = true; this.retryAfter = retryAfter; } }

const QUOTA_RE = /quota|exceeded|rate.?limit|too many|runs limit|GPU task aborted|No GPU/i;

function parseWait(msg) {
  const m = /(\d+):(\d{2}):(\d{2})/.exec(msg || '');
  if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
  const s = /(\d+)\s*s(ec|econds)?\b/i.exec(msg || '');
  return s ? +s[1] : 0;
}

// ---------- FREE: Hugging Face Space ----------
async function hfGenerate({ image, prompt, duration = 3, seed = 42 }, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const dur = Math.max(1.5, Math.min(5, Number(duration) || 3));
  const data = [
    { url: image, meta: { _type: 'gradio.FileData' }, orig_name: 'scene.jpg', mime_type: 'image/jpeg' },
    String(prompt || 'natural movement, the person moves hands and talks, cinematic').slice(0, 900),
    6, HF_NEG, dur, 1, 1, Math.abs(Number(seed) | 0) % 2147483647, false,
  ];
  const r = await fetch(`${HF_BASE}/gradio_api/call/generate_video`, {
    method: 'POST', headers, body: JSON.stringify({ data }), signal: AbortSignal.timeout(30000),
  });
  const txt = await r.text();
  if (!r.ok) {
    if (r.status === 429 || QUOTA_RE.test(txt)) throw new Quota(txt.slice(0, 300), parseWait(txt));
    throw new Error(`HF submit ${r.status}: ${txt.slice(0, 200)}`);
  }
  let eventId;
  try { eventId = JSON.parse(txt).event_id; } catch {}
  if (!eventId) throw new Error('HF: no event id');

  // keep the same replica (files live on the replica that generated them)
  const replica = r.headers.get('x-proxied-replica') || '';
  const cookies = (typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [])
    .map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  const sh = {}; if (token) sh.Authorization = `Bearer ${token}`; if (cookies) sh.Cookie = cookies;
  const s = await fetch(`${HF_BASE}/gradio_api/call/generate_video/${eventId}`, { headers: sh, signal: AbortSignal.timeout(240000) });
  if (!s.ok) throw new Error(`HF stream ${s.status}`);
  const reader = s.body.getReader();
  const dec = new TextDecoder();
  let buf = '', event = '', result = null, errMsg = null;
  outer: while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        const d = line.slice(5).trim();
        if (event === 'complete') { try { result = JSON.parse(d); } catch {} break outer; }
        if (event === 'error') { errMsg = d; break outer; }
      }
    }
  }
  try { reader.cancel(); } catch {}
  if (errMsg !== null || !result) {
    const m = errMsg && errMsg !== 'null' ? errMsg : 'GPU quota / Space busy';
    if (QUOTA_RE.test(m) || errMsg === 'null' || !errMsg) throw new Quota(m.slice(0, 300), parseWait(m));
    throw new Error('HF error: ' + m.slice(0, 200));
  }
  const file = Array.isArray(result) ? result[0] : null;
  const url = file?.url || (file?.video?.url) || (file?.path ? `${HF_BASE}/gradio_api/file=${file.path}` : null);
  if (!url) throw new Error('HF: no video in result');
  // download immediately, WITHOUT Origin header (HF returns 403 for cross-origin file fetch)
  const urls = [url];
  if (file?.path && replica) urls.push(`${HF_BASE}/--replicas/${replica}/gradio_api/file=${file.path}`);
  let last = 0;
  for (let a = 0; a < 8; a++) {
    const u = urls[a % urls.length];
    try {
      const v = await fetch(u, { headers: sh, signal: AbortSignal.timeout(60000) });
      if (v.ok) return Buffer.from(await v.arrayBuffer());
      last = v.status;
    } catch (e) { last = e.message; }
    await new Promise((ok) => setTimeout(ok, 800));
  }
  throw new Error(`HF file ${last}`);
}

// ---------- PAID: fal.ai queue ----------
function falHeaders(key) { return { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }; }
const FAL_OK = /^https:\/\/([a-z0-9-]+\.)*(fal\.run|fal\.media|fal\.ai)\//i;

async function falSubmit({ image, prompt, duration = 5, model }, key) {
  const m = String(model || FAL_DEFAULT).replace(/^\/+|\/+$/g, '');
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(m)) throw new Error('Invalid fal model id');
  const body = { prompt: String(prompt || '').slice(0, 1500), image_url: image };
  if (/kling/i.test(m)) body.duration = Number(duration) > 5 ? '10' : '5';
  else if (/seedance|veo|ltx|wan|hailuo|minimax/i.test(m)) body.duration = String(Math.round(Math.min(10, Math.max(3, Number(duration) || 5))));
  let r = await fetch(`https://queue.fal.run/${m}`, { method: 'POST', headers: falHeaders(key), body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  if (r.status === 422 && body.duration) { // schema doesn't like duration -> retry without
    delete body.duration;
    r = await fetch(`https://queue.fal.run/${m}`, { method: 'POST', headers: falHeaders(key), body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`fal ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
  return { requestId: d.request_id, statusUrl: d.status_url, responseUrl: d.response_url };
}

async function falStatus({ statusUrl }, key) {
  if (!FAL_OK.test(statusUrl || '')) throw new Error('bad status url');
  const r = await fetch(statusUrl, { headers: falHeaders(key), signal: AbortSignal.timeout(30000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 202) throw new Error(`fal status ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return { status: d.status || 'IN_QUEUE', position: d.queue_position ?? null };
}

async function falResult({ responseUrl }, key) {
  if (!FAL_OK.test(responseUrl || '')) throw new Error('bad response url');
  const r = await fetch(responseUrl, { headers: falHeaders(key), signal: AbortSignal.timeout(30000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`fal result ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
  const url = d.video?.url || d.videos?.[0]?.url || d.output?.video?.url;
  if (!url) throw new Error('fal: no video url in result');
  return { url };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-hf-token, x-fal-key');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    // proxy a fal video file (if the browser can't fetch it directly)
    if (req.method === 'GET') {
      const u = new URL(req.url, 'http://x').searchParams.get('proxy') || '';
      if (!FAL_OK.test(u)) return res.status(400).json({ error: 'bad url' });
      const v = await fetch(u, { signal: AbortSignal.timeout(60000) });
      if (!v.ok) return res.status(502).json({ error: 'file ' + v.status });
      res.setHeader('Content-Type', 'video/mp4');
      return res.status(200).send(Buffer.from(await v.arrayBuffer()));
    }
    const b = await readBody(req);
    const engine = b.engine === 'paid' ? 'paid' : 'free';
    if (engine === 'free') {
      if (!/^data:image\/|^https:\/\//.test(b.image || '')) return res.status(400).json({ error: 'image required' });
      const token = req.headers['x-hf-token'] || process.env.HF_TOKEN || '';
      const mp4 = await hfGenerate(b, token);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('X-Motion-Engine', 'hf-wan2.2');
      return res.status(200).send(mp4);
    }
    const key = req.headers['x-fal-key'] || process.env.FAL_KEY || '';
    if (!key) return res.status(400).json({ error: 'Paid mode needs a fal.ai API key (Settings).' });
    const action = b.action || 'submit';
    if (action === 'submit') return res.status(200).json(await falSubmit(b, key));
    if (action === 'status') return res.status(200).json(await falStatus(b, key));
    if (action === 'result') return res.status(200).json(await falResult(b, key));
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    if (e.quota) return res.status(429).json({ error: e.message, quota: true, retryAfter: e.retryAfter || 0 });
    return res.status(502).json({ error: String(e.message || e).slice(0, 400) });
  }
}
