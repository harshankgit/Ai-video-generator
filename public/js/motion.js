// Real-motion clips: turn a scene's AI image into a short AI video (person moves).
// free  -> Hugging Face ZeroGPU Wan 2.2 image-to-video (via /api/motion, limited free quota per day)
// paid  -> fal.ai image-to-video (user's own key, every scene)
import { db } from './db.js';
import { keyHeaders, getSettings, sleep } from './ai.js';

const DEV_RE = /[\u0900-\u097F]+/g;

export class QuotaError extends Error {
  constructor(msg, retryAfter = 0) { super(msg); this.name = 'QuotaError'; this.retryAfter = retryAfter; }
}

export function motionPrompt(p, scene) {
  const vis = String(scene?.visual || '').replace(DEV_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
  const dance = p.mode === 'dance';
  const move = dance
    ? 'the cute little child dances happily, arms waving, clapping hands, jumping and turning, feet moving to the beat, smiling'
    : 'the person moves naturally and realistically, talking with mouth moving, hand gestures, head turns, body movement, walking if appropriate, blinking eyes';
  return `${vis}. ${move}. Cinematic, smooth natural motion, stable face, consistent character, real-life movie feel.`.slice(0, 880);
}

/** crop bottom ~7% (provider watermark) and resize to max side, return JPEG data URI */
export async function toDataUri(blob, maxSide = 832) {
  const bmp = await createImageBitmap(blob);
  const cropH = Math.round(bmp.height * 0.93);
  const cropW = Math.round(bmp.width * 0.93);
  const sx = Math.round((bmp.width - cropW) / 2);
  const sc = Math.min(1, maxSide / Math.max(cropW, cropH));
  const w = Math.round((cropW * sc) / 16) * 16, h = Math.round((cropH * sc) / 16) * 16;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, sx, 0, cropW, cropH, 0, 0, w, h);
  bmp.close?.();
  const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  return await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(b);
  });
}

export const clipKey = (p, partNo, i) => `${p.id}/p${partNo}/clip${i}`;

export async function deleteClip(p, partNo, i) {
  try { await db.deleteBlob(clipKey(p, partNo, i)); } catch {}
}

function anySignal(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal && AbortSignal.any ? AbortSignal.any([signal, t]) : signal || t;
}

async function postMotion(body, signal, ms = 295000) {
  return fetch('/api/motion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...keyHeaders() },
    body: JSON.stringify(body),
    signal: anySignal(signal, ms),
  });
}

async function errText(r) {
  try { const d = await r.json(); return d; } catch { return { error: `status ${r.status}` }; }
}

async function freeClip(image, prompt, seed, signal) {
  let last = '';
  for (let a = 0; a < 3; a++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let r;
    try {
      r = await postMotion({ engine: 'free', image, prompt, duration: 3.5, seed }, signal);
    } catch (e) {
      if (e.name === 'AbortError' && signal?.aborted) throw e;
      last = e.message; continue;
    }
    if (r.ok) {
      const b = await r.blob();
      if (b.size > 10000) return b;
      last = 'empty clip'; continue;
    }
    const d = await errText(r);
    if (r.status === 429 || d.quota) throw new QuotaError(d.error || 'Free GPU quota finished', d.retryAfter || 0);
    last = d.error || `status ${r.status}`;
    await sleep(4000 * (a + 1));
  }
  throw new Error(`Motion failed: ${last}`);
}

async function paidClip(image, prompt, signal, onStatus) {
  const model = (getSettings().falModel || '').trim() || undefined;
  let r = await postMotion({ engine: 'paid', action: 'submit', image, prompt, duration: 5, model }, signal, 90000);
  if (!r.ok) { const d = await errText(r); throw new Error(d.error || `fal submit ${r.status}`); }
  const job = await r.json();
  const t0 = Date.now();
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (Date.now() - t0 > 15 * 60e3) throw new Error('fal video timeout');
    await sleep(5000);
    r = await postMotion({ engine: 'paid', action: 'status', statusUrl: job.statusUrl, model }, signal, 60000);
    if (!r.ok) continue;
    const s = await r.json();
    onStatus?.(s.status === 'IN_QUEUE' ? `queue ${s.position ?? ''}` : String(s.status || '').toLowerCase());
    if (s.status === 'COMPLETED') break;
    if (/FAIL|ERROR|CANCEL/i.test(s.status || '')) throw new Error(`fal: ${s.status}`);
  }
  r = await postMotion({ engine: 'paid', action: 'result', responseUrl: job.responseUrl, model }, signal, 60000);
  if (!r.ok) { const d = await errText(r); throw new Error(d.error || `fal result ${r.status}`); }
  const { url } = await r.json();
  if (!url) throw new Error('fal returned no video');
  try {
    const v = await fetch(url, { signal: anySignal(signal, 120000) });
    if (v.ok) return await v.blob();
  } catch (e) { if (signal?.aborted) throw e; }
  const v = await fetch(`/api/motion?proxy=${encodeURIComponent(url)}`, { signal: anySignal(signal, 120000) });
  if (!v.ok) throw new Error(`video download ${v.status}`);
  return await v.blob();
}

/** returns mp4 Blob (cached in IndexedDB) */
export async function sceneClip(p, partNo, i, scene, imageBlob, { engine = 'free', signal, force = false, onStatus } = {}) {
  const key = clipKey(p, partNo, i);
  if (!force) {
    const c = await db.getBlob(key);
    if (c && c.size > 10000) return c;
  }
  const image = await toDataUri(imageBlob, engine === 'paid' ? 1280 : 832);
  const prompt = motionPrompt(p, scene);
  const seed = 1000 + i * 17 + partNo * 101;
  const blob = engine === 'paid' ? await paidClip(image, prompt, signal, onStatus) : await freeClip(image, prompt, seed, signal);
  await db.putBlob(key, blob);
  return blob;
}
