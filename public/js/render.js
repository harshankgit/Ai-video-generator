// In-browser video renderer: canvas frames + WebAudio mix -> MP4 (H.264/AAC) via Mediabunny (WebCodecs).
import { sfxWhoosh, sfxImpact, sfxDing, sfxPop } from './music.js';

const MB_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1/+esm';
const FPS = 30;
const SR = 48000;
const CHUNK = 60; // seconds of audio/video processed per step (limits memory)
export const FONT = '"Baloo 2", "Noto Sans Devanagari", "Nirmala UI", "Mangal", system-ui, sans-serif';

const STR = {
  hi: { presents: 'प्रस्तुत करते हैं', next: (n) => `भाग ${n} जल्द आ रहा है!`, end: 'समाप्त', sub: 'SUBSCRIBE', like: 'LIKE • SHARE • SUBSCRIBE', follow: 'Follow करें' },
  hinglish: { presents: 'presents', next: (n) => `Part ${n} jald aa raha hai!`, end: 'The End', sub: 'SUBSCRIBE', like: 'LIKE • SHARE • SUBSCRIBE', follow: 'Follow karo' },
  en: { presents: 'presents', next: (n) => `Part ${n} coming soon!`, end: 'The End', sub: 'SUBSCRIBE', like: 'LIKE • SHARE • SUBSCRIBE', follow: 'Follow' },
};
const SPEAKER_COLORS = ['#ff9f1c', '#2ec4b6', '#e71d36', '#9b5de5', '#00bbf9', '#f15bb5', '#43aa8b', '#f9c74f'];
const LYRIC_COLORS = ['#FFE600', '#00F5D4', '#FF4D9D', '#7CFF4D', '#FFFFFF', '#FF9F1C'];

let fontsReady = null;
export function ensureFonts() {
  if (!fontsReady) {
    fontsReady = Promise.all([
      document.fonts.load(`800 64px ${FONT}`, 'नमस्ते Hello'),
      document.fonts.load(`600 64px ${FONT}`, 'नमस्ते Hello'),
    ]).catch(() => {}).then(() => document.fonts.ready);
  }
  return fontsReady;
}

export function videoSize(format, quality) {
  const hd = quality !== 'sd';
  if (format === 'long') return hd ? { W: 1920, H: 1080 } : { W: 1280, H: 720 };
  return hd ? { W: 1080, H: 1920 } : { W: 720, H: 1280 };
}

/* ------------------------------ helpers ------------------------------ */
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (x) => { x = clamp(x); return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; };
const easeOutBack = (x) => { x = clamp(x); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
function rand(seed) { const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapWords(ctx, words, maxW) {
  const space = ctx.measureText(' ').width;
  const lines = [];
  let cur = [], curW = 0;
  for (const w of words) {
    const ww = ctx.measureText(w.w).width;
    if (cur.length && curW + space + ww > maxW) { lines.push({ items: cur, width: curW }); cur = []; curW = 0; }
    cur.push({ ...w, width: ww });
    curW += (cur.length > 1 ? space : 0) + ww;
  }
  if (cur.length) lines.push({ items: cur, width: curW });
  return { lines, space };
}

function wrapText(ctx, text, maxW) {
  const words = String(text || '').split(/\s+/).filter(Boolean).map((w) => ({ w }));
  return wrapWords(ctx, words, maxW).lines.map((l) => l.items.map((i) => i.w).join(' '));
}

function fitFont(ctx, text, weight, startSize, maxW, maxLines, minSize = 20) {
  let size = startSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    const lines = wrapText(ctx, text, maxW);
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxW)) return { size, lines };
    size = Math.floor(size * 0.92);
  }
  ctx.font = `${weight} ${size}px ${FONT}`;
  return { size, lines: wrapText(ctx, text, maxW).slice(0, maxLines) };
}

function strokeFill(ctx, text, x, y, fill, strokeW, stroke = '#000') {
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  if (strokeW > 0) { ctx.strokeStyle = stroke; ctx.lineWidth = strokeW; ctx.strokeText(text, x, y); }
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

/** draw image with "cover" fit, zoom >=1 and pan in [-1,1] */
function drawCover(ctx, img, W, H, zoom, panX = 0, panY = 0, flip = false, rot = 0, offY = 0) {
  if (!img) { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H); return; }
  const iw = img.width, ih = img.height;
  const s = Math.max(W / iw, H / ih) * zoom;
  const dw = iw * s, dh = ih * s;
  const x = (W - dw) / 2 + panX * (dw - W) / 2;
  const y = (H - dh) / 2 + panY * (dh - H) / 2 + offY;
  ctx.save();
  if (flip || rot) {
    ctx.translate(W / 2, H / 2);
    if (rot) ctx.rotate(rot);
    if (flip) ctx.scale(-1, 1);
    ctx.translate(-W / 2, -H / 2);
  }
  ctx.drawImage(img, x, y, dw, dh);
  ctx.restore();
}

const KB = [
  { z0: 1.08, z1: 1.24, x0: 0, x1: 0, y0: 0, y1: 0 },
  { z0: 1.24, z1: 1.08, x0: 0, x1: 0, y0: -0.2, y1: 0.1 },
  { z0: 1.16, z1: 1.2, x0: -0.6, x1: 0.6, y0: 0, y1: 0 },
  { z0: 1.2, z1: 1.16, x0: 0.6, x1: -0.6, y0: 0, y1: 0 },
  { z0: 1.14, z1: 1.22, x0: 0, x1: 0, y0: 0.6, y1: -0.5 },
];

/* ------------------------------ captions ------------------------------ */
function addCues(cues, start, end, text, maxWords, extra = {}) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return;
  const chunks = [];
  for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords));
  if (chunks.length > 1 && chunks[chunks.length - 1].length < 2) {
    const last = chunks.pop();
    chunks[chunks.length - 1].push(...last);
  }
  const weight = (w) => w.length + 2;
  const total = words.reduce((a, w) => a + weight(w), 0);
  const dur = Math.max(0.3, end - start);
  let t = start;
  for (const ch of chunks) {
    const ws = [];
    for (const w of ch) {
      const d = (weight(w) / total) * dur;
      ws.push({ w, s: t, e: t + d });
      t += d;
    }
    cues.push({ start: ws[0].s, end: ws[ws.length - 1].e, words: ws, ...extra });
  }
}

function finalizeCues(cues) {
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    const hold = cues[i].end + 0.35;
    cues[i].end = next ? Math.min(hold, Math.max(cues[i].end, next.start)) : hold;
  }
  return cues;
}

function findCue(cues, t, state) {
  let i = state.i || 0;
  if (i >= cues.length || (cues[i] && cues[i].start > t)) i = 0;
  while (i + 1 < cues.length && cues[i + 1].start <= t) i++;
  state.i = i;
  const c = cues[i];
  return c && c.start <= t && t < c.end ? c : null;
}

/* ------------------------------ timelines ------------------------------ */
function lineDur(ln, lang) {
  if (ln.buffer) return ln.buffer.duration;
  const words = String(ln.text || '').split(/\s+/).filter(Boolean).length;
  return Math.max(1.2, words / (lang === 'en' ? 2.4 : 2.2));
}

function buildStoryTimeline(o) {
  const short = o.format === 'short';
  const segs = [], cues = [], voices = [], sfx = [];
  const capWords = short ? 4 : 9;
  let t = 0;
  let hookEnd = 0;
  if (!short) {
    segs.push({ type: 'intro', start: 0, end: 2.6, img: 0 });
    sfx.push({ type: 'impact', t: 0.05 });
    t = 2.6;
  } else {
    sfx.push({ type: 'impact', t: 0.02 });
  }
  if (o.hook && o.hook.buffer) {
    voices.push({ start: t + 0.1, buffer: o.hook.buffer });
    hookEnd = t + 0.1 + o.hook.buffer.duration + 0.15;
  }
  o.scenes.forEach((sc, i) => {
    const start = t;
    let lt = Math.max(start + (i === 0 ? 0.15 : 0.35), hookEnd);
    for (const ln of sc.lines || []) {
      const d = lineDur(ln, o.lang);
      if (ln.buffer) voices.push({ start: lt, buffer: ln.buffer });
      addCues(cues, lt, lt + d, ln.text, capWords, { speaker: ln.speaker, speakerName: ln.speakerName, color: ln.color });
      lt += d + 0.22;
    }
    const end = Math.max(lt + 0.15, start + 2.5);
    segs.push({ type: 'scene', start, end, img: i, kb: KB[(i + (o.kbOffset || 0)) % KB.length] });
    if (i > 0) sfx.push({ type: 'whoosh', t: start - 0.3 });
    t = end;
  });
  let endDur = short ? 2.6 : 5;
  if (o.outro && o.outro.buffer) {
    voices.push({ start: t + 0.25, buffer: o.outro.buffer });
    addCues(cues, t + 0.25, t + 0.25 + o.outro.buffer.duration, o.outro.text, capWords, { speaker: 'narrator' });
    endDur = Math.max(endDur, o.outro.buffer.duration + 0.9);
  }
  sfx.push({ type: 'ding', t: t + 0.25 });
  segs.push({ type: 'end', start: t, end: t + endDur, img: Math.max(0, o.scenes.length - 1) });
  return { segs, cues: finalizeCues(cues), voices, sfx, duration: t + endDur, hookEnd: Math.max(3, hookEnd) };
}

function buildDanceTimeline(o) {
  const beat = 60 / (o.bpm || 120);
  const bar2 = beat * 2;
  const segs = [], cues = [], voices = [], sfx = [];
  const fitBeats = (d) => Math.max(4 * beat, Math.ceil((d + 0.4) / bar2) * bar2);
  let t = 0, k = 0;
  const n = o.scenes.length || 1;
  if (o.hook) {
    const d = o.hook.buffer ? o.hook.buffer.duration : 1.8;
    const len = fitBeats(d);
    if (o.hook.buffer) voices.push({ start: 0.1, buffer: o.hook.buffer });
    addCues(cues, 0.1, 0.1 + d, o.hook.text, 4, { lyric: true, color: LYRIC_COLORS[0] });
    segs.push({ type: 'dance', start: 0, end: len, img: 0, k: k++ });
    sfx.push({ type: 'impact', t: 0.02 });
    t = len;
  }
  const target = Math.max(8, (o.duration || 30) - 2.6);
  // fit each scene to the time budget the user selected (2–4 beats each)
  const per = Math.min(4 * beat, Math.max(2 * beat, Math.floor((target - t) / n / beat) * beat));
  o.scenes.forEach((sc, i) => {
    const ly = sc.lyric;
    let len = per;
    const voiced = ly && ly.buffer;
    if (i >= 3 && !voiced && t + len > target + 0.01) return; // over budget: skip extra scenes
    if (ly && (ly.text || ly.buffer)) {
      const d = ly.buffer ? ly.buffer.duration : Math.max(1.2, Math.min(per - 0.2, lineDur(ly, o.lang) * 0.8));
      len = ly.buffer ? fitBeats(d) : Math.max(per, Math.ceil((d + 0.2) / beat) * beat);
      if (ly.buffer) voices.push({ start: t + 0.12, buffer: ly.buffer });
      addCues(cues, t + 0.12, t + 0.12 + d, ly.text, 4, { lyric: true, color: LYRIC_COLORS[(i + 1) % LYRIC_COLORS.length] });
    }
    segs.push({ type: 'dance', start: t, end: t + len, img: i, k: k++ });
    sfx.push({ type: 'pop', t: t });
    t += len;
  });
  let j = 0;
  while (t + 4 * beat <= target + 0.01 && j < 200) {
    const len = 4 * beat;
    segs.push({ type: 'dance', start: t, end: t + len, img: (j * 3 + 1) % n, k: k++ });
    t += len; j++;
  }
  let endDur = 2.6;
  if (o.outro && o.outro.buffer) {
    voices.push({ start: t + 0.15, buffer: o.outro.buffer });
    addCues(cues, t + 0.15, t + 0.15 + o.outro.buffer.duration, o.outro.text, 4, { lyric: true, color: '#FFE600' });
    endDur = Math.max(endDur, o.outro.buffer.duration + 0.8);
  }
  sfx.push({ type: 'ding', t: t + 0.2 });
  segs.push({ type: 'end', start: t, end: t + endDur, img: 0, dance: true });
  return { segs, cues: finalizeCues(cues), voices, sfx, duration: t + endDur, beat, hookEnd: 3 };
}

export function buildTimeline(o) {
  return o.mode === 'dance' ? buildDanceTimeline(o) : buildStoryTimeline(o);
}

/* ------------------------------ audio ------------------------------ */
function mergeIntervals(voices) {
  const iv = voices.map((v) => [v.start - 0.15, v.start + v.buffer.duration + 0.25]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const x of iv) {
    if (out.length && x[0] - out[out.length - 1][1] < 0.6) out[out.length - 1][1] = Math.max(out[out.length - 1][1], x[1]);
    else out.push([...x]);
  }
  return out;
}

function makeLevelFn(tl, o) {
  const iv = mergeIntervals(tl.voices);
  const dance = o.mode === 'dance';
  const base = (dance ? 0.8 : 0.26) * (o.musicVolume ?? 1);
  const duck = dance ? 0.5 : 0.42; // ratio while voice is speaking
  const T = tl.duration;
  return (t) => {
    let d = Infinity;
    for (const [a, b] of iv) {
      if (t >= a && t <= b) { d = 0; break; }
      d = Math.min(d, t < a ? a - t : t - b);
      if (a > t + 1) break;
    }
    const duckF = duck + (1 - duck) * clamp(d / 0.3);
    const fade = clamp(t / 1.0) * clamp((T - t) / 2.5);
    return base * duckF * fade;
  };
}

async function renderAudioChunk(tl, o, c0, c1, levelFn) {
  const len = Math.max(1, Math.round((c1 - c0) * SR));
  const ctx = new OfflineAudioContext(2, len, SR);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12; comp.knee.value = 8; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
  comp.connect(ctx.destination);
  const dur = c1 - c0;
  if (o.music) {
    const src = ctx.createBufferSource();
    src.buffer = o.music;
    src.loop = true;
    const g = ctx.createGain();
    const steps = Math.max(2, Math.ceil(dur * 20) + 1);
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) curve[i] = levelFn(c0 + (i / (steps - 1)) * dur);
    g.gain.setValueCurveAtTime(curve, 0, dur);
    src.connect(g).connect(comp);
    src.start(0, c0 % o.music.duration);
  }
  const vg = ctx.createGain();
  vg.gain.value = o.voiceVolume ?? 1.0;
  vg.connect(comp);
  for (const v of tl.voices) {
    const s = v.start, e = v.start + v.buffer.duration;
    if (e <= c0 || s >= c1) continue;
    const src = ctx.createBufferSource();
    src.buffer = v.buffer;
    src.connect(vg);
    src.start(Math.max(0, s - c0), Math.max(0, c0 - s));
  }
  if (o.sfx !== false) {
    for (const x of tl.sfx) {
      if (x.t < c0 || x.t >= c1 - 0.05) continue;
      const lt = x.t - c0;
      if (x.type === 'whoosh') sfxWhoosh(ctx, comp, lt);
      else if (x.type === 'impact') sfxImpact(ctx, comp, lt, 0.4);
      else if (x.type === 'ding') sfxDing(ctx, comp, lt, 0.12);
      else if (x.type === 'pop') sfxPop(ctx, comp, lt, 0.08);
    }
  }
  const buf = await ctx.startRendering();
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      if (x > 0.9 || x < -0.9) d[i] = Math.sign(x) * (0.9 + 0.1 * Math.tanh((Math.abs(x) - 0.9) / 0.1));
    }
  }
  return buf;
}

/* ------------------------------ frame drawing ------------------------------ */
function makeOverlay(W, H, short) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const rg = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  rg.addColorStop(0, 'rgba(0,0,0,0)');
  rg.addColorStop(1, 'rgba(0,0,0,0.45)');
  g.fillStyle = rg; g.fillRect(0, 0, W, H);
  const lg = g.createLinearGradient(0, short ? H * 0.5 : H * 0.6, 0, H);
  lg.addColorStop(0, 'rgba(0,0,0,0)');
  lg.addColorStop(1, 'rgba(0,0,0,0.55)');
  g.fillStyle = lg; g.fillRect(0, 0, W, H);
  const tg = g.createLinearGradient(0, 0, 0, H * 0.18);
  tg.addColorStop(0, 'rgba(0,0,0,0.4)');
  tg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = tg; g.fillRect(0, 0, W, H * 0.18);
  return c;
}

class Painter {
  constructor(canvas, tl, o) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.tl = tl;
    this.o = o;
    this.W = canvas.width; this.H = canvas.height;
    this.short = o.format !== 'long';
    this.U = Math.min(this.W, this.H) / 1080; // unit scale
    this.overlay = makeOverlay(this.W, this.H, this.short);
    this.cueState = {};
    this.segIdx = 0;
    this.S = STR[o.lang] || STR.hinglish;
    this.layoutCache = new WeakMap();
    this.confetti = Array.from({ length: 46 }, (_, i) => ({
      x: rand(i + 1), y: rand(i + 101), vx: (rand(i + 201) - 0.5) * 0.08, vy: 0.08 + rand(i + 301) * 0.16,
      r: rand(i + 401) * Math.PI, vr: (rand(i + 501) - 0.5) * 6, s: 0.6 + rand(i + 601),
      col: LYRIC_COLORS[i % LYRIC_COLORS.length],
    }));
  }

  // ---- real-motion clips (o.clips[sceneIndex] = mp4 Blob) ----
  async prepare(t) {
    const clips = this.o.clips;
    if (!clips || !this.M) return;
    const segs = this.tl.segs;
    const i = this.seg(t);
    const want = new Set();
    for (const s of [segs[i - 1], segs[i], segs[i + 1]]) {
      if (s && (s.type === 'scene' || s.type === 'dance') && clips[s.img]) want.add(s.img);
    }
    this.clipCache = this.clipCache || new Map();
    for (const k of want) if (!this.clipCache.has(k)) this.clipCache.set(k, await this.loadClip(clips[k]));
    // evict clips not needed any more (keep memory low)
    for (const k of [...this.clipCache.keys()]) if (!want.has(k) && this.clipCache.size > 3) this.clipCache.delete(k);
  }

  async loadClip(blob) {
    try {
      const M = this.M;
      const input = new M.Input({ formats: M.ALL_FORMATS, source: new M.BlobSource(blob) });
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) return null;
      const first = await track.getFirstTimestamp();
      const sink = new M.CanvasSink(track, { poolSize: 0 });
      const frames = [];
      for await (const fr of sink.canvases()) frames.push({ c: fr.canvas, t: fr.timestamp - first });
      try { input.dispose?.(); } catch {}
      if (frames.length < 2) return null;
      const last = frames[frames.length - 1];
      return { frames, dur: Math.max(0.2, last.t) };
    } catch (e) { console.warn('clip decode failed', e); return null; }
  }

  clipFrame(k, local) {
    const cl = this.clipCache?.get(k);
    if (!cl) return null;
    const D = cl.dur;
    // ping-pong loop, slightly slowed so motion looks natural on longer scenes
    let x = (local * 0.85) % (2 * D);
    if (x > D) x = 2 * D - x;
    const f = cl.frames;
    let lo = 0, hi = f.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (f[m].t <= x) lo = m; else hi = m - 1; }
    return f[lo].c;
  }

  seg(t) {
    const segs = this.tl.segs;
    let i = this.segIdx;
    if (i >= segs.length || segs[i].start > t) i = 0;
    while (i + 1 < segs.length && segs[i].end <= t) i++;
    this.segIdx = i;
    return i;
  }

  img(i) { const imgs = this.o.images; return imgs[clamp(i, 0, imgs.length - 1)] || imgs.find(Boolean); }

  drawSceneImage(seg, t) {
    const { ctx, W, H } = this;
    const kb = seg.kb || KB[0];
    const p = ease((t - seg.start) / Math.max(0.1, seg.end - seg.start));
    const clip = this.clipFrame(seg.img, t - seg.start);
    if (clip) { drawCover(ctx, clip, W, H, 1.02 + 0.05 * p, 0, 0); return; }
    drawCover(ctx, this.img(seg.img), W, H, kb.z0 + (kb.z1 - kb.z0) * p, kb.x0 + (kb.x1 - kb.x0) * p, kb.y0 + (kb.y1 - kb.y0) * p);
  }

  drawDanceImage(seg, t) {
    const { ctx, W, H } = this;
    const beat = this.tl.beat;
    const local = t - seg.start;
    const ph = (local / beat) % 1;
    const punch = Math.exp(-ph * 6);
    const zoom = 1.12 + 0.07 * punch + 0.04 * Math.sin((local / (beat * 8)) * Math.PI * 2);
    const rot = 0.022 * Math.sin((t / (beat * 2)) * Math.PI * 2);
    const bounce = -Math.abs(Math.sin((t / beat) * Math.PI)) * H * 0.012;
    const flip = seg.k % 2 === 1;
    const shakeX = punch > 0.6 && seg.k % 3 === 0 ? (rand(Math.floor(t * 60)) - 0.5) * 0.04 : 0;
    const clip = this.clipFrame(seg.img, local);
    drawCover(ctx, clip || this.img(seg.img), W, H, clip ? zoom - 0.08 : zoom, shakeX, 0, flip, rot, bounce);
    // segment flash
    const f = 1 - local / 0.16;
    if (f > 0) { ctx.fillStyle = `rgba(255,255,255,${0.55 * f})`; ctx.fillRect(0, 0, W, H); }
    // beat glow ring
    ctx.save();
    ctx.globalAlpha = 0.18 * punch;
    ctx.fillStyle = LYRIC_COLORS[seg.k % LYRIC_COLORS.length];
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  drawConfetti(t) {
    const { ctx, W, H, U } = this;
    ctx.save();
    for (const p of this.confetti) {
      const x = ((p.x + p.vx * t) % 1 + 1) % 1 * W;
      const y = ((p.y + p.vy * t) % 1) * H;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.r + p.vr * t);
      ctx.fillStyle = p.col;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(-9 * U * p.s, -4 * U * p.s, 18 * U * p.s, 8 * U * p.s);
      ctx.restore();
    }
    ctx.restore();
  }

  drawWatermark() {
    const { ctx, W, H, U, o } = this;
    if (!o.channel) return;
    const text = '@' + o.channel.replace(/^@/, '');
    const size = Math.round((this.short ? 34 : 30) * U);
    ctx.font = `700 ${size}px ${FONT}`;
    const tw = ctx.measureText(text).width;
    const padX = 18 * U, h = size * 1.55;
    const x = this.short ? 36 * U : W - tw - padX * 2 - 36 * U;
    const y = this.short ? H * 0.085 : 32 * U;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    roundRect(ctx, x, y, tw + padX * 2, h, h / 2);
    ctx.fill();
    ctx.fillStyle = '#ff2d2d';
    ctx.beginPath(); ctx.arc(x + padX * 0.2 + 2 * U, y + h / 2, 0, 0, 7); ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x + padX, y + h / 2 + size * 0.06);
    ctx.restore();
  }

  drawBadge(text, x, y, size, bg = '#e50914', fg = '#fff') {
    const { ctx } = this;
    ctx.font = `800 ${size}px ${FONT}`;
    const tw = ctx.measureText(text).width;
    const h = size * 1.45, pad = size * 0.5;
    ctx.fillStyle = bg;
    roundRect(ctx, x, y, tw + pad * 2, h, size * 0.3);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(text, x + pad, y + h / 2 + size * 0.06);
    return tw + pad * 2;
  }

  drawTopShort(t) {
    const { ctx, W, H, U, o, tl } = this;
    const hookEnd = tl.hookEnd || 3;
    if (o.hookText && t < hookEnd) {
      const a = clamp(t / 0.25) * clamp((hookEnd - t) / 0.3);
      const sc = 0.8 + 0.2 * easeOutBack(t / 0.4);
      ctx.save();
      ctx.globalAlpha = a;
      const { size, lines } = fitFont(ctx, o.hookText, 800, Math.round(70 * U), W * 0.8, 3, 30);
      const lh = size * 1.25;
      const boxH = lines.length * lh + size * 0.8;
      const cy = H * 0.24;
      ctx.translate(W / 2, cy);
      ctx.scale(sc, sc);
      ctx.rotate(-0.02);
      ctx.fillStyle = '#FFE600';
      roundRect(ctx, -W * 0.45, -boxH / 2, W * 0.9, boxH, 28 * U);
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#111';
      ctx.font = `800 ${size}px ${FONT}`;
      lines.forEach((l, i) => ctx.fillText(l, 0, -((lines.length - 1) * lh) / 2 + i * lh + size * 0.06));
      ctx.restore();
    } else if (o.title) {
      const a = clamp((t - hookEnd) / 0.4);
      ctx.save();
      ctx.globalAlpha = a * 0.95;
      const size = Math.round(34 * U);
      let x = 36 * U;
      const y = H * 0.085 + 62 * U;
      if (o.partLabel) x += this.drawBadge(o.partLabel, x, y, size) + 12 * U;
      const { size: s2, lines } = fitFont(ctx, o.title, 700, size, W - x - 40 * U, 1, 20);
      ctx.font = `700 ${s2}px ${FONT}`;
      ctx.textBaseline = 'middle';
      strokeFill(ctx, lines[0] || '', x, y + size * 0.72, '#fff', 6 * U);
      ctx.restore();
    }
    // progress bar
    const prog = clamp(t / tl.duration);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(0, 0, W, 8 * U);
    ctx.fillStyle = '#FFE600';
    ctx.fillRect(0, 0, W * prog, 8 * U);
  }

  drawLongOverlays(t, seg) {
    const { ctx, W, H, U, o, tl } = this;
    // lower-third title after intro
    const ltStart = 2.8, ltEnd = 7.5;
    if (t > ltStart && t < ltEnd && o.title) {
      const a = clamp((t - ltStart) / 0.4) * clamp((ltEnd - t) / 0.4);
      const slide = (1 - ease((t - ltStart) / 0.5)) * -60 * U;
      ctx.save();
      ctx.globalAlpha = a;
      const x = 60 * U + slide, y = 60 * U; // top-left, so it never covers the subtitles
      const bw = this.drawBadge(o.partLabel || 'STORY', x, y, Math.round(30 * U));
      const { size, lines } = fitFont(ctx, o.title, 800, Math.round(56 * U), W * 0.6, 1, 24);
      ctx.font = `800 ${size}px ${FONT}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      strokeFill(ctx, lines[0] || '', x, y + 54 * U, '#fff', 8 * U);
      ctx.fillStyle = '#FFE600';
      ctx.fillRect(x, y + 54 * U + size * 1.15, Math.max(bw, 160 * U), 6 * U);
      ctx.restore();
    }
    // subscribe reminder at ~30%
    const s0 = Math.max(10, tl.duration * 0.3), s1 = s0 + 4.5;
    if (t > s0 && t < s1 && seg.type === 'scene') this.drawSubscribe(t - s0, s1 - s0, W - 420 * U, 40 * U + 70 * U, 0.8);
  }

  drawSubscribe(lt, dur, x, y, scale = 1) {
    const { ctx, U, S } = this;
    const a = clamp(lt / 0.3) * clamp((dur - lt) / 0.3);
    const pop = easeOutBack(lt / 0.45);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(x, y);
    ctx.scale(pop * scale, pop * scale);
    const size = Math.round(40 * U);
    ctx.font = `800 ${size}px ${FONT}`;
    const text = S.sub;
    const tw = ctx.measureText(text).width;
    const w = tw + 110 * U, h = size * 1.8;
    ctx.fillStyle = '#e50914';
    roundRect(ctx, 0, 0, w, h, 14 * U);
    ctx.fill();
    // bell
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    const bx = 40 * U, by = h / 2;
    ctx.arc(bx, by - 2 * U, 15 * U, Math.PI, 0);
    ctx.lineTo(bx + 18 * U, by + 12 * U);
    ctx.lineTo(bx - 18 * U, by + 12 * U);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath(); ctx.arc(bx, by + 17 * U, 5 * U, 0, Math.PI * 2); ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(text, 75 * U, h / 2 + size * 0.06);
    // click cursor
    if (lt > 1.2) {
      const cp = clamp((lt - 1.2) / 0.5);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3 * U;
      const cx = w * 0.75 + (1 - cp) * 80 * U, cy = h * 0.6 + (1 - cp) * 80 * U;
      ctx.beginPath();
      ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + 44 * U); ctx.lineTo(cx + 12 * U, cy + 33 * U); ctx.lineTo(cx + 28 * U, cy + 36 * U);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
    return { w, h };
  }

  drawCaption(t) {
    const cue = findCue(this.tl.cues, t, this.cueState);
    if (!cue) return;
    const { ctx, W, H, U } = this;
    const lyric = !!cue.lyric;
    const short = this.short;
    const size = Math.round((lyric ? 88 : short ? 76 : 50) * U);
    const weight = 800;
    ctx.font = `${weight} ${size}px ${FONT}`;
    let lay = this.layoutCache.get(cue);
    if (!lay || lay.size !== size) {
      lay = { size, ...wrapWords(ctx, cue.words, short ? W * 0.84 : W * 0.8) };
      this.layoutCache.set(cue, lay);
    }
    const lh = size * 1.28;
    const onEnd = this.tl.segs[this.seg(t)]?.type === 'end';
    const cy = short ? H * (onEnd ? 0.8 : lyric ? 0.7 : 0.66) : H - 120 * U - (lay.lines.length - 1) * lh;
    const age = t - cue.start;
    const pop = short || lyric ? 0.82 + 0.18 * easeOutBack(age / 0.18) : 1;
    ctx.save();
    ctx.translate(W / 2, cy);
    ctx.scale(pop, pop);
    if (lyric) ctx.rotate(Math.sin(t * 3) * 0.015);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const top = -((lay.lines.length - 1) * lh) / 2;
    if (!short && !lyric) {
      const maxW = Math.max(...lay.lines.map((l) => l.width));
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      roundRect(ctx, -maxW / 2 - 24 * U, top - lh / 2 - 6 * U, maxW + 48 * U, lay.lines.length * lh + 12 * U, 14 * U);
      ctx.fill();
    }
    // speaker pill
    if (cue.speakerName && cue.speaker !== 'narrator') {
      const ps = Math.round((short ? 36 : 28) * U);
      ctx.font = `800 ${ps}px ${FONT}`;
      const tw = ctx.measureText(cue.speakerName).width;
      const ph = ps * 1.5;
      const py = top - lh / 2 - ph - 14 * U;
      ctx.fillStyle = cue.color || '#ff9f1c';
      roundRect(ctx, -tw / 2 - 18 * U, py, tw + 36 * U, ph, ph / 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(cue.speakerName, 0, py + ph / 2 + ps * 0.06);
      ctx.textAlign = 'left';
      ctx.font = `${weight} ${size}px ${FONT}`;
    }
    const baseCol = lyric ? cue.color || '#FFE600' : '#ffffff';
    lay.lines.forEach((line, li) => {
      let x = -line.width / 2;
      const y = top + li * lh;
      for (const w of line.items) {
        const active = t >= w.s && t < w.e + 0.05;
        const done = t >= w.e;
        let col = baseCol;
        if (short && !lyric) col = active ? '#FFE600' : '#ffffff';
        if (lyric) col = active ? '#ffffff' : baseCol;
        if (active && (short || lyric)) {
          const k = 1 + 0.1 * Math.exp(-(t - w.s) * 10);
          ctx.save();
          ctx.translate(x + w.width / 2, y);
          ctx.scale(k, k);
          strokeFill(ctx, w.w, -w.width / 2, 0, col, (short ? 14 : 8) * U);
          ctx.restore();
        } else {
          ctx.globalAlpha = short || lyric || done || active ? 1 : 0.92;
          strokeFill(ctx, w.w, x, y, col, short || lyric ? 14 * U : 7 * U);
          ctx.globalAlpha = 1;
        }
        x += w.width + lay.space;
      }
    });
    ctx.restore();
  }

  drawIntro(seg, t) {
    const { ctx, W, H, U, o, S } = this;
    const p = (t - seg.start) / (seg.end - seg.start);
    drawCover(ctx, this.img(seg.img), W, H, 1.3 - 0.08 * p, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const a1 = clamp((t - seg.start) / 0.4);
    ctx.globalAlpha = a1;
    if (o.channel) {
      ctx.font = `700 ${Math.round(44 * U)}px ${FONT}`;
      ctx.fillStyle = '#FFE600';
      ctx.fillText(`@${o.channel.replace(/^@/, '')} ${S.presents}`, W / 2, H * 0.36);
    }
    const a2 = clamp((t - seg.start - 0.5) / 0.5);
    ctx.globalAlpha = a2;
    const sc = 0.9 + 0.1 * easeOutBack((t - seg.start - 0.5) / 0.6);
    ctx.save();
    ctx.translate(W / 2, H * 0.52);
    ctx.scale(sc, sc);
    const { size, lines } = fitFont(ctx, o.title || '', 800, Math.round(110 * U), W * 0.8, 2, 40);
    ctx.font = `800 ${size}px ${FONT}`;
    lines.forEach((l, i) => strokeFill(ctx, l, 0, (i - (lines.length - 1) / 2) * size * 1.2, '#fff', 12 * U));
    ctx.restore();
    if (o.partLabel) {
      ctx.globalAlpha = clamp((t - seg.start - 1) / 0.4);
      ctx.font = `800 ${Math.round(40 * U)}px ${FONT}`;
      const tw = ctx.measureText(o.partLabel).width;
      ctx.fillStyle = '#e50914';
      roundRect(ctx, W / 2 - tw / 2 - 24 * U, H * 0.7 - 32 * U, tw + 48 * U, 64 * U, 12 * U);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(o.partLabel, W / 2, H * 0.7 + 2 * U);
    }
    ctx.globalAlpha = 1;
  }

  drawEnd(seg, t) {
    const { ctx, W, H, U, o, S } = this;
    const lt = t - seg.start;
    const p = lt / (seg.end - seg.start);
    drawCover(ctx, this.img(seg.img), W, H, 1.2 + 0.06 * p, 0, 0);
    ctx.fillStyle = `rgba(0,0,0,${0.35 + 0.35 * clamp(lt / 0.5)})`;
    ctx.fillRect(0, 0, W, H);
    if (seg.dance) this.drawConfetti(t);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const msg = o.nextPart ? S.next(o.nextPart) : seg.dance ? S.like : S.end;
    const sc = easeOutBack(lt / 0.5);
    ctx.save();
    ctx.translate(W / 2, H * (this.short ? 0.38 : 0.36));
    ctx.scale(sc, sc);
    const { size, lines } = fitFont(ctx, msg, 800, Math.round((this.short ? 92 : 96) * U), W * 0.84, 2, 30);
    ctx.font = `800 ${size}px ${FONT}`;
    lines.forEach((l, i) => strokeFill(ctx, l, 0, (i - (lines.length - 1) / 2) * size * 1.2, '#FFE600', 12 * U));
    ctx.restore();
    if (o.channel) {
      ctx.font = `700 ${Math.round(50 * U)}px ${FONT}`;
      ctx.globalAlpha = clamp((lt - 0.3) / 0.4);
      strokeFill(ctx, '@' + o.channel.replace(/^@/, ''), W / 2, H * (this.short ? 0.5 : 0.52), '#fff', 8 * U);
      ctx.globalAlpha = 1;
    }
    if (lt > 0.5) {
      ctx.save();
      const pulse = 1 + 0.05 * Math.sin(lt * 8);
      const size = Math.round(40 * U);
      ctx.font = `800 ${size}px ${FONT}`;
      const w = ctx.measureText(S.sub).width + 110 * U;
      ctx.translate(W / 2, H * (this.short ? 0.6 : 0.68));
      ctx.scale(pulse, pulse);
      this.drawSubscribe(lt - 0.5, 99, -w / 2, -size * 0.9, 1);
      ctx.restore();
    }
  }

  draw(t) {
    const { ctx, W, H, tl } = this;
    const si = this.seg(t);
    const seg = tl.segs[si];
    ctx.save();
    ctx.globalAlpha = 1;
    if (seg.type === 'intro') this.drawIntro(seg, t);
    else if (seg.type === 'end') this.drawEnd(seg, t);
    else if (seg.type === 'dance') {
      this.drawDanceImage(seg, t);
      ctx.drawImage(this.overlay, 0, 0);
      this.drawConfetti(t);
    } else {
      const prev = tl.segs[si - 1];
      const xf = 0.45;
      if (prev && prev.type === 'scene' && t - seg.start < xf) {
        this.drawSceneImage(prev, t);
        ctx.globalAlpha = ease((t - seg.start) / xf);
        this.drawSceneImage(seg, t);
        ctx.globalAlpha = 1;
      } else this.drawSceneImage(seg, t);
      ctx.drawImage(this.overlay, 0, 0);
    }
    ctx.restore();
    if (seg.type === 'scene' || seg.type === 'dance') {
      if (this.short) this.drawTopShort(t);
      else this.drawLongOverlays(t, seg);
    }
    if (seg.type !== 'intro') this.drawCaption(t);
    if (seg.type !== 'intro' && seg.type !== 'end') this.drawWatermark();
    // fade in/out
    const T = tl.duration;
    const fo = Math.min(clamp(t / 0.25), clamp((T - t) / 0.5));
    if (fo < 1) { ctx.fillStyle = `rgba(0,0,0,${1 - fo})`; ctx.fillRect(0, 0, W, H); }
  }
}

/* ------------------------------ main render ------------------------------ */
/**
 * o = { mode, format, quality, lang, images:[ImageBitmap], scenes:[{lines:[{text,buffer,speaker,speakerName,color}], lyric?}],
 *       hook?, outro?, hookText, title, partLabel, nextPart, channel, music (AudioBuffer|null), musicVolume, bpm, duration,
 *       canvas?, onProgress(frac, msg), signal }
 * returns { blob, mime, ext, duration }
 */
export async function renderVideo(o) {
  await ensureFonts();
  const M = await import(MB_URL);
  const { W, H } = videoSize(o.format, o.quality);
  const canvas = o.canvas || document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const tl = buildTimeline(o);
  const painter = new Painter(canvas, tl, o);
  painter.M = M;
  const bitrate = Math.round((o.format === 'long' ? 5e6 : 6e6) * (o.quality === 'sd' ? 0.55 : 1));

  const vCodec = await M.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1', 'vp8'], { width: W, height: H, bitrate });
  if (!vCodec) throw new Error('Is browser me video encoding (WebCodecs) support nahi hai. Chrome / Edge latest use karein.');
  const useMp4 = vCodec === 'avc' || vCodec === 'av1';
  const aCodec = await M.getFirstEncodableAudioCodec(useMp4 ? ['aac', 'opus'] : ['opus', 'vorbis'], { numberOfChannels: 2, sampleRate: SR, bitrate: 160e3 });
  if (!aCodec) throw new Error('Audio encoding support nahi mila. Chrome / Edge latest use karein.');

  const output = new M.Output({
    format: useMp4 ? new M.Mp4OutputFormat({ fastStart: 'in-memory' }) : new M.WebMOutputFormat(),
    target: new M.BufferTarget(),
  });
  const vs = new M.CanvasSource(canvas, { codec: vCodec, bitrate, keyFrameInterval: 2 });
  const as = new M.AudioBufferSource({ codec: aCodec, bitrate: 160000 });
  output.addVideoTrack(vs, { frameRate: FPS });
  output.addAudioTrack(as);
  await output.start();

  const T = tl.duration;
  const totalFrames = Math.ceil(T * FPS);
  const levelFn = makeLevelFn(tl, o);
  const report = (f, msg) => o.onProgress && o.onProgress(f, msg);
  let frame = 0;
  try {
    for (let c0 = 0; c0 < T; c0 += CHUNK) {
      const c1 = Math.min(T, c0 + CHUNK);
      if (o.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      report(frame / totalFrames, 'Audio mix ho raha hai…');
      const abuf = await renderAudioChunk(tl, o, c0, c1, levelFn);
      await as.add(abuf);
      const fEnd = Math.min(totalFrames, Math.ceil(c1 * FPS - 1e-6));
      let lastYield = performance.now();
      for (; frame < fEnd; frame++) {
        if (o.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        const t = frame / FPS;
        if (o.clips) await painter.prepare(t);
        painter.draw(t);
        await vs.add(t, 1 / FPS);
        if (frame % 15 === 0) report(frame / totalFrames, `Video render: ${Math.floor(t)}s / ${Math.ceil(T)}s`);
        if (performance.now() - lastYield > 200) { await new Promise((r) => setTimeout(r, 0)); lastYield = performance.now(); }
      }
    }
    report(0.995, 'Final MP4 ban raha hai…');
    await output.finalize();
  } catch (e) {
    try { await output.cancel(); } catch {}
    throw e;
  }
  const mime = useMp4 ? 'video/mp4' : 'video/webm';
  const blob = new Blob([output.target.buffer], { type: mime });
  report(1, 'Done');
  return { blob, mime, ext: useMp4 ? 'mp4' : 'webm', duration: T, width: W, height: H };
}

/** Render one preview frame at time t (for UI previews). */
export async function previewFrame(o, t, canvas) {
  await ensureFonts();
  const { W, H } = videoSize(o.format, 'sd');
  canvas.width = W; canvas.height = H;
  const tl = buildTimeline(o);
  new Painter(canvas, tl, o).draw(Math.min(t, tl.duration - 0.01));
  return tl;
}

/* ------------------------------ thumbnail ------------------------------ */
export async function composeThumbnail({ image, title, partLabel, channel, format }) {
  await ensureFonts();
  const short = format !== 'long';
  const W = short ? 1080 : 1280, H = short ? 1920 : 720;
  const U = Math.min(W, H) / 720;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  drawCover(ctx, image, W, H, 1.1, 0, 0);
  const g = ctx.createLinearGradient(0, short ? H * 0.35 : 0, short ? 0 : W * 0.75, short ? H : 0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.0)');
  ctx.fillStyle = g;
  if (short) {
    const lg = ctx.createLinearGradient(0, H * 0.45, 0, H);
    lg.addColorStop(0, 'rgba(0,0,0,0)'); lg.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H);
  } else {
    const lg = ctx.createLinearGradient(0, 0, W * 0.7, 0);
    lg.addColorStop(0, 'rgba(0,0,0,0.85)'); lg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H);
  }
  const maxW = short ? W * 0.88 : W * 0.56;
  const { size, lines } = fitFont(ctx, title || '', 800, Math.round((short ? 110 : 92) * (short ? 1 : U * 0.9)), maxW, 3, 30);
  ctx.font = `800 ${size}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = short ? 'center' : 'left';
  const lh = size * 1.12;
  const x = short ? W / 2 : 48;
  const y0 = short ? H * 0.72 - ((lines.length - 1) * lh) / 2 : H / 2 - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => strokeFill(ctx, l, x, y0 + i * lh, i === 0 ? '#FFE600' : '#ffffff', size * 0.16));
  if (partLabel) {
    const ps = Math.round(short ? 60 : 44);
    ctx.font = `800 ${ps}px ${FONT}`;
    const tw = ctx.measureText(partLabel).width;
    ctx.save();
    ctx.translate(short ? W / 2 - (tw + ps) / 2 : 40, short ? H * 0.12 : 36);
    ctx.rotate(-0.04);
    ctx.fillStyle = '#e50914';
    roundRect(ctx, 0, 0, tw + ps, ps * 1.5, ps * 0.25);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(partLabel, ps / 2, ps * 0.78);
    ctx.restore();
  }
  if (channel) {
    const cs = Math.round(short ? 44 : 30);
    ctx.font = `700 ${cs}px ${FONT}`;
    ctx.textAlign = short ? 'center' : 'left';
    strokeFill(ctx, '@' + channel.replace(/^@/, ''), short ? W / 2 : 48, H - (short ? 120 : 44), '#ffffff', 6);
  }
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
}
