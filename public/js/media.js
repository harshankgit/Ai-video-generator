// Free AI images (/api/image) + free neural voices (/api/tts -> Edge TTS).
import { db } from './db.js';
import { getStyle } from './topics.js';
import { keyHeaders, waitWithCountdown } from './ai.js';

export const VOICES = {
  male: [
    'hi-IN-MadhurNeural',
    'en-US-AndrewMultilingualNeural',
    'en-US-BrianMultilingualNeural',
    'en-AU-WilliamMultilingualNeural',
    'fr-FR-RemyMultilingualNeural',
    'it-IT-GiuseppeMultilingualNeural',
  ],
  female: [
    'hi-IN-SwaraNeural',
    'en-US-EmmaMultilingualNeural',
    'en-US-AvaMultilingualNeural',
    'fr-FR-VivienneMultilingualNeural',
    'pt-BR-ThalitaMultilingualNeural',
  ],
};
export const ALL_VOICES = [...VOICES.male, ...VOICES.female, 'en-IN-PrabhatNeural', 'en-IN-NeerjaNeural'];

export function voiceLabel(v) {
  return v.replace(/Neural$/, '').replace(/^[a-z]{2}-[A-Z]{2}-/, '').replace('Multilingual', ' (multi)');
}

const AGE_PROSODY = {
  child: { rate: '+6%', pitch: '+28Hz' },
  young: { rate: '+3%', pitch: '+4Hz' },
  adult: { rate: '+0%', pitch: '+0Hz' },
  old: { rate: '-10%', pitch: '-12Hz' },
};

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Give narrator + every character a distinct voice (kept in project.voices, user editable). */
export function assignVoices(p) {
  const voices = { ...(p.voices || {}) };
  const en = p.language === 'en';
  const teller = (p.voiceStyle || 'storyteller') === 'storyteller' && p.mode !== 'dance'
    ? (p.bible?.characters || []).find((c) => c.id === p.bible?.teller)
    : null;
  if (!voices.narrator) {
    if (teller) {
      // One person tells their own story: narrator voice = the storyteller's own voice.
      const female = teller.gender === 'female';
      const child = teller.age === 'child';
      const voice = en
        ? (female ? 'en-IN-NeerjaNeural' : 'en-IN-PrabhatNeural')
        : female ? 'hi-IN-SwaraNeural' : 'hi-IN-MadhurNeural';
      const pros = child ? { rate: '+5%', pitch: female ? '+22Hz' : '+20Hz' } : teller.age === 'old' ? { rate: '-6%', pitch: '-8Hz' } : { rate: '+4%', pitch: '+0Hz' };
      voices.narrator = { voice, ...pros };
    } else {
      const female = p.narratorGender === 'female';
      voices.narrator = {
        voice: en ? (female ? 'en-IN-NeerjaNeural' : 'en-IN-PrabhatNeural') : female ? 'hi-IN-SwaraNeural' : 'hi-IN-MadhurNeural',
        rate: '+4%',
        pitch: '+0Hz',
      };
    }
  }
  const used = new Set(Object.values(voices).map((v) => v.voice));
  const idx = { male: 0, female: 0 };
  for (const c of p.bible?.characters || []) {
    if (voices[c.id]) continue;
    const pool = VOICES[c.gender] || VOICES.male;
    let pick = null;
    for (let k = 0; k < pool.length; k++) {
      const cand = pool[(idx[c.gender] + k) % pool.length];
      if (!used.has(cand)) {
        pick = cand;
        break;
      }
    }
    if (!pick) pick = pool[idx[c.gender] % pool.length];
    idx[c.gender]++;
    used.add(pick);
    voices[c.id] = { voice: pick, ...(AGE_PROSODY[c.age] || AGE_PROSODY.adult) };
  }
  p.voices = voices;
  return voices;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ttsBlob(pid, text, v) {
  const key = `${pid}/tts/${hashStr(v.voice + v.rate + v.pitch + text)}`;
  const cached = await db.getBlob(key);
  if (cached) return cached;
  let err;
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: v.voice, rate: v.rate, pitch: v.pitch }),
      });
      if (!r.ok) throw new Error('TTS ' + r.status + ' ' + (await r.text()).slice(0, 120));
      const blob = await r.blob();
      if (blob.size < 500) throw new Error('TTS returned empty audio');
      await db.putBlob(key, blob);
      return blob;
    } catch (e) {
      err = e;
      await sleep(1000 * (a + 1));
    }
  }
  throw err;
}

let decodeCtx;
export async function decodeAudio(blob, sampleRate = 48000) {
  decodeCtx ||= new OfflineAudioContext(2, 1, sampleRate);
  const buf = await blob.arrayBuffer();
  return decodeCtx.decodeAudioData(buf);
}

export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

export function imageSize(format, quality) {
  // generation size (Pollinations); video canvas is scaled on top
  if (format === 'short') return quality === 'hd' ? { w: 864, h: 1536 } : { w: 720, h: 1280 };
  return quality === 'hd' ? { w: 1536, h: 864 } : { w: 1280, h: 720 };
}

export function scenePrompt(p, scene) {
  const style = getStyle(p.style);
  const chars = (p.bible?.characters || []).filter(
    (c) => scene.characters?.includes(c.id) || (scene.visual || '').toLowerCase().includes(c.name.toLowerCase()),
  );
  const looks = chars.map((c) => `${c.name}: ${c.look}`).join('; ');
  const extra = p.mode === 'dance' ? 'dynamic dance pose, motion, joyful, vibrant colors, ' : '';
  const prompt = `${style.prompt}, ${extra}${scene.visual}. ${looks ? 'Characters (keep exactly the same face and outfit): ' + looks + '. ' : ''}Setting: ${p.bible?.setting || 'India'}. Indian people, expressive faces, highly detailed, cinematic composition, no text, no letters, no watermark`;
  return prompt.replace(/\s+/g, ' ').slice(0, 1400);
}

// Images are generated through our /api/image function (Cloudflare / Pollinations key / free Pollinations).
// Free tier = about 1 image every ~20-45s per IP, so we wait (with countdown) when the server says 429.
export async function fetchImage(prompt, { w, h, seed }, signal) {
  let err;
  let waits = 0;
  for (let a = 0; a < 5; a++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    try {
      const r = await fetch('/api/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...keyHeaders() },
        body: JSON.stringify({ prompt, w, h, seed }),
        signal,
      });
      if (r.status === 429) {
        const d = await r.json().catch(() => ({}));
        if (waits++ < 40) {
          a--;
          await waitWithCountdown(d.retryAfter || 30, 'AI image', signal);
          continue;
        }
        throw new Error('Free image limit reached, try later or add a free key in Settings');
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error('Image ' + r.status + (d.error ? ': ' + String(d.error).slice(0, 140) : ''));
      }
      const blob = await r.blob();
      if (!blob.type.startsWith('image/') || blob.size < 3000) throw new Error('Bad image');
      return blob;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      err = e;
      console.warn('image failed', e);
      await sleep(3000 * (a + 1));
    }
  }
  throw err;
}

/** Scene image, cached in IndexedDB. seedBump lets the user "regenerate" a scene. */
export async function sceneImage(p, partNo, i, scene, { quality, force, signal } = {}) {
  const key = `${p.id}/p${partNo}/img${i}`;
  if (!force) {
    const c = await db.getBlob(key);
    if (c) return c;
  }
  const size = imageSize(p.format, quality);
  const seed = (parseInt(hashStr(p.id), 36) % 900000) + i * 7 + partNo * 1000 + (scene.seedBump || 0) * 13;
  const blob = await fetchImage(scenePrompt(p, scene), { ...size, seed }, signal);
  await db.putBlob(key, blob);
  return blob;
}

export async function thumbImage(p, partNo, meta, { force, signal } = {}) {
  const key = `${p.id}/p${partNo}/thumbbg`;
  if (!force) {
    const c = await db.getBlob(key);
    if (c) return c;
  }
  const style = getStyle(p.style);
  const chars = (p.bible?.characters || []).slice(0, 2).map((c) => `${c.name}: ${c.look}`).join('; ');
  const part = p.bible.parts[partNo - 1];
  const prompt = `${style.prompt}, YouTube thumbnail, dramatic close-up of the main characters with strong shocked/emotional expressions, ${part?.summary || p.topic}. ${chars}. Bright saturated colors, high contrast, rim light, empty space for big title text, no text, no letters`.slice(0, 1400);
  const size = p.format === 'short' ? { w: 720, h: 1280 } : { w: 1280, h: 720 };
  const blob = await fetchImage(prompt, { ...size, seed: (parseInt(hashStr(p.id), 36) % 900000) + partNo * 31 + 5 }, signal);
  await db.putBlob(key, blob);
  return blob;
}
