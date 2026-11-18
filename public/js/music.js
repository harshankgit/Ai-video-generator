// Procedural, 100% original background music + sound effects.
// Everything is synthesized in the browser with WebAudio, so there is no copyright risk.

export const MUSIC_MOODS = {
  happy:    { label: 'Happy / Cheerful', bpm: 110, root: 60, prog: [[0, 4, 7], [-5, -1, 2], [-3, 0, 4], [-7, -3, 0]], drums: 'pop', bass: 'eighth', arp: 'up', pad: 'saw', cutoff: 1800, lead: 'pluck' },
  comedy:   { label: 'Comedy / Funny', bpm: 128, root: 65, prog: [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]], drums: 'pop', bass: 'bounce', arp: 'staccato', pad: 'tri', cutoff: 1500, lead: 'square' },
  sad:      { label: 'Sad / Emotional', bpm: 70, root: 57, prog: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]], drums: null, bass: 'half', arp: 'piano', pad: 'saw', cutoff: 900, lead: null },
  suspense: { label: 'Suspense / Thriller', bpm: 96, root: 50, prog: [[0, 3, 7], [0, 3, 7], [1, 5, 8], [0, 3, 6]], drums: 'tick', bass: 'pulse16', arp: null, pad: 'saw', cutoff: 700, lead: null },
  horror:   { label: 'Horror / Dark', bpm: 60, root: 45, prog: [[0, 1, 6], [0, 3, 6], [0, 1, 6], [-1, 3, 6]], drums: 'heartbeat', bass: 'drone', arp: null, pad: 'saw', cutoff: 500, lead: 'ghost' },
  epic:     { label: 'Epic / Mythology', bpm: 92, root: 50, prog: [[0, 3, 7], [-4, 0, 3], [5, 8, 12], [7, 11, 14]], drums: 'taiko', bass: 'eighth', arp: null, pad: 'saw', cutoff: 2200, lead: 'brass' },
  romantic: { label: 'Romantic / Love', bpm: 76, root: 63, prog: [[0, 4, 7, 11], [-3, 0, 4, 7], [2, 5, 9, 12], [-5, -1, 2, 5]], drums: 'soft', bass: 'half', arp: 'slow', pad: 'tri', cutoff: 1200, lead: null },
  calm:     { label: 'Calm / Peaceful', bpm: 72, root: 60, prog: [[0, 4, 7, 11], [5, 9, 12, 16], [-3, 0, 4, 7], [5, 9, 12, 14]], drums: null, bass: 'half', arp: 'bells', pad: 'tri', cutoff: 1000, lead: null },
  desi:     { label: 'Desi / Village (Dholak)', bpm: 100, root: 62, prog: [[0, 4, 7], [0, 4, 7], [-2, 2, 5], [0, 4, 7]], drums: 'dholak', bass: 'drone', arp: 'desi', pad: 'tri', cutoff: 1400, lead: 'flute' },
  dance:    { label: 'Dance / Party (124 BPM)', bpm: 124, root: 62, prog: [[0, 4, 7], [-5, -1, 2], [-3, 0, 4], [-7, -3, 0]], drums: 'edm', bass: 'offbeat', arp: 'up', pad: 'saw', cutoff: 2600, lead: 'hook' },
  kids:     { label: 'Kids / Rhymes', bpm: 116, root: 67, prog: [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]], drums: 'pop', bass: 'bounce', arp: 'bells', pad: 'tri', cutoff: 1600, lead: 'hook' },
};

export const MOOD_KEYS = Object.keys(MUSIC_MOODS);

export function bpmOf(mood) {
  return (MUSIC_MOODS[mood] || MUSIC_MOODS.happy).bpm;
}

/** Pick the most common mood from scenes; maps story moods to music moods. */
export function dominantMood(scenes = [], fallback = 'happy') {
  const count = {};
  for (const s of scenes) {
    const m = MUSIC_MOODS[s.mood] ? s.mood : null;
    if (m) count[m] = (count[m] || 0) + 1;
  }
  const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : fallback;
}

const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noiseCache = new WeakMap();
function noiseBuffer(ctx) {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = b.getChannelData(0);
    const r = rng(1234);
    for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

function env(ctx, t, { attack = 0.005, hold = 0, release = 0.2, peak = 0.2 }) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  if (hold) g.gain.setValueAtTime(peak, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  return g;
}

function tone(ctx, dest, freq, t, { type = 'sine', attack = 0.005, hold = 0, release = 0.3, peak = 0.1, detune = 0, cutoff = 0, pan = 0, glideTo = 0 } = {}) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + attack + hold + release);
  o.detune.value = detune;
  const g = env(ctx, t, { attack, hold, release, peak });
  let node = o;
  if (cutoff) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    node.connect(f);
    node = f;
  }
  node.connect(g);
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    p.connect(dest);
  } else g.connect(dest);
  o.start(t);
  o.stop(t + attack + hold + release + 0.05);
}

function noiseHit(ctx, dest, t, { type = 'highpass', freq = 7000, q = 0.7, release = 0.05, peak = 0.08, pan = 0 } = {}) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = env(ctx, t, { attack: 0.002, release, peak });
  s.connect(f);
  f.connect(g);
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    p.connect(dest);
  } else g.connect(dest);
  s.start(t, Math.random() * 1.5);
  s.stop(t + release + 0.05);
}

function kick(ctx, dest, t, peak = 0.5) {
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  const g = env(ctx, t, { attack: 0.002, release: 0.35, peak });
  o.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + 0.4);
}

function snare(ctx, dest, t, peak = 0.18) {
  noiseHit(ctx, dest, t, { type: 'highpass', freq: 1500, release: 0.16, peak });
  tone(ctx, dest, 190, t, { type: 'triangle', release: 0.08, peak: peak * 0.6 });
}

function clap(ctx, dest, t, peak = 0.2) {
  for (let i = 0; i < 3; i++) noiseHit(ctx, dest, t + i * 0.012, { type: 'bandpass', freq: 1300, q: 1.2, release: i === 2 ? 0.14 : 0.02, peak });
}

function tom(ctx, dest, t, f0, peak = 0.4, release = 0.5) {
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + release);
  const g = env(ctx, t, { attack: 0.003, release, peak });
  o.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + release + 0.05);
}

function drums(ctx, dest, style, t0, beat, bar) {
  const at = (b) => t0 + b * beat;
  switch (style) {
    case 'pop':
      kick(ctx, dest, at(0), 0.45); kick(ctx, dest, at(2), 0.4); kick(ctx, dest, at(2.5), 0.3);
      snare(ctx, dest, at(1)); snare(ctx, dest, at(3));
      for (let i = 0; i < 8; i++) noiseHit(ctx, dest, at(i / 2), { peak: i % 2 ? 0.03 : 0.05, pan: 0.3 });
      break;
    case 'edm':
      for (let i = 0; i < 4; i++) kick(ctx, dest, at(i), 0.55);
      clap(ctx, dest, at(1)); clap(ctx, dest, at(3));
      for (let i = 0; i < 4; i++) noiseHit(ctx, dest, at(i + 0.5), { freq: 6000, release: 0.12, peak: 0.07, pan: -0.2 });
      for (let i = 0; i < 16; i++) noiseHit(ctx, dest, at(i / 4), { freq: 9000, release: 0.025, peak: 0.02, pan: 0.3 });
      if (bar % 4 === 3) for (let i = 0; i < 8; i++) snare(ctx, dest, at(2 + i / 4), 0.05 + i * 0.015);
      break;
    case 'soft':
      kick(ctx, dest, at(0), 0.25);
      noiseHit(ctx, dest, at(2), { type: 'bandpass', freq: 2500, release: 0.05, peak: 0.07 });
      for (let i = 0; i < 8; i++) noiseHit(ctx, dest, at(i / 2), { freq: 8000, release: 0.04, peak: 0.018 });
      break;
    case 'taiko':
      tom(ctx, dest, at(0), 90, 0.55, 0.7); tom(ctx, dest, at(1.5), 110, 0.3); tom(ctx, dest, at(2), 90, 0.45, 0.6);
      tom(ctx, dest, at(3), 130, 0.25, 0.3); tom(ctx, dest, at(3.5), 130, 0.3, 0.3);
      if (bar % 2 === 1) { tom(ctx, dest, at(3.75), 150, 0.3, 0.3); noiseHit(ctx, dest, at(0), { freq: 3000, release: 0.6, peak: 0.05 }); }
      break;
    case 'dholak': {
      const dha = (b) => { tom(ctx, dest, at(b), 115, 0.38, 0.35); noiseHit(ctx, dest, at(b), { type: 'bandpass', freq: 900, release: 0.04, peak: 0.05 }); };
      const na = (b, p = 0.16) => { tone(ctx, dest, 420, at(b), { release: 0.09, peak: p, pan: 0.25 }); noiseHit(ctx, dest, at(b), { type: 'bandpass', freq: 3200, q: 2, release: 0.03, peak: 0.06, pan: 0.25 }); };
      dha(0); na(0.5); na(1); na(1.5, 0.1); dha(2); dha(2.5); na(3); na(3.5); na(3.75, 0.09);
      break;
    }
    case 'tick':
      for (let i = 0; i < 8; i++) noiseHit(ctx, dest, at(i / 2), { freq: 5000, release: 0.03, peak: i % 2 ? 0.025 : 0.045 });
      kick(ctx, dest, at(0), 0.3);
      break;
    case 'heartbeat':
      kick(ctx, dest, at(0), 0.35); kick(ctx, dest, at(0.3), 0.25);
      break;
    default:
      break;
  }
}

/** Render a seamless loop for a mood. Returns AudioBuffer (stereo). */
async function renderLoop(mood, sampleRate = 48000, seed = 7) {
  const M = MUSIC_MOODS[mood] || MUSIC_MOODS.happy;
  const beat = 60 / M.bpm;
  const bars = 8;
  const loopLen = bars * 4 * beat;
  const tail = 2.5;
  const ctx = new OfflineAudioContext(2, Math.ceil((loopLen + tail) * sampleRate), sampleRate);
  const r = rng(seed + M.bpm);

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 4;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(comp);
  comp.connect(ctx.destination);

  // simple stereo "reverb" using two delays
  const wet = ctx.createGain();
  wet.gain.value = 0.25;
  const dl = ctx.createDelay(1); dl.delayTime.value = 0.23;
  const dr = ctx.createDelay(1); dr.delayTime.value = 0.31;
  const fb = ctx.createGain(); fb.gain.value = 0.35;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2500;
  const merger = ctx.createChannelMerger(2);
  wet.connect(dl); wet.connect(dr);
  dl.connect(lp); lp.connect(fb); fb.connect(dl); fb.connect(dr);
  dl.connect(merger, 0, 0); dr.connect(merger, 0, 1);
  merger.connect(master);
  const bus = ctx.createGain();
  bus.connect(master);
  bus.connect(wet);
  const drumBus = ctx.createGain();
  drumBus.gain.value = 0.9;
  drumBus.connect(master);

  const hook = Array.from({ length: 8 }, () => ({ step: Math.floor(r() * 3), on: r() > 0.3 }));
  hook[0].on = true;

  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * 4 * beat;
    const chord = M.prog[Math.floor(bar / 2) % M.prog.length];
    const notes = chord.map((n) => M.root + n);

    // pad (once per 2 bars)
    if (bar % 2 === 0) {
      const span = 8 * beat;
      for (const n of notes) {
        for (const dt of [-7, 7]) {
          tone(ctx, bus, mtof(n), t0, { type: M.pad === 'saw' ? 'sawtooth' : 'triangle', attack: Math.min(0.6, span / 4), hold: span - 0.9, release: 0.9, peak: M.pad === 'saw' ? 0.022 : 0.04, detune: dt, cutoff: M.cutoff, pan: dt > 0 ? 0.3 : -0.3 });
        }
      }
    }

    // bass
    const bassN = M.root + chord[0] - 24;
    const bf = mtof(bassN);
    switch (M.bass) {
      case 'eighth': for (let i = 0; i < 8; i++) tone(ctx, bus, bf, t0 + i * beat / 2, { type: 'triangle', release: beat * 0.45, peak: 0.16, cutoff: 600 }); break;
      case 'half': for (let i = 0; i < 2; i++) tone(ctx, bus, bf, t0 + i * 2 * beat, { type: 'sine', attack: 0.02, hold: beat * 1.4, release: 0.5, peak: 0.2 }); break;
      case 'offbeat': for (let i = 0; i < 4; i++) tone(ctx, bus, bf * 2, t0 + (i + 0.5) * beat, { type: 'sawtooth', release: beat * 0.4, peak: 0.12, cutoff: 900 }); break;
      case 'pulse16': for (let i = 0; i < 16; i++) tone(ctx, bus, bf, t0 + i * beat / 4, { type: 'sawtooth', release: beat * 0.2, peak: i % 4 === 0 ? 0.12 : 0.07, cutoff: 450 }); break;
      case 'bounce': {
        const fifth = mtof(bassN + 7);
        [bf, fifth, bf, fifth].forEach((f, i) => tone(ctx, bus, f, t0 + i * beat, { type: 'triangle', release: 0.18, peak: 0.2, cutoff: 900 }));
        break;
      }
      case 'drone':
        if (bar % 2 === 0) {
          tone(ctx, bus, bf, t0, { type: 'sawtooth', attack: 0.8, hold: 8 * beat - 1.2, release: 1, peak: 0.06, cutoff: 300 });
          tone(ctx, bus, mtof(bassN + 7), t0, { type: 'sawtooth', attack: 0.8, hold: 8 * beat - 1.2, release: 1, peak: 0.035, cutoff: 400 });
        }
        break;
      default: break;
    }

    // arps / melodic layer
    const up = notes.map((n) => n + 12);
    switch (M.arp) {
      case 'up': for (let i = 0; i < 8; i++) tone(ctx, bus, mtof(up[i % up.length] + (i >= 4 ? 12 : 0)), t0 + i * beat / 2, { type: 'triangle', release: 0.22, peak: 0.05, pan: i % 2 ? 0.4 : -0.4 }); break;
      case 'staccato': for (let i = 0; i < 8; i++) if (i % 3 !== 2) tone(ctx, bus, mtof(up[(i * 2) % up.length]), t0 + i * beat / 2, { type: 'square', release: 0.08, peak: 0.03, cutoff: 2500 }); break;
      case 'piano': for (let i = 0; i < 8; i++) tone(ctx, bus, mtof([...notes, ...up][i % (notes.length * 2)]), t0 + i * beat / 2, { type: 'triangle', release: 1.2, peak: 0.06 }); break;
      case 'slow': for (let i = 0; i < 4; i++) tone(ctx, bus, mtof(up[i % up.length]), t0 + i * beat, { type: 'sine', release: 1.0, peak: 0.06, pan: i % 2 ? 0.3 : -0.3 }); break;
      case 'bells': for (let i = 0; i < 4; i++) if (r() > 0.25) { const f = mtof(up[Math.floor(r() * up.length)] + 12); tone(ctx, bus, f, t0 + i * beat, { type: 'sine', release: 1.4, peak: 0.045 }); tone(ctx, bus, f * 3.01, t0 + i * beat, { type: 'sine', release: 0.5, peak: 0.01 }); } break;
      case 'desi': for (let i = 0; i < 8; i++) if (i % 2 === 0 || r() > 0.5) tone(ctx, bus, mtof(M.root + [0, 2, 4, 7, 9][Math.floor(r() * 5)] + 12), t0 + i * beat / 2, { type: 'sawtooth', release: 0.25, peak: 0.025, cutoff: 1800 }); break;
      default: break;
    }

    // lead
    switch (M.lead) {
      case 'hook':
      case 'pluck':
      case 'square': {
        if (M.lead === 'pluck' && bar % 2 === 1) break;
        const type = M.lead === 'square' ? 'square' : M.lead === 'hook' ? 'sawtooth' : 'triangle';
        hook.forEach((h, i) => {
          if (!h.on) return;
          const n = up[h.step % up.length] + 12;
          tone(ctx, bus, mtof(n), t0 + i * beat / 2, { type, release: 0.18, peak: type === 'triangle' ? 0.05 : 0.025, cutoff: 3000 });
        });
        break;
      }
      case 'flute':
        if (bar % 2 === 0) {
          const scale = [0, 2, 4, 7, 9, 12];
          for (let i = 0; i < 4; i++) {
            const n = M.root + 12 + scale[Math.floor(r() * scale.length)];
            tone(ctx, bus, mtof(n), t0 + i * beat * 2, { type: 'sine', attack: 0.08, hold: beat * 1.2, release: 0.4, peak: 0.05 });
          }
        }
        break;
      case 'brass':
        if (bar % 2 === 0) tone(ctx, bus, mtof(notes[0] + 12), t0, { type: 'sawtooth', attack: 0.15, hold: beat * 2.5, release: 0.6, peak: 0.04, cutoff: 1600 });
        break;
      case 'ghost':
        if (r() > 0.4) {
          const f = 900 + r() * 700;
          tone(ctx, bus, f, t0 + r() * 2 * beat, { type: 'sine', attack: 0.6, hold: 0.8, release: 1.2, peak: 0.025, glideTo: f * 0.7 });
        }
        break;
      default: break;
    }

    if (M.drums) drums(ctx, drumBus, M.drums, t0, beat, bar);
  }

  const rendered = await ctx.startRendering();
  const len = Math.floor(loopLen * sampleRate);
  const tailLen = rendered.length - len;
  const out = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate });
  let peak = 0;
  for (let c = 0; c < 2; c++) {
    const src = rendered.getChannelData(c);
    const dst = out.getChannelData(c);
    dst.set(src.subarray(0, len));
    for (let i = 0; i < tailLen && i < len; i++) dst[i] += src[len + i];
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(dst[i]));
  }
  if (peak > 0) {
    const k = 0.9 / peak;
    for (let c = 0; c < 2; c++) {
      const d = out.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] *= k;
    }
  }
  return out;
}

const loopCache = new Map();
export function getMusicLoop(mood, sampleRate = 48000) {
  const key = `${mood}@${sampleRate}`;
  if (!loopCache.has(key)) loopCache.set(key, renderLoop(mood, sampleRate));
  return loopCache.get(key);
}

/** Preview a mood in the UI (returns a stop function). */
export async function previewMood(mood) {
  const buf = await getMusicLoop(mood);
  const ac = new AudioContext();
  const s = ac.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  const g = ac.createGain();
  g.gain.value = 0.6;
  s.connect(g);
  g.connect(ac.destination);
  s.start();
  return () => { try { s.stop(); } catch { /* already stopped */ } ac.close(); };
}

// ---------------- Sound effects (scheduled inside a render context) ----------------

export function sfxWhoosh(ctx, dest, t, { dur = 0.55, peak = 0.22 } = {}) {
  if (t < 0) return;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.4;
  f.frequency.setValueAtTime(350, t);
  f.frequency.exponentialRampToValueAtTime(3800, t + dur * 0.7);
  f.frequency.exponentialRampToValueAtTime(1200, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f);
  f.connect(g);
  g.connect(dest);
  s.start(t);
  s.stop(t + dur + 0.05);
}

export function sfxPop(ctx, dest, t, peak = 0.15) {
  if (t < 0) return;
  tone(ctx, dest, 520, t, { type: 'sine', release: 0.09, peak, glideTo: 1100 });
}

export function sfxImpact(ctx, dest, t, peak = 0.5) {
  if (t < 0) return;
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(110, t);
  o.frequency.exponentialRampToValueAtTime(32, t + 0.8);
  const g = env(ctx, t, { attack: 0.003, release: 1.1, peak });
  o.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + 1.2);
  noiseHit(ctx, dest, t, { type: 'lowpass', freq: 1800, release: 0.5, peak: peak * 0.4 });
}

export function sfxDing(ctx, dest, t, peak = 0.12) {
  if (t < 0) return;
  tone(ctx, dest, 1318, t, { type: 'sine', release: 0.9, peak });
  tone(ctx, dest, 1976, t + 0.08, { type: 'sine', release: 0.9, peak: peak * 0.7 });
}
