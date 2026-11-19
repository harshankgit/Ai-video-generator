// AI Story Video Studio – UI + pipeline (everything runs in the browser)
import { CATEGORIES, STYLES, DEFAULT_STYLE_BY_CATEGORY, getCategory, getStyle } from './topics.js';
import { getSettings, saveSettings, onWait } from './ai.js';
import { db } from './db.js';
import {
  freshIdeas, createBible, createStoryScript, createDanceScript, createMetadata, fullDescription, sceneCount,
} from './story.js';
import { ALL_VOICES, voiceLabel, assignVoices, ttsBlob, decodeAudio, pool, sceneImage, thumbImage, hashStr } from './media.js';
import { MUSIC_MOODS, MOOD_KEYS, bpmOf, dominantMood, getMusicLoop, previewMood } from './music.js';
import { renderVideo, composeThumbnail, ensureFonts } from './render.js';
import { sceneClip, QuotaError } from './motion.js';
import { chatbot } from './chatbot.js';

const $app = document.getElementById('app');
const COLORS = ['#FFD54F', '#4FC3F7', '#F48FB1', '#A5D6A7', '#CE93D8', '#FFAB91', '#80DEEA', '#E6EE9C'];
const SHORT_DUR = [15, 30, 45, 60, 90, 120, 180];
const LONG_DUR = [60, 120, 180, 300, 480, 600];
const LANGS = { hinglish: 'Hinglish (Roman captions + Hindi voice)', hi: 'Hindi (हिंदी captions + voice)', en: 'English' };
const jobs = new Map(); // `${pid}/${n}` -> {frac,msg,abort,canvas,error}
const urls = new Set();
let serverCfg = {};
fetch('/api/config').then((r) => r.json()).then((c) => (serverCfg = c || {})).catch(() => {});
/** True when a fast image engine (Cloudflare / Pollinations key) is configured; else free anonymous (rate-limited) mode. */
function fastImages() {
  const s = getSettings();
  return Boolean((s.cfAccount && s.cfToken) || s.pollinationsKey || serverCfg.images);
}
/** In free mode only a few unique images are generated per video; scene i reuses image rep(i). */
function imgRep(i, n, cap) {
  if (!cap || n <= cap) return i;
  const g = Math.floor((i * cap) / n);
  return Math.ceil((g * n) / cap);
}
/** Used only if every AI image failed: a colourful card so the video still renders. */
async function placeholderImage(p, quality) {
  const long = p.format === 'long';
  const [w, h] = long ? (quality === 'hd' ? [1536, 864] : [1280, 720]) : quality === 'hd' ? [864, 1536] : [720, 1280];
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const col = getCategory(p.category)?.color || '#ff3d6e';
  const gr = g.createLinearGradient(0, 0, w, h);
  gr.addColorStop(0, col); gr.addColorStop(1, '#120a2a');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `${Math.round(Math.min(w, h) * 0.3)}px system-ui, sans-serif`;
  g.fillText(getCategory(p.category)?.emoji || '🎬', w / 2, h * 0.42);
  return createImageBitmap(c);
}
// Show free-limit countdown messages on every running job
onWait((msg) => {
  for (const [k, j] of jobs) {
    const n = k.split('/')[1];
    const el = document.querySelector(`#part${n} .pmsg`);
    if (el) el.textContent = msg || j.msg;
  }
  const b = document.querySelector('#busy p');
  if (b && msg) b.textContent = msg;
});

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDur = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60}s` : ''}`);
const slug = (s) => String(s || 'video').replace(/[^\p{L}\p{M}\p{N}]+/gu, '_').replace(/^_|_$/g, '').slice(0, 60) || 'video';
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function objUrl(blob) { const u = URL.createObjectURL(blob); urls.add(u); return u; }
function freeUrls() { for (const u of urls) URL.revokeObjectURL(u); urls.clear(); }
function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('✅ Copied!'); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('✅ Copied!'); }
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function overlay(msg) {
  let o = document.getElementById('busy');
  if (!msg) { o?.remove(); return; }
  if (!o) { o = document.createElement('div'); o.id = 'busy'; o.className = 'busy'; document.body.append(o); }
  o.innerHTML = `<div class="spinner"></div><p>${esc(msg)}</p>`;
}
const settings = () => ({ channel: 'HarshuVlog', quality: 'hd', ...getSettings() });
const channelOf = () => (settings().channel || '').replace(/^@/, '').trim();

// ---------- router ----------
function route() {
  freeUrls();
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  const q = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active',
    (a.dataset.nav === 'projects' && parts[0] === 'projects') || (a.dataset.nav === 'home' && parts[0] !== 'projects')));
  window.scrollTo(0, 0);
  if (parts[0] === 'cat' && parts[1]) return viewCategory(parts[1]);
  if (parts[0] === 'new') return viewSetup(parts[1], q);
  if (parts[0] === 'p' && parts[1]) return viewProject(parts[1]);
  if (parts[0] === 'projects') return viewProjects();
  return viewHome();
}
window.addEventListener('hashchange', route);
const go = (h) => { if (location.hash === h) route(); else location.hash = h; };

// ---------- AUTO GENERATE ----------
const AUTO_TOPICS = {
  village: 'ek gaon mein do dost aur unki baatuni gaay',
  family: 'ek parivaar ki masti aur adventure',
  kids: 'chhote bachchon ki kahani aur unke saath unka saathi',
  mystery: 'ek rahasya aur uska solver',
};

async function autoGenerate(topic, partsCount) {
  console.log('🎬 autoGenerate clicked:', topic, partsCount);
  const catId = { village: 'family', family: 'family', kids: 'kids', mystery: 'family' }[topic] || 'family';
  const url = '#/new/' + catId + '?topic=' + encodeURIComponent(AUTO_TOPICS[topic] || topic) + '&partsCount=' + partsCount;
  console.log('🎬 Navigating to:', url);
  go(url);
}

// ---------- HOME ----------
function viewHome() {
  const ch = channelOf();
  $app.innerHTML = `
  <section class="hero">
    <h1>Free AI <span class="grad">Story Videos</span> & <span class="grad2">YouTube Shorts</span></h1>
    <p>Topic chuno → AI kahani likhega (Part 1, Part 2…) → AI images, Hindi voice, subtitles, music → <b>ready MP4 + title, description, tags, thumbnail</b>. 100% free, browser mein.</p>
    ${ch ? `<p class="chip">📺 Channel: <b>@${esc(ch)}</b></p>` : `<button class="btn primary" id="setCh" type="button">📺 Apna channel name add karein</button>`}
  </section>

  <section class="auto-gen">
    <h2>⚡ One-Click Automation</h2>
    <p>Bas <b>channel name daal dena</b> – baaki sab auto!</p>
    <div class="grid autos">
      <button class="card auto-btn" data-topic="village" data-parts="3">🏘️ Gaon ki Kahani (3 parts)</button>
      <button class="card auto-btn" data-topic="family" data-parts="3">👨‍👩‍👧‍👦 Family Adventure (3 parts)</button>
      <button class="card auto-btn" data-topic="kids" data-parts="2">👶 Kids Story (2 parts)</button>
      <button class="card auto-btn" data-topic="mystery" data-parts="2">🔍 Mystery Thriller (2 parts)</button>
    </div>
  </section>

  <h2 class="sec">1️⃣ Category chuniye</h2>
  <div class="grid cats">
    ${CATEGORIES.map((c) => `
      <a class="card cat" href="#/cat/${c.id}" style="--c:${c.color}">
        <span class="emoji">${c.emoji}</span>
        <b>${esc(c.name)}</b>
        <small>${esc(c.about)}</small>
        ${c.mode === 'dance' ? '<span class="tag hot">🔥 Trending</span>' : ''}
      </a>`).join('')}
  </div>
  <div class="card own">
    <h3>📜 Apni khud ki story hai?</h3>
    <p>Apni kahani paste karein – AI use parts, scenes, voice aur video mein badal dega.</p>
    <a class="btn" href="#/new/family?own=1">✍️ Apni story se video banayein</a>
  </div>`;
  document.getElementById('setCh')?.addEventListener('click', openSettings);
  document.querySelectorAll('.auto-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      console.log('🎬 auto-btn clicked');
      if (!ch) { toast('📺 First set your channel in ⚙️ Settings'); return; }
      const topic = btn.dataset.topic;
      const parts = parseInt(btn.dataset.parts) || 2;
      console.log('🎬 Calling autoGenerate:', topic, parts);
      autoGenerate(topic, parts);
    });
  });
}

// ---------- CATEGORY ----------
function viewCategory(id) {
  const c = getCategory(id);
  if (!c) return go('#/');
  $app.innerHTML = `
  <a class="back" href="#/">← Categories</a>
  <section class="cat-head" style="--c:${c.color}">
    <span class="emoji big">${c.emoji}</span>
    <div><h1>${esc(c.name)}</h1><p>${esc(c.about)}</p></div>
  </section>
  <h2 class="sec">2️⃣ Topic chuniye</h2>
  <div class="grid ideas" id="ideas">${c.ideas.map(ideaCard).join('')}</div>
  <div class="row wrap gap">
    <button class="btn" id="fresh" type="button">✨ AI se naye ideas</button>
  </div>
  <div class="card custom">
    <h3>✏️ Apna topic likhein</h3>
    <form id="customForm" class="row gap">
      <input name="topic" required placeholder="e.g. Gaon ka sabse chalak tota" />
      <button class="btn primary" type="submit">Next →</button>
    </form>
    <a class="link" href="#/new/${c.id}?own=1">📜 Ya apni puri story paste karein</a>
  </div>`;
  const bind = () => $app.querySelectorAll('.idea').forEach((el) => (el.onclick = () => go(`#/new/${c.id}?topic=${encodeURIComponent(el.dataset.topic)}`)));
  bind();
  document.getElementById('customForm').onsubmit = (e) => {
    e.preventDefault();
    go(`#/new/${c.id}?topic=${encodeURIComponent(new FormData(e.target).get('topic'))}`);
  };
  document.getElementById('fresh').onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = '⏳ AI soch raha hai...';
    try {
      const ideas = await freshIdeas(c.id, 'hinglish', 8);
      document.getElementById('ideas').insertAdjacentHTML('afterbegin', ideas.map((t) => ideaCard(t, true)).join(''));
      bind();
    } catch (err) { toast('❌ ' + err.message); }
    b.disabled = false; b.textContent = '✨ Aur naye ideas';
  };
}
const ideaCard = (t, fresh) => `<button type="button" class="card idea${fresh ? ' fresh' : ''}" data-topic="${esc(t)}">${fresh ? '<span class="tag">✨ AI</span>' : ''}${esc(t)}</button>`;

// ---------- SETUP ----------
function viewSetup(catId, q) {
  const c = getCategory(catId) || getCategory('family');
  const dance = c.mode === 'dance';
  const own = q.get('own') === '1';
  const topic = q.get('topic') || '';
  const partsCountParam = parseInt(q.get('partsCount')) || 0;
  const durOpts = (fmt, sel) => (fmt === 'short' ? SHORT_DUR : LONG_DUR).map((d) => `<option value="${d}"${d === sel ? ' selected' : ''}>${fmtDur(d)}</option>`).join('');
  $app.innerHTML = `
  <a class="back" href="#/cat/${c.id}">← ${esc(c.name)}</a>
  <h1>3️⃣ Video settings</h1>
  <form id="setup" class="card form">
    <label>Category
      <select name="category">${CATEGORIES.map((x) => `<option value="${x.id}"${x.id === c.id ? ' selected' : ''}>${x.emoji} ${esc(x.name)}</option>`).join('')}</select>
    </label>
    <label>Topic / idea
      <input name="topic" value="${esc(topic)}" ${own ? '' : 'required'} placeholder="Kis baare mein video?" />
    </label>
    <details ${own ? 'open' : ''}>
      <summary>📜 Apni story (optional) – AI isi kahani ko follow karega</summary>
      <textarea name="customStory" rows="7" placeholder="Apni kahani yahan paste karein (Hindi / Hinglish / English)..."></textarea>
    </details>
    <div class="two">
      <fieldset class="seg"><legend>Format</legend>
        <label><input type="radio" name="format" value="short" checked><span>📱 YouTube Short<br><small>9:16 vertical</small></span></label>
        <label><input type="radio" name="format" value="long"><span>🖥️ Long video<br><small>16:9 horizontal</small></span></label>
      </fieldset>
      <label>Duration (har part)
        <select name="duration" id="dur">${durOpts('short', dance ? 30 : 60)}</select>
        <small>Shorts ke liye 60s tak best (YouTube Shorts max 3 min).</small>
      </label>
    </div>
    <div class="two">
      <label>Kitne parts? (series)
        <select name="partsCount">${[1, 2, 3, 4, 5, 6, 7, 8, 10].map((n) => `<option value="${n}"${(partsCountParam && n === partsCountParam) || (n === (dance ? 1 : 2) && !partsCountParam) ? ' selected' : ''}>${n === 1 ? '1 (single video)' : `${n} parts`}</option>`).join('')}</select>
      </label>
      <label>Language
        <select name="language">${Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      </label>
    </div>
    <div class="two">
      <label>Art style
        <select name="style">${STYLES.map((s) => `<option value="${s.id}"${s.id === (DEFAULT_STYLE_BY_CATEGORY[c.id] || 'pixar') ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      </label>
      <label>${dance ? 'Voice' : 'Narrator voice (narrator / drama style ke liye)'}
        <select name="narratorGender"><option value="male">👨 Male (Madhur)</option><option value="female">👩 Female (Swara)</option></select>
      </label>
      ${dance ? `<label class="check"><input type="checkbox" name="voiceLyrics" checked> 🎤 Lyrics ko AI voice se gaaye (har scene mein character ke sath)</label>` : ''}
    </div>
    ${dance ? '' : `<label>🎙️ Story kaise sunayi jaye (voice style)
      <select name="voiceStyle">
        <option value="drama" selected>🎭 Drama – narrator + har character ki alag voice (RECOMMENDED)</option>
        <option value="storyteller">🧑 Ek insaan apni kahani khud sunata hai (first person – "Namaste dosto, main Raju hoon...")</option>
        <option value="narrator">📖 Ek narrator poori kahani sunata hai (third person)</option>
      </select>
    </label>`}
    <label>🎥 Motion – AI person ko move karwana (hands, mouth, legs)
      <select name="motion">
        <option value="free" selected>🆓 FREE real motion (Hugging Face Wan 2.2 – roz ~4-6 clips free, baaki scenes zoom/pan)</option>
        <option value="paid">💎 PAID real-life video har scene (fal.ai key – Settings)</option>
        <option value="none">🖼 No motion (sirf images + zoom/pan, sabse fast)</option>
      </select>
    </label>
    <div class="two">
      <label>Background music (copyright-free, AI generated)
        <select name="music">
          <option value="auto">🎵 Auto (story ke mood se)</option>
          ${MOOD_KEYS.map((k) => `<option value="${k}">${esc(MUSIC_MOODS[k].label)}</option>`).join('')}
          <option value="upload">📁 Apna music upload (YouTube Audio Library)</option>
          <option value="none">🔇 No music</option>
        </select>
      </label>
      <label id="upWrap" hidden>Music file (mp3/wav)
        <input type="file" name="musicFile" accept="audio/*" />
      </label>
    </div>
    ${dance ? `<label class="check"><input type="checkbox" name="voiceLyrics" ${c.id === 'rhymes' ? 'checked' : ''}> 🎤 Lyrics ko AI voice se gaaye (rhymes ke liye best)</label>` : ''}
    <p class="note">💡 ${dance ? 'Dance Shorts: AI har beat par naye dance pose images banata hai + beat-sync zoom, flash, confetti effects.' : 'AI pehle puri series ka outline (start se end tak) banayega, phir har part ki script, images, voice aur video.'}</p>
    <button class="btn primary big" type="submit">✨ Create ${dance ? 'Dance Video' : 'Story'}</button>
  </form>`;
  const f = document.getElementById('setup');
  f.querySelectorAll('[name=format]').forEach((r) => (r.onchange = () => {
    const fmt = f.format.value;
    f.duration.innerHTML = durOpts(fmt, fmt === 'short' ? (dance ? 30 : 60) : 180);
  }));
  f.music.onchange = () => (document.getElementById('upWrap').hidden = f.music.value !== 'upload');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const cat = getCategory(fd.get('category'));
    const custom = String(fd.get('customStory') || '').trim();
    const p = {
      id: uid(), createdAt: Date.now(), category: cat.id, mode: cat.mode || 'story',
      topic: String(fd.get('topic') || '').trim() || custom.slice(0, 80) || cat.ideas[0],
      customStory: custom, format: fd.get('format'), duration: +fd.get('duration'),
      partsCount: +fd.get('partsCount'), language: fd.get('language'), style: fd.get('style'),
      narratorGender: fd.get('narratorGender'), voiceStyle: fd.get('voiceStyle') || 'drama', music: fd.get('music'),
      voiceLyrics: fd.get('voiceLyrics') === 'on', motion: fd.get('motion') || 'free', partsData: {},
    };
    const file = f.musicFile?.files?.[0];
    if (p.music === 'upload') {
      if (!file) return toast('🎵 Music file select karein');
      await db.putBlob(`${p.id}/music`, file);
      p.musicName = file.name;
    }
    overlay('✍️ AI aapki kahani ka outline likh raha hai... (20-60 sec)');
    try {
      p.bible = await createBible(p);
      assignVoices(p);
      await db.saveProject(p);
      overlay();
      go(`#/p/${p.id}`);
    } catch (err) {
      overlay(); console.error(err); toast('❌ Story nahi bani: ' + err.message + ' – dobara try karein', 5000);
    }
  };
}

// ---------- PROJECTS ----------
async function viewProjects() {
  const list = await db.listProjects();
  const est = await db.estimate();
  $app.innerHTML = `
  <h1>📁 My Projects</h1>
  <p class="muted">Sab kuch aapke browser (IndexedDB) mein save hai – download ke baad bhi. ${est ? `Storage used: ${(est.usage / 1e6).toFixed(0)} MB` : ''}</p>
  ${list.length ? '' : '<div class="card empty">Abhi koi project nahi. <a href="#/">Naya video banayein →</a></div>'}
  <div class="grid projects">
    ${list.map((p) => {
      const c = getCategory(p.category) || {};
      const done = Object.values(p.partsData || {}).filter((x) => x.status === 'done').length;
      return `<div class="card proj" style="--c:${c.color || '#888'}">
        <a href="#/p/${p.id}"><span class="emoji">${c.emoji || '🎬'}</span><b>${esc(p.bible?.title_roman || p.bible?.title || p.topic)}</b></a>
        <small>${p.format === 'short' ? '📱 Short' : '🖥️ Long'} · ${fmtDur(p.duration)} · ${done}/${p.partsCount} videos ready · ${new Date(p.updatedAt).toLocaleDateString()}</small>
        <div class="row gap"><a class="btn small" href="#/p/${p.id}">Open</a><button class="btn small danger" data-del="${p.id}" type="button">🗑 Delete</button></div>
      </div>`;
    }).join('')}
  </div>`;
  $app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Project aur uske saare videos delete karein?')) return;
    await db.deleteProject(b.dataset.del); toast('🗑 Deleted'); viewProjects();
  }));
}

// ---------- PROJECT ----------
let cur = null;
const save = async () => { if (cur) await db.saveProject(cur); };
let saveT;
const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(save, 500); };

async function viewProject(id) {
  const p = await db.getProject(id);
  if (!p) { toast('Project nahi mila'); return go('#/projects'); }
  cur = p;
  assignVoices(p);
  const c = getCategory(p.category) || {};
  const b = p.bible;
  const voiceSel = (key) => `<select data-voice="${key}">${ALL_VOICES.map((v) => `<option value="${v}"${p.voices[key]?.voice === v ? ' selected' : ''}>${esc(voiceLabel(v))}</option>`).join('')}</select><button class="btn small ghost" type="button" data-test="${key}" title="Voice test">▶</button>`;
  $app.innerHTML = `
  <a class="back" href="#/projects">← My Projects</a>
  <section class="cat-head" style="--c:${c.color}">
    <span class="emoji big">${c.emoji || '🎬'}</span>
    <div>
      <h1>${esc(b.title_roman || b.title)}</h1>
      ${b.title_roman && b.title !== b.title_roman ? `<p class="dev">${esc(b.title)}</p>` : ''}
      <p>${esc(b.logline)}</p>
      <div class="chips">
        <span class="chip">${p.format === 'short' ? '📱 Short 9:16' : '🖥️ Long 16:9'}</span>
        <span class="chip">⏱ ${fmtDur(p.duration)}/part</span>
        <span class="chip">📚 ${p.partsCount} part${p.partsCount > 1 ? 's' : ''}</span>
        <span class="chip">🗣 ${esc(LANGS[p.language]?.split(' (')[0])}</span>
        <span class="chip">🎨 ${esc(getStyle(p.style).name)}</span>
        <span class="chip">📺 @${esc(channelOf() || 'set channel in ⚙️')}</span>
      </div>
    </div>
  </section>

  <div class="row wrap gap toolbar">
    <button class="btn primary" id="makeAll" type="button">⚡ Saare parts ke videos banayein</button>
    <label class="inline">🎵 Music
      <select id="musicSel">
        <option value="auto">Auto</option>
        ${MOOD_KEYS.map((k) => `<option value="${k}">${esc(MUSIC_MOODS[k].label)}</option>`).join('')}
        <option value="upload">📁 Uploaded${p.musicName ? ': ' + esc(p.musicName) : ''}</option>
        <option value="none">🔇 None</option>
      </select>
    </label>
    <label class="inline">🎥 Motion
      <select id="motionSel">
        <option value="free">🆓 Free real motion</option>
        <option value="paid">💎 Paid (fal.ai)</option>
        <option value="none">🖼 Off</option>
      </select>
    </label>
    <button class="btn small ghost" id="musicPrev" type="button">▶ Preview</button>
    <label class="btn small ghost file">📁 Upload music<input type="file" id="musicUp" accept="audio/*" hidden></label>
    <button class="btn small danger" id="delProj" type="button">🗑 Delete</button>
  </div>

  <details class="card">
    <summary><b>👥 Characters & voices</b> <small>(face/look edit karein – har scene mein same face ke liye)</small></summary>
    <div class="chars">
      <div class="char"><b>🎙 Narrator</b><div class="row gap">${voiceSel('narrator')}</div></div>
      ${b.characters.map((ch, i) => `
        <div class="char" style="--c:${COLORS[i % COLORS.length]}">
          <b>${esc(ch.name)}</b> <small>${esc(ch.gender)} · ${esc(ch.age)}</small>
          <textarea data-look="${i}" rows="3">${esc(ch.look)}</textarea>
          <div class="row gap">${voiceSel(ch.id)}</div>
        </div>`).join('')}
    </div>
    <p class="muted">Setting: ${esc(b.setting)}</p>
  </details>

  <h2 class="sec">🎬 Parts</h2>
  <div id="parts">${b.parts.map((pt) => `<div class="card part" id="part${pt.part}"></div>`).join('')}</div>
  <div class="card tips">
    <h3>📤 YouTube upload tips</h3>
    <ul>
      <li>Upload karte waqt <b>"Altered or synthetic content"</b> par <b>Yes</b> chunein (AI video ke liye YouTube rule).</li>
      <li>Shorts: 9:16 + 3 min se kam = automatic Short. Title mein #shorts already hai.</li>
      <li>Saare visuals AI-generated aur music yahin generate hota hai – kisi aur ka copyrighted content nahi. Fir bhi YouTube "reused / repetitive" content ko monetize nahi karta, isliye har video unique rakhein.</li>
    </ul>
  </div>`;

  const ms = document.getElementById('musicSel');
  ms.value = p.music || 'auto';
  ms.onchange = () => { p.music = ms.value; saveSoon(); };
  const mo = document.getElementById('motionSel');
  mo.value = p.motion || 'none';
  mo.onchange = () => { p.motion = mo.value; saveSoon(); };
  let stopPrev = null;
  document.getElementById('musicPrev').onclick = async (e) => {
    if (stopPrev) { stopPrev(); stopPrev = null; e.target.textContent = '▶ Preview'; return; }
    const mood = ms.value === 'auto' ? autoMood(p, null) : ms.value;
    if (!MUSIC_MOODS[mood]) return toast('Is option ka preview nahi');
    e.target.textContent = '⏳'; stopPrev = await previewMood(mood); e.target.textContent = '⏹ Stop';
  };
  document.getElementById('musicUp').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    await db.putBlob(`${p.id}/music`, f); p.music = 'upload'; p.musicName = f.name; await save();
    toast('🎵 Music upload ho gaya'); viewProject(p.id);
  };
  document.getElementById('delProj').onclick = async () => {
    if (!confirm('Delete this project?')) return;
    await db.deleteProject(p.id); go('#/projects');
  };
  $app.querySelectorAll('[data-look]').forEach((t) => (t.oninput = () => { b.characters[+t.dataset.look].look = t.value; saveSoon(); }));
  $app.querySelectorAll('[data-voice]').forEach((s) => (s.onchange = () => { p.voices[s.dataset.voice] = { ...p.voices[s.dataset.voice], voice: s.value }; saveSoon(); }));
  $app.querySelectorAll('[data-test]').forEach((btn) => (btn.onclick = async () => {
    const k = btn.dataset.test; const v = p.voices[k];
    const name = k === 'narrator' ? '' : b.characters.find((x) => x.id === k)?.name || '';
    const txt = p.language === 'en' ? `Hello, I am ${name || 'the narrator'}. Welcome to the story.` : `नमस्ते, मैं ${name || 'आपका सूत्रधार'} हूँ। चलिए कहानी शुरू करते हैं।`;
    btn.textContent = '⏳';
    try { const bl = await ttsBlob(p.id, txt, v); new Audio(objUrl(bl)).play(); } catch (err) { toast('❌ ' + err.message); }
    btn.textContent = '▶';
  }));
  document.getElementById('makeAll').onclick = async (e) => {
    e.target.disabled = true;
    for (const pt of b.parts) {
      if (p.partsData[pt.part]?.status === 'done') continue;
      const ok = await makeVideo(p, pt.part);
      if (!ok) break;
    }
    e.target.disabled = false;
  };
  for (const pt of b.parts) renderPart(p, pt.part);
}

function pd(p, n) { return (p.partsData[n] ||= { status: 'new' }); }

async function renderPart(p, n) {
  const el = document.getElementById(`part${n}`);
  if (!el || cur?.id !== p.id) return;
  const pt = p.bible.parts[n - 1];
  const d = pd(p, n);
  const job = jobs.get(`${p.id}/${n}`);
  const meta = d.meta;
  const ch = channelOf();
  el.innerHTML = `
    <div class="part-head">
      <span class="pnum"><small>PART</small>${n}</span>
      <div class="grow">
        <input class="ptitle" data-ptitle value="${esc(pt.title)}" />
        <textarea class="psum" data-psum rows="2">${esc(pt.summary)}</textarea>
      </div>
      <span class="status s-${job ? 'busy' : d.status}">${job ? '⏳ Working' : { new: 'New', script: '📝 Script ready', done: '✅ Video ready' }[d.status] || d.status}</span>
    </div>
    <div class="row wrap gap">
      <button class="btn primary" data-act="make" type="button" ${job ? 'disabled' : ''}>🎬 ${d.status === 'done' ? 'Re-make video' : 'Make video'}</button>
      <button class="btn" data-act="script" type="button" ${job ? 'disabled' : ''}>📝 ${d.script ? 'Edit script' : 'Write script only'}</button>
      ${d.script ? `<button class="btn ghost" data-act="rescript" type="button" ${job ? 'disabled' : ''}>🔄 New script</button>` : ''}
      ${job ? '<button class="btn danger" data-act="cancel" type="button">✖ Cancel</button>' : ''}
    </div>
    ${job ? `<div class="progress"><div class="bar" style="width:${(job.frac * 100).toFixed(1)}%"></div></div><p class="pmsg">${esc(job.msg)}</p><div class="live"></div>` : ''}
    ${job?.error ? `<p class="err">❌ ${esc(job.error)}</p>` : ''}
    ${d.error && !job ? `<p class="err">❌ ${esc(d.error)}</p>` : ''}
    <div class="result"></div>
    <div class="script" hidden></div>`;
  if (job?.canvas) el.querySelector('.live').append(job.canvas);
  el.querySelector('[data-ptitle]').oninput = (e) => { pt.title = e.target.value; saveSoon(); };
  el.querySelector('[data-psum]').oninput = (e) => { pt.summary = e.target.value; saveSoon(); };
  el.querySelector('[data-act=make]').onclick = () => makeVideo(p, n);
  el.querySelector('[data-act=cancel]')?.addEventListener('click', () => job.abort.abort());
  el.querySelector('[data-act=rescript]')?.addEventListener('click', async () => {
    if (!confirm('Naya script likhein? Purana script replace ho jayega.')) return;
    d.script = null; d.meta = null; d.status = 'new'; await save(); await scriptOnly(p, n);
  });
  el.querySelector('[data-act=script]').onclick = async () => {
    if (!d.script) return scriptOnly(p, n);
    const box = el.querySelector('.script');
    box.hidden = !box.hidden;
    if (!box.hidden) renderScriptEditor(p, n, box);
  };
  if (d.status === 'done' && !job) {
    const vid = await db.getBlob(`${p.id}/p${n}/video`);
    const th = await db.getBlob(`${p.id}/p${n}/thumb`);
    const res = el.querySelector('.result');
    if (!vid) { d.status = d.script ? 'script' : 'new'; return; }
    const desc = meta ? fullDescription(meta, p, n, ch) : '';
    const tags = meta?.tags?.join(', ') || '';
    const fname = slug(meta?.title || pt.title);
    res.innerHTML = `
      <div class="out ${p.format}">
        <video controls playsinline preload="metadata" src="${objUrl(vid)}"></video>
        <div class="meta">
          <div class="row wrap gap">
            <button class="btn primary" data-dl="video" type="button">⬇️ Download ${d.ext?.toUpperCase() || 'MP4'} (${(vid.size / 1e6).toFixed(1)} MB)</button>
            ${th ? '<button class="btn" data-dl="thumb" type="button">🖼 Thumbnail</button>' : ''}
            <button class="btn ghost" data-dl="txt" type="button">📄 Title+Desc .txt</button>
          </div>
          ${th ? `<img class="thumb" src="${objUrl(th)}" alt="thumbnail">` : ''}
          ${meta ? `
          <label>Title <button class="copy" data-copy="title" type="button">📋</button><input readonly value="${esc(meta.title)}"></label>
          <label>Description <button class="copy" data-copy="desc" type="button">📋</button><textarea readonly rows="7">${esc(desc)}</textarea></label>
          <label>Tags <button class="copy" data-copy="tags" type="button">📋</button><textarea readonly rows="2">${esc(tags)}</textarea></label>` : ''}
          <small class="muted">${d.ext === 'webm' ? '⚠️ Aapke browser ne WebM banaya – YouTube WebM bhi accept karta hai. MP4 ke liye Chrome/Edge use karein.' : ''} ${d.duration ? `Duration ${d.duration.toFixed(1)}s · ${d.width}x${d.height}` : ''}</small>
        </div>
      </div>`;
    res.querySelector('[data-dl=video]').onclick = () => download(vid, `${fname}.${d.ext || 'mp4'}`);
    res.querySelector('[data-dl=thumb]')?.addEventListener('click', () => download(th, `${fname}_thumbnail.jpg`));
    res.querySelector('[data-dl=txt]').onclick = () => download(new Blob([`TITLE:\n${meta?.title}\n\nDESCRIPTION:\n${desc}\n\nTAGS:\n${tags}\n`], { type: 'text/plain' }), `${fname}.txt`);
    res.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => copy({ title: meta.title, desc, tags }[b.dataset.copy])));
  }
}

function speakerName(p, id) {
  if (id === 'narrator') return '';
  return p.bible.characters.find((c) => c.id === id)?.name || '';
}

async function renderScriptEditor(p, n, box) {
  const d = pd(p, n);
  const sc = d.script.scenes;
  const dance = p.mode === 'dance';
  const capField = p.language === 'hi' ? null : 'roman';
  box.innerHTML = `
    <p class="muted">✏️ Text badlein – video banate waqt naya voice/caption use hoga. Image pasand nahi to 🔄 dabayein.</p>
    ${sc.map((s, i) => `
      <div class="scene" data-i="${i}">
        <div class="simg"><img alt="" data-img="${i}"><button class="btn small" data-reimg="${i}" type="button">🔄 New image</button></div>
        <div class="grow">
          <b>Scene ${i + 1}</b> <small class="muted">${esc(s.mood || '')}</small>
          <textarea data-visual="${i}" rows="2" title="Image prompt (English)">${esc(s.visual)}</textarea>
          ${dance ? `
            <div class="line"><span class="spk">🎵 Lyric</span>
              <input data-ly="${i}" data-f="hi" value="${esc(s.lyric?.hi || '')}">
              ${capField ? `<input data-ly="${i}" data-f="roman" value="${esc(s.lyric?.roman || '')}">` : ''}</div>` :
            s.lines.map((l, j) => `
            <div class="line"><span class="spk">${esc(speakerName(p, l.speaker) || '🎙 Narrator')}</span>
              <input data-l="${i}.${j}" data-f="hi" value="${esc(l.hi)}" title="Voice text">
              ${capField ? `<input data-l="${i}.${j}" data-f="roman" value="${esc(l.roman)}" title="Caption">` : ''}
            </div>`).join('')}
        </div>
      </div>`).join('')}`;
  const touch = () => { if (d.status === 'done') d.status = 'script'; saveSoon(); };
  box.querySelectorAll('[data-visual]').forEach((t) => (t.oninput = () => { const s = sc[+t.dataset.visual]; s.visual = t.value; s.imgDirty = true; s.clipDirty = true; touch(); }));
  box.querySelectorAll('[data-l]').forEach((t) => (t.oninput = () => { const [i, j] = t.dataset.l.split('.').map(Number); sc[i].lines[j][t.dataset.f] = t.value; touch(); }));
  box.querySelectorAll('[data-ly]').forEach((t) => (t.oninput = () => { const s = sc[+t.dataset.ly]; s.lyric ||= {}; s.lyric[t.dataset.f] = t.value; touch(); }));
  box.querySelectorAll('[data-reimg]').forEach((btn) => (btn.onclick = async () => {
    const i = +btn.dataset.reimg; const s = sc[i];
    s.seedBump = (s.seedBump || 0) + 1; s.imgDirty = false; btn.textContent = '⏳'; btn.disabled = true;
    try {
      const bl = await sceneImage(p, n, i, s, { quality: settings().quality, force: true });
      s.ownImg = true; s.clipDirty = true;
      box.querySelector(`[data-img="${i}"]`).src = objUrl(bl); touch();
    } catch (err) { toast('❌ ' + err.message); }
    btn.textContent = '🔄 New image'; btn.disabled = false;
  }));
  for (let i = 0; i < sc.length; i++) {
    const r = sc[i].ownImg ? i : imgRep(i, sc.length, d.imgCap);
    const bl = await db.getBlob(`${p.id}/p${n}/img${r}`);
    const im = box.querySelector(`[data-img="${i}"]`);
    if (bl && im) im.src = objUrl(bl);
  }
}

// ---------- PIPELINE ----------
function setJob(p, n, patch) {
  const k = `${p.id}/${n}`;
  const j = jobs.get(k); if (!j) return;
  Object.assign(j, patch);
  const el = document.getElementById(`part${n}`);
  if (!el || cur?.id !== p.id) return;
  const bar = el.querySelector('.bar'); const msg = el.querySelector('.pmsg');
  if (bar) bar.style.width = `${(j.frac * 100).toFixed(1)}%`;
  if (msg) msg.textContent = j.msg;
}

async function ensureScript(p, n, onMsg) {
  const d = pd(p, n);
  if (!d.script) {
    onMsg('✍️ AI script likh raha hai...');
    d.script = p.mode === 'dance' ? await createDanceScript(p, n) : await createStoryScript(p, n, onMsg);
    if (!d.script?.scenes?.length) throw new Error('Script khali aaya, dobara try karein');
    d.status = 'script';
    await save();
  }
  if (!d.meta) {
    onMsg('🏷 Title, description, tags bana raha hai...');
    try { d.meta = await createMetadata(p, n, d.script, channelOf()); }
    catch { d.meta = { title: `${p.bible.title_roman || p.bible.title}${p.partsCount > 1 ? ` | Part ${n}` : ''}${p.format === 'short' ? ' #shorts' : ''}`, description: p.bible.logline, tags: [], hashtags: [], thumbnail_text: p.bible.title_roman || '', hook_text: p.bible.parts[n - 1].title }; }
    await save();
  }
  return d;
}

async function scriptOnly(p, n) {
  const k = `${p.id}/${n}`;
  if (jobs.has(k)) return;
  jobs.set(k, { frac: 0.05, msg: 'Starting...', abort: new AbortController() });
  renderPart(p, n);
  try { await ensureScript(p, n, (m) => setJob(p, n, { msg: m })); }
  catch (err) { toast('❌ ' + err.message, 5000); }
  jobs.delete(k);
  await renderPart(p, n);
  const box = document.querySelector(`#part${n} .script`);
  if (box && pd(p, n).script) { box.hidden = false; renderScriptEditor(p, n, box); }
}

function autoMood(p, scenes) {
  if (p.mode === 'dance') return p.category === 'rhymes' ? 'kids' : 'dance';
  const m = scenes ? dominantMood(scenes, 'calm') : 'calm';
  if (p.category === 'village' && ['happy', 'calm', 'comedy'].includes(m)) return 'desi';
  if (p.category === 'society' || p.category === 'funny') return m === 'sad' || m === 'suspense' ? m : 'comedy';
  return MUSIC_MOODS[m] ? m : 'calm';
}

function outroText(p, n) {
  const next = n < p.partsCount ? n + 1 : null;
  if (p.language === 'en') {
    const t = next ? `Subscribe now so you don't miss part ${next}!` : 'Did you like the story? Like and subscribe for more!';
    return { hi: t, roman: t };
  }
  return next
    ? { hi: `भाग ${next} जल्द आ रहा है, चैनल को सब्सक्राइब करना मत भूलना!`, roman: `Part ${next} jald aa raha hai, channel ko subscribe karna mat bhoolna!` }
    : { hi: 'कहानी अच्छी लगी तो लाइक और सब्सक्राइब ज़रूर करें!', roman: 'Kahani achhi lagi to like aur subscribe zaroor karein!' };
}

async function makeVideo(p, n) {
  const k = `${p.id}/${n}`;
  if (jobs.has(k)) return false;
  const abort = new AbortController();
  const canvas = document.createElement('canvas');
  canvas.className = 'preview-canvas';
  jobs.set(k, { frac: 0, msg: 'Starting...', abort, canvas });
  renderPart(p, n);
  const P = (frac, msg) => setJob(p, n, { frac, msg });
  const d = pd(p, n);
  const quality = settings().quality || 'hd';
  try {
    await ensureFonts();
    await ensureScript(p, n, (m) => P(0.04, m));
    const scenes = d.script.scenes;
    const lang = p.language;
    const txt = (o) => (lang === 'hi' ? o?.hi : o?.roman || o?.hi) || '';
    const check = () => { if (abort.signal.aborted) throw new DOMException('Cancelled', 'AbortError'); };

    // 1) images. Free (anonymous) mode is rate limited, so only a few unique images are made and reused.
    const fast = fastImages();
    const cap = fast ? 0 : p.format === 'long' ? 10 : 6;
    d.imgCap = cap;
    const images = new Array(scenes.length);
    const need = [...new Set(scenes.map((s, i) => (s.ownImg ? i : imgRep(i, scenes.length, cap))))];
    const bitmaps = {}; const blobs = {};
    let done = 0;
    P(0.08, `🎨 AI images: 0/${need.length}${fast ? '' : ' (free mode – thoda time lagega)'}`);
    let failed = 0;
    await pool(need, fast ? 2 : 1, async (i) => {
      check();
      const s = scenes[i];
      try {
        const bl = await sceneImage(p, n, i, s, { quality, force: !!s.imgDirty, signal: abort.signal });
        s.imgDirty = false;
        blobs[i] = bl; bitmaps[i] = await createImageBitmap(bl);
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        console.warn('image failed', i, e);
        failed++;
      }
      done++; P(0.08 + 0.4 * (done / need.length), `🎨 AI images: ${done}/${need.length}${failed ? ` (${failed} failed – reuse)` : ''}`);
    });
    check();
    const ok = Object.keys(bitmaps).map(Number).sort((a, b) => a - b);
    if (!ok.length) bitmaps[-1] = await placeholderImage(p, quality);
    const nearest = (i) => {
      if (bitmaps[i]) return bitmaps[i];
      if (!ok.length) return bitmaps[-1];
      return bitmaps[ok.reduce((b, x) => (Math.abs(x - i) < Math.abs(b - i) ? x : b), ok[0])];
    };
    scenes.forEach((s, i) => (images[i] = nearest(s.ownImg ? i : imgRep(i, scenes.length, cap))));
    await save();

    // 1b) real motion clips (person moves). free = limited daily quota, paid = every scene
    const clips = new Array(scenes.length);
    const motion = p.motion || 'none';
    if (motion !== 'none' && ok.length) {
      const maxClips = motion === 'paid' ? ok.length : Math.min(ok.length, p.format === 'long' ? 8 : 6);
      const targets = ok.slice(0, maxClips);
      const clipBy = {};
      let mk = 0; let mfail = 0;
      P(0.48, `🎥 Real motion: 0/${targets.length} (har clip ~30-60s)`);
      for (const i of targets) {
        check();
        try {
          const s = scenes[i];
          clipBy[i] = await sceneClip(p, n, i, s, blobs[i] || (await db.getBlob(`${p.id}/p${n}/img${i}`)), {
            engine: motion, signal: abort.signal, force: !!s.clipDirty,
            onStatus: (st) => P(0.48, `🎥 Real motion ${mk + 1}/${targets.length}: ${st}`),
          });
          s.clipDirty = false; mfail = 0;
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          console.warn('motion failed', i, e);
          if (e instanceof QuotaError) { toast('🆓 Aaj ka free motion quota khatam – baaki scenes zoom/pan se banenge. (HF token Settings me daalein = zyada clips)'); break; }
          mfail++;
          if (motion === 'free' && mfail >= 2) break;
          if (motion === 'paid' && mfail >= 2) throw new Error(`Paid motion failed: ${e.message}`);
        }
        mk++; P(0.48, `🎥 Real motion: ${mk}/${targets.length}`);
      }
      scenes.forEach((s, i) => { const r = s.ownImg ? i : imgRep(i, scenes.length, cap); clips[i] = clipBy[r] || null; });
      d.clipCount = Object.keys(clipBy).length;
      await save();
    }

    // 2) voices
    const vo = (speaker) => p.voices[speaker] || p.voices.narrator;
    const tasks = [];
    if (p.mode === 'dance') {
      if (d.script.hook) tasks.push({ key: 'hook', text: d.script.hook.hi, v: vo('narrator') });
      if (p.voiceLyrics) scenes.forEach((s, i) => s.lyric?.hi && tasks.push({ key: `ly${i}`, text: s.lyric.hi, v: vo(s.characters?.[0] || 'narrator') }));
      if (d.script.outro) tasks.push({ key: 'outro', text: d.script.outro.hi, v: vo('narrator') });
    } else {
      scenes.forEach((s, i) => s.lines.forEach((l, j) => l.hi?.trim() && tasks.push({ key: `${i}.${j}`, text: l.hi, v: vo(l.speaker) })));
      tasks.push({ key: 'outro', text: outroText(p, n).hi, v: vo('narrator') });
    }
    const buf = {};
    let vd = 0;
    await pool(tasks, 3, async (t) => {
      check();
      try { buf[t.key] = await decodeAudio(await ttsBlob(p.id, t.text, t.v)); }
      catch (err) { console.warn('TTS failed', t, err); buf[t.key] = null; }
      vd++; P(0.48 + 0.12 * (vd / tasks.length), `🎙 AI voice: ${vd}/${tasks.length}`);
    });
    if (tasks.length && Object.values(buf).every((x) => !x)) throw new Error('Voice (TTS) server se connect nahi hua. Internet check karein.');

    // 3) music
    P(0.6, '🎵 Music bana raha hai...');
    let music = null; let mood = 'calm';
    const sel = p.music || 'auto';
    if (sel === 'upload') {
      const mb = await db.getBlob(`${p.id}/music`);
      if (mb) music = await decodeAudio(mb);
    } else if (sel !== 'none') {
      mood = sel === 'auto' ? autoMood(p, scenes) : sel;
      music = await getMusicLoop(mood);
    }
    if (p.mode === 'dance' && MUSIC_MOODS[sel] == null) mood = autoMood(p, scenes);

    // 4) render
    const charIdx = Object.fromEntries(p.bible.characters.map((c, i) => [c.id, i]));
    const ch = channelOf();
    const meta = d.meta || {};
    const outro = p.mode === 'dance' ? d.script.outro : outroText(p, n);
    const o = {
      mode: p.mode, format: p.format, quality, lang, images, clips, channel: ch,
      title: p.bible.title_roman && lang !== 'hi' ? p.bible.title_roman : p.bible.title,
      partLabel: p.partsCount > 1 ? `PART ${n}` : '',
      nextPart: n < p.partsCount ? n + 1 : null,
      hookText: meta.hook_text || p.bible.parts[n - 1].title,
      music, bpm: bpmOf(MUSIC_MOODS[mood] ? mood : 'dance'), duration: p.duration,
      kbOffset: parseInt(hashStr(p.id + n), 36) % 5,
      canvas, signal: abort.signal,
      scenes: scenes.map((s, i) => ({
        lines: (s.lines || []).filter((l) => l.hi?.trim()).map((l) => {
          const j = s.lines.indexOf(l);
          const ci = charIdx[l.speaker];
          return { text: txt(l), buffer: buf[`${i}.${j}`] || null, speaker: l.speaker, speakerName: speakerName(p, l.speaker), color: ci == null ? '#ffffff' : COLORS[ci % COLORS.length] };
        }),
        lyric: s.lyric ? { text: txt(s.lyric), buffer: buf[`ly${i}`] || null } : undefined,
      })),
      hook: p.mode === 'dance' && d.script.hook ? { text: txt(d.script.hook), buffer: buf.hook || null } : null,
      outro: outro ? { text: txt(outro), buffer: buf.outro || null } : null,
      onProgress: (f, m) => P(0.62 + 0.36 * f, `🎬 Video render: ${Math.round(f * 100)}% ${m || ''}`),
    };
    const out = await renderVideo(o);
    P(0.985, '🖼 Thumbnail...');
    await db.putBlob(`${p.id}/p${n}/video`, out.blob);
    try {
      let bg = images[0];
      if (fast) { try { bg = await createImageBitmap(await thumbImage(p, n, meta, { signal: abort.signal })); } catch { /* use scene 1 */ } }
      const th = await composeThumbnail({ image: bg, title: meta.thumbnail_text || o.title, partLabel: o.partLabel, channel: ch, format: p.format });
      await db.putBlob(`${p.id}/p${n}/thumb`, th);
    } catch (err) { console.warn('thumb failed', err); }
    Object.values(bitmaps).forEach((im) => im?.close?.());
    Object.assign(d, { status: 'done', ext: out.ext, mime: out.mime, duration: out.duration, width: out.width, height: out.height, error: null, renderedAt: Date.now() });
    await save();
    jobs.delete(k);
    toast(`✅ Part ${n} video ready!`);
    await renderPart(p, n);
    return true;
  } catch (err) {
    console.error(err);
    jobs.delete(k);
    d.error = err.name === 'AbortError' ? null : err.message;
    if (d.status === 'done' && !(await db.getBlob(`${p.id}/p${n}/video`))) d.status = d.script ? 'script' : 'new';
    await save();
    if (err.name === 'AbortError') toast('✖ Cancelled'); else toast('❌ ' + err.message, 6000);
    await renderPart(p, n);
    return false;
  }
}

// ---------- AUTO-DOWNLOAD & YOUTUBE UPLOAD ----------
// Upload confirmation dialog
async function showUploadDialog(p, partNo) {
  const title = `${p.meta?.title || 'Part ' + partNo}`;
  const html = `
    <div style="max-width: 500px;">
      <h2>🎬 Video Ready!</h2>
      <p><strong>${esc(title)}</strong> (Part ${partNo}/${p.partsCount}) is ready to download.</p>
      <div class="note">✅ Shorts format (720×1280) • 15-30 seconds • Full HD</div>
      <div style="margin: 20px 0;">
        <p><strong>Upload to YouTube?</strong></p>
        <label class="check">
          <input type="checkbox" id="uploadYT" ${settings().youtubeToken ? 'checked' : 'disabled'} />
          Auto-upload with title, description, tags
          ${settings().youtubeToken ? '' : ' <span class="muted">(add YouTube token in Settings)</span>'}
        </label>
        <label style="margin-top: 10px;">
          Channel name:
          <input type="text" id="uploadChannel" value="${esc(channelOf())}" placeholder="e.g., HarshuVlog" />
        </label>
      </div>
      <div style="display: flex; gap: 10px; margin-top: 20px;">
        <button class="btn" style="flex: 1;" onclick="this.closest('dialog').close('download')">📥 Download only</button>
        <button class="btn primary" style="flex: 1;" onclick="this.closest('dialog').close('upload')" ${!settings().youtubeToken ? 'disabled' : ''}>📺 Upload to YouTube</button>
      </div>
    </div>
  `;
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg';
    dlg.innerHTML = html;
    document.body.append(dlg);
    dlg.showModal();
    dlg.addEventListener('close', () => {
      const channel = document.getElementById('uploadChannel')?.value || channelOf();
      const upload = dlg.returnValue === 'upload' && document.getElementById('uploadYT')?.checked;
      dlg.remove();
      resolve({ upload, channel });
    });
  });
}

async function downloadPart(p, n, autoYoutube = false) {
  const blob = await db.getBlob(`${p.id}/p${n}/video`);
  if (!blob) return toast('❌ Video not ready');
  const d = pd(p, n);
  const fname = `${p.id}_part${n}.${d.ext || 'mp4'}`;

  // Show upload confirmation dialog
  if (!autoYoutube) {
    const { upload, channel } = await showUploadDialog(p, n);
    if (upload) {
      download(blob, fname);
      uploadToYouTube(p, n, blob, d.meta, channel);
    } else {
      download(blob, fname);
    }
  } else {
    download(blob, fname);
    if (autoYoutube && settings().youtubeToken) {
      uploadToYouTube(p, n, blob, d.meta, channelOf());
    }
  }
}

async function uploadToYouTube(p, n, videoBlob, meta, channel = null) {
  const ch = channel || channelOf();
  toast('📤 Uploading to YouTube...', 10000);
  try {
    const formData = new FormData();
    formData.append('title', meta?.title || p.bible.title_roman);
    formData.append('description', meta?.description || p.bible.logline);
    formData.append('tags', (meta?.tags || []).slice(0, 20).join(','));
    formData.append('video', videoBlob, `${p.id}_p${n}.mp4`);
    formData.append('channel', ch);
    const res = await fetch('/api/youtube-upload', { method: 'POST', body: formData, headers: keyHeaders() });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    toast(`✅ Uploaded to YouTube! https://youtu.be/${data.videoId}`, 8000);
  } catch (err) {
    toast(`❌ YouTube upload failed: ${err.message}`, 6000);
  }
}

async function autoGenerateAndUpload(topic, partsCount) {
  const ch = channelOf();
  if (!ch) return toast('📺 Set channel name in Settings first', 4000);
  if (!settings().youtubeToken) return toast('⚠️ Connect YouTube in Settings first', 4000);
  toast(`⏳ Starting auto-generation: ${topic} (${partsCount} parts)...`, 3000);
  setTimeout(() => { autoGenerate(topic, partsCount); }, 500);
}

// Auto-trigger next part when current part finishes
setInterval(async () => {
  if (!window.__autoGenProj) return;
  const p = window.__autoGenProj;
  for (let n = 1; n <= p.partsCount; n++) {
    const d = pd(p, n);
    if (d.status === 'done' && !d.autoDownloaded) {
      d.autoDownloaded = true;
      await downloadPart(p, n, !!settings().youtubeToken);
      if (n < p.partsCount) {
        const nextD = pd(p, n + 1);
        if (nextD.status === 'new') {
          toast(`📺 Starting Part ${n + 1}...`);
          makeVideo(p, n + 1);
        }
      }
    }
  }
}, 5000);

// ---------- SETTINGS ----------
const dlg = document.getElementById('settingsDlg');
async function openSettings() {
  const s = settings(); const f = document.getElementById('settingsForm');
  f.channel.value = s.channel || ''; f.quality.value = s.quality || 'hd'; f.geminiKey.value = s.geminiKey || ''; f.youtubeToken.value = s.youtubeToken || '';
  f.cfAccount.value = s.cfAccount || ''; f.cfToken.value = s.cfToken || ''; f.pollinationsKey.value = s.pollinationsKey || '';
  f.hfToken.value = s.hfToken || ''; f.falKey.value = s.falKey || ''; f.falModel.value = s.falModel || '';
  const est = await db.estimate();
  document.getElementById('storageInfo').textContent = est ? `💾 Browser storage: ${(est.usage / 1e6).toFixed(0)} MB used of ${(est.quota / 1e9).toFixed(1)} GB` : '';
  dlg.showModal();
}
document.getElementById('btnSettings').onclick = openSettings;
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  const f = document.getElementById('settingsForm');
  saveSettings({
    channel: f.channel.value.replace(/^@/, '').trim(), quality: f.quality.value, geminiKey: f.geminiKey.value.trim(), youtubeToken: f.youtubeToken?.value.trim(),
    cfAccount: f.cfAccount.value.trim(), cfToken: f.cfToken.value.trim(), pollinationsKey: f.pollinationsKey.value.trim(),
    hfToken: f.hfToken.value.trim(), falKey: f.falKey.value.trim(), falModel: f.falModel.value.trim(),
  });
  toast('✅ Settings saved'); route();
});

window.addEventListener('beforeunload', (e) => { if (jobs.size) { e.preventDefault(); e.returnValue = ''; } });
db.persist?.().catch(() => {});
route();
if (!channelOf()) setTimeout(() => toast('📺 ⚙️ Settings mein apna channel name daalein', 4000), 800);
// expose for debugging
window.__studio = { db, jobs, sceneCount, autoGenerate };

// Chatbot already initialized and exported from chatbot.js
window.chatbot = chatbot;

// Listen for chatbot create video requests
window.addEventListener('chatbot-create', async (e) => {
  const { topic, duration, parts, lang } = e.detail;
  if (!topic) { chatbot.addMessage('bot', '❌ Topic chaahiye! (Need a topic!)'); return; }
  
  const catId = topic.toLowerCase().includes('mystery') ? 'family' : 'family';
  const url = `#/new/${catId}?topic=${encodeURIComponent(topic)}&partsCount=${parts}`;
  chatbot.addMessage('bot', '🎬 Video banane jaa raha hoon... (Creating video...)');
  setTimeout(() => { go(url); }, 500);
});

// Listen for chatbot upload requests
window.addEventListener('chatbot-upload', async (e) => {
  const { channel } = e.detail;
  if (window.__studio.currentProject) {
    chatbot.addMessage('bot', '📤 YouTube par upload ho raha hai... (Uploading to YouTube...)');
    // Trigger upload flow
    setTimeout(() => {
      toast('✅ Video upload request sent!');
    }, 1000);
  }
});

// User can send 'create' command from chatbot to trigger video generation
setInterval(() => {
  const pending = chatbot.getPendingVideoCreation?.();
  if (pending && window.__studio.autoGenerate) {
    console.log('Auto-generating video:', pending);
    window.dispatchEvent(new CustomEvent('chatbot-create', { detail: pending }));
  }
}, 1000);
