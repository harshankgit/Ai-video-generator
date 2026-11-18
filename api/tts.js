// Free text-to-speech using Microsoft Edge "Read Aloud" neural voices (no API key).
// POST { text, voice, rate, pitch }  ->  audio/mpeg
// Falls back to Google Translate TTS if Edge TTS fails.
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const ALLOWED_VOICE = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/;

function escapeXml(s) {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

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

async function edgeTts(text, voice, rate, pitch) {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeXml(text), { rate, pitch });
    const chunks = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Edge TTS timeout')), 40000);
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.on('end', () => { clearTimeout(timer); resolve(); });
      audioStream.on('close', () => { clearTimeout(timer); resolve(); });
      audioStream.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const buf = Buffer.concat(chunks);
    if (buf.length < 500) throw new Error('Edge TTS returned empty audio');
    return buf;
  } finally {
    try { tts.close(); } catch { /* ignore */ }
  }
}

function splitForGoogle(text, max = 180) {
  const parts = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    if ((cur + ' ' + word).trim().length > max) {
      if (cur) parts.push(cur);
      cur = word;
    } else cur = (cur + ' ' + word).trim();
  }
  if (cur) parts.push(cur);
  return parts;
}

async function googleTts(text, lang = 'hi') {
  const bufs = [];
  for (const part of splitForGoogle(text)) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(part)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('Google TTS ' + r.status);
    bufs.push(Buffer.from(await r.arrayBuffer()));
  }
  return Buffer.concat(bufs);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  try {
    const body = req.method === 'GET' ? req.query || {} : await readBody(req);
    const text = String(body.text || '').trim().slice(0, 3000);
    if (!text) return res.status(400).json({ error: 'text required' });
    const voice = ALLOWED_VOICE.test(body.voice || '') ? body.voice : 'hi-IN-MadhurNeural';
    const rate = /^[+-]?\d{1,3}%$/.test(body.rate || '') ? body.rate : '+0%';
    const pitch = /^[+-]?\d{1,3}Hz$/.test(body.pitch || '') ? body.pitch : '+0Hz';

    let audio;
    let engine = 'edge';
    for (let attempt = 0; attempt < 2 && !audio; attempt++) {
      try { audio = await edgeTts(text, voice, rate, pitch); } catch (e) { console.warn('edge tts failed:', e.message); }
    }
    if (!audio) {
      engine = 'google';
      audio = await googleTts(text, body.lang === 'en' ? 'en' : 'hi');
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-TTS-Engine', engine);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.status(200).send(audio);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'TTS failed' });
  }
}
