// All story / script / YouTube-metadata prompts.
import { chat } from './ai.js';
import { getCategory } from './topics.js';

const LANG_RULES = {
  hi: `Language: pure simple HINDI. Field "hi" = Hindi in Devanagari script. Field "roman" = the same sentence in Roman Hindi (Hinglish letters).`,
  hinglish: `Language: everyday HINGLISH (Hindi mixed with common English words, like Indian YouTubers talk). Field "hi" = that Hinglish sentence written in Devanagari script (English words also in Devanagari, e.g. "मेरा फ़ोन") so a Hindi voice can read it. Field "roman" = the same sentence in Roman letters (e.g. "Mera phone").`,
  en: `Language: simple Indian ENGLISH. Field "hi" and field "roman" both = the English sentence.`,
};

const SYSTEM = `You are a top Indian YouTube storyteller and scriptwriter who writes viral, emotional, funny, family-friendly ORIGINAL stories.
Rules: Never use copyrighted characters, brand names, real celebrities or existing show names - invent original Indian characters and places.
Stories must have a strong hook in the first line, clear start-middle-end, twists, emotion and a satisfying ending or cliffhanger.
Always answer with valid JSON only.`;

export function wordsPerSecond(lang) {
  return lang === 'en' ? 2.4 : 2.2;
}

export function sceneCount(format, duration, mode) {
  if (mode === 'dance') return Math.max(6, Math.min(24, Math.round(duration / 2.5)));
  if (format === 'short') return Math.max(4, Math.min(24, Math.round(duration / 5)));
  return Math.max(6, Math.min(90, Math.round(duration / 10)));
}

export async function freshIdeas(categoryId, language, count = 8) {
  const cat = getCategory(categoryId);
  const res = await chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Give ${count} fresh, highly clickable, ORIGINAL YouTube video ideas for the category "${cat.name}" (${cat.about}).
Trending in India right now, suitable for Shorts and for multi-part series. Write each idea as a short Hinglish one-liner (max 12 words).
Return JSON: {"ideas": ["...", "..."]}`,
      },
    ],
    { validate: (o) => Array.isArray(o.ideas) && o.ideas.length },
  );
  return res.ideas.map(String).slice(0, count);
}

function charactersHint() {
  return `"characters": [{"id":"c1","name":"Name","gender":"male|female","age":"child|young|adult|old","look":"VERY detailed fixed appearance in English for an image AI so the face stays identical in every scene: age in years, Indian skin tone, face shape, eyes, hair style & colour, facial hair, body type, exact outfit with colours, accessories"}]`;
}

export async function createBible(p) {
  const cat = getCategory(p.category);
  const isDance = p.mode === 'dance';
  const own = p.customStory?.trim()
    ? `\nThe user gave their OWN story / idea. Follow it closely (keep its events and characters), only improve it:\n"""${p.customStory.trim().slice(0, 6000)}"""\n`
    : '';
  const partsLine =
    p.partsCount > 1
      ? `Plan a ${p.partsCount}-part series that goes from the beginning to the final ending. Every part except the last ends on a cliffhanger; the last part gives a satisfying ending.`
      : 'It is a single complete video with a start, middle and end.';
  const ask = isDance
    ? `Create a concept for a trending ${p.format === 'short' ? 'YouTube Short' : 'YouTube video'} in the category "${cat.name}": ${p.topic}.
It is a cheerful dance / song video. Invent 1-3 cute original characters (e.g. a small kid, a baby, a grandmother or cartoon animals). ${partsLine}
Each part is a different dance/song episode.`
    : `Create a story bible for a ${p.format === 'short' ? 'YouTube Shorts' : 'long YouTube video'} story in the category "${cat.name}" (${cat.about}).
Topic: ${p.topic}. Each part is about ${Math.round(p.duration)} seconds long. ${partsLine}
Use 2-5 main characters (Indian names).${(p.voiceStyle || 'storyteller') === 'storyteller' ? ' The story is told in FIRST PERSON by ONE main character (the storyteller, e.g. "Namaste dosto, main Raju hoon..."). Put the storyteller FIRST in the characters list and set "teller" to their id.' : ' The narrator is not a character.'}`;
  const bible = await chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `${ask}${own}
${LANG_RULES[p.language] || LANG_RULES.hinglish}
Return JSON:
{"title":"catchy series title in Devanagari (English if language is English)","title_roman":"same title in Roman letters","logline":"1-2 line hook in Hinglish","setting":"place, era and visual mood in English for image AI","teller":"c1",
${charactersHint()},
"parts":[{"part":1,"title":"part title in Roman Hinglish","summary":"3-5 sentences of what happens in this part (Hinglish)"}]}
"parts" must contain exactly ${p.partsCount} item(s).`,
      },
    ],
    { validate: (o) => o.title && Array.isArray(o.characters) && Array.isArray(o.parts) && o.parts.length },
  );
  bible.characters = bible.characters.slice(0, 6).map((c, i) => ({
    id: c.id || 'c' + (i + 1),
    name: String(c.name || 'Character ' + (i + 1)),
    gender: /f/i.test(c.gender) ? 'female' : 'male',
    age: ['child', 'young', 'adult', 'old'].includes(c.age) ? c.age : 'adult',
    look: String(c.look || ''),
  }));
  if (!isDance && (p.voiceStyle || 'storyteller') === 'storyteller') {
    const t = bible.characters.find((c) => c.id === bible.teller) || bible.characters[0];
    bible.teller = t?.id || null;
  } else bible.teller = null;
  while (bible.parts.length < p.partsCount) {
    bible.parts.push({ part: bible.parts.length + 1, title: 'Part ' + (bible.parts.length + 1), summary: '' });
  }
  bible.parts = bible.parts.slice(0, p.partsCount).map((x, i) => ({ ...x, part: i + 1 }));
  return bible;
}

function bibleText(p) {
  const b = p.bible;
  return `SERIES: ${b.title_roman || b.title} - ${b.logline}
SETTING: ${b.setting}
CHARACTERS:
${b.characters.map((c) => `- ${c.id}: ${c.name} (${c.gender}, ${c.age}) look: ${c.look}`).join('\n')}
ALL PARTS:
${b.parts.map((x) => `Part ${x.part} "${x.title}": ${x.summary}`).join('\n')}`;
}

function normScene(s, chars) {
  const ids = new Set(chars.map((c) => c.id));
  const byName = Object.fromEntries(chars.map((c) => [c.name.toLowerCase(), c.id]));
  const fixSpeaker = (sp) => {
    sp = String(sp || 'narrator').trim();
    if (ids.has(sp)) return sp;
    const n = byName[sp.toLowerCase()];
    return n || 'narrator';
  };
  return {
    visual: String(s.visual || s.image || ''),
    mood: String(s.mood || 'calm').toLowerCase(),
    characters: (s.characters || []).map(fixSpeaker).filter((x) => x !== 'narrator'),
    lines: (s.lines || [])
      .filter((l) => l && (l.hi || l.roman))
      .map((l) => ({ speaker: fixSpeaker(l.speaker), hi: String(l.hi || l.roman), roman: String(l.roman || l.hi) })),
  };
}

function voiceRules(p) {
  const style = p.voiceStyle || 'storyteller';
  if (style === 'drama') return 'Mix narration with natural character dialogues (emotional, funny, dramatic). Short sentences that sound great when spoken.';
  if (style === 'narrator') return 'ONE narrator tells the whole story in third person like a professional Hindi kahani voice-over ("Ek gaon mein Raju naam ka ladka rehta tha..."). Retell what characters say inside the narration ("Raju ne kaha ki..."), or quote very short lines inside the narration. Warm, emotional, engaging tone.';
  const t = p.bible.characters.find((c) => c.id === p.bible.teller) || p.bible.characters[0];
  return `The WHOLE script is spoken by ONE person: ${t ? `${t.name} (${t.id})` : 'the main character'}, telling their OWN story in FIRST PERSON to the viewers, like a real person talking to camera ("Namaste dosto, main ${t?.name || 'Raju'} hoon. Aaj main aapko apni kahani sunata hoon...", "Maine galti se khidki tod di... phir maine socha..."). Use "main / mera / maine" (or "I / my" in English) and speak directly to the viewer sometimes ("aap sochiye..."). Retell what others said in own words ("Papa ne gusse mein kaha..."). Natural, emotional, honest storytelling.${partNo1(p)}`;
}

function partNo1(p) {
  return ' In Part 1 the first line introduces the storyteller; in later parts the first line is like "Pichle part mein aapne dekha...".';
}

export async function createStoryScript(p, partNo, onProgress) {
  const part = p.bible.parts[partNo - 1];
  const total = sceneCount(p.format, p.duration, 'story');
  const totalWords = Math.round(p.duration * wordsPerSecond(p.language) * 0.92);
  const batchSize = p.format === 'short' ? total : 8;
  const batches = Math.ceil(total / batchSize);
  const scenes = [];
  for (let b = 0; b < batches; b++) {
    const n = Math.min(batchSize, total - b * batchSize);
    const words = Math.round((totalWords * n) / total);
    const prev = scenes
      .slice(-3)
      .map((s) => s.lines.map((l) => `${l.speaker}: ${l.roman}`).join(' / '))
      .join('\n');
    const position =
      batches === 1
        ? 'This is the WHOLE part: hook in scene 1, build-up, twist, and the ending of this part in the last scene.'
        : b === 0
          ? `This is the BEGINNING (scenes 1-${n} of ${total}). Start with a powerful hook.`
          : b === batches - 1
            ? `This is the END of the part (last ${n} scenes of ${total}). Finish this part's events.`
            : `This is the MIDDLE (batch ${b + 1} of ${batches}). Continue naturally and raise the tension.`;
    onProgress?.(`Writing script ${b + 1}/${batches}...`);
    const isLast = partNo === p.partsCount;
    const res = await chat(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `${bibleText(p)}

Now write the script of PART ${partNo}: "${part.title}" - ${part.summary}
${position}
${prev ? `Story so far (last scenes):\n${prev}\n` : ''}${p.customStory?.trim() ? `Follow the user's story: """${p.customStory.trim().slice(0, 3000)}"""\n` : ''}
Write exactly ${n} scenes with about ${words} spoken words in total (each scene ${Math.max(6, Math.round(words / n) - 4)}-${Math.round(words / n) + 4} words).
${voiceRules(p)}
${b === batches - 1 ? (isLast ? 'End the series with a satisfying ending and a small moral/emotional line.' : `End with a cliffhanger and a line like "Part ${partNo + 1} mein dekhiye...".`) : ''}
${LANG_RULES[p.language] || LANG_RULES.hinglish}
${(p.voiceStyle || 'storyteller') === 'drama' ? `"speaker" is "narrator" or a character id (${p.bible.characters.map((c) => c.id).join(', ')}).` : '"speaker" is ALWAYS "narrator" (one single voice tells everything).'}
Every line must be a COMPLETE, natural spoken sentence (subject + verb), 6-18 words, that sounds great read aloud. No stage directions, no emojis, no brackets.
"visual" = English image prompt for this scene: what we see, camera angle, emotion on faces, lighting, background (do not describe text/letters). Mention characters by name.
"mood" = one of: happy, sad, suspense, horror, comedy, epic, romantic, calm.
Return JSON: {"scenes":[{"visual":"...","mood":"...","characters":["c1"],"lines":[{"speaker":"narrator","hi":"...","roman":"..."}]}]}`,
        },
      ],
      { validate: (o) => Array.isArray(o.scenes) && o.scenes.length },
    );
    scenes.push(...res.scenes.map((s) => normScene(s, p.bible.characters)).filter((s) => s.lines.length));
  }
  return { scenes };
}

export async function createDanceScript(p, partNo) {
  const part = p.bible.parts[partNo - 1];
  const n = sceneCount(p.format, p.duration, 'dance');
  const res = await chat(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `${bibleText(p)}

Create PART ${partNo} "${part.title}" - ${part.summary}
It is a ${Math.round(p.duration)}-second cheerful dance / song video with original lyrics.
${LANG_RULES[p.language] || LANG_RULES.hinglish}
Return JSON:
{"hook":{"hi":"short exciting spoken intro (max 8 words)","roman":"..."},
"scenes":[{"visual":"English image prompt: the character(s) in a specific energetic dance pose / moment, expression, outfit, background, lighting","characters":["c1"],"lyric":{"hi":"one short original catchy lyric line (3-7 words)","roman":"..."}}],
"outro":{"hi":"short spoken line asking to like & subscribe (max 10 words)","roman":"..."}}
Exactly ${n} scenes, every pose different (jump, spin, hands up, side step, clap, bhangra arms, thumka, freeze pose...), same characters and outfits in all scenes. Lyrics should repeat a simple hook like a real kids song.`,
      },
    ],
    { validate: (o) => Array.isArray(o.scenes) && o.scenes.length },
  );
  const chars = p.bible.characters;
  const scenes = res.scenes.map((s) => {
    const sc = normScene({ ...s, mood: 'dance', lines: [] }, chars);
    sc.lyric = { hi: String(s.lyric?.hi || s.lyric?.roman || ''), roman: String(s.lyric?.roman || s.lyric?.hi || '') };
    return sc;
  });
  const line = (o) => (o && (o.hi || o.roman) ? { speaker: 'narrator', hi: String(o.hi || o.roman), roman: String(o.roman || o.hi) } : null);
  return { scenes, hook: line(res.hook), outro: line(res.outro) };
}

export async function createMetadata(p, partNo, script, channel) {
  const part = p.bible.parts[partNo - 1];
  const sample = script.scenes
    .slice(0, 12)
    .map((s) => (s.lines.length ? s.lines.map((l) => l.roman).join(' ') : s.lyric?.roman || ''))
    .join(' ')
    .slice(0, 1500);
  const isShort = p.format === 'short';
  const res = await chat(
    [
      { role: 'system', content: SYSTEM + ' You are also a YouTube SEO expert for Indian audiences.' },
      {
        role: 'user',
        content: `Write YouTube upload metadata for this ${isShort ? 'YouTube Short' : 'YouTube video'}.
Series: ${p.bible.title_roman || p.bible.title} (${p.bible.title}). ${p.partsCount > 1 ? `Part ${partNo} of ${p.partsCount}: ${part.title}.` : ''}
Story: ${part.summary}
Script sample: ${sample}
Channel: ${channel || 'our channel'}
Return JSON:
{"title":"viral clickable title, max 70 chars, Hinglish with 1-2 emojis${p.partsCount > 1 ? `, include "Part ${partNo}"` : ''}${isShort ? ', end with #shorts' : ''}",
"description":"3 short paragraphs in Hinglish: hook, what happens (no spoilers of the ending), call to action to like, share, subscribe${p.partsCount > 1 ? ' and watch the next part' : ''}. Add timestamps-free text, no links.",
"tags":["15-25 search tags, Hindi + English, short phrases"],
"hashtags":["#5-8 hashtags"],
"thumbnail_text":"2-4 BIG shocking words for thumbnail (Roman Hinglish, CAPS)",
"hook_text":"3-6 word on-screen hook shown in first seconds (Roman Hinglish)"}`,
      },
    ],
    { validate: (o) => o.title && o.description },
  );
  const tags = (Array.isArray(res.tags) ? res.tags : String(res.tags || '').split(','))
    .map((t) => String(t).replace(/^#/, '').trim())
    .filter(Boolean);
  let hashtags = (Array.isArray(res.hashtags) ? res.hashtags : String(res.hashtags || '').split(/[\s,]+/))
    .map((h) => '#' + String(h).replace(/^#/, '').replace(/\s+/g, ''))
    .filter((h) => h.length > 1);
  if (isShort && !hashtags.some((h) => h.toLowerCase() === '#shorts')) hashtags.unshift('#shorts');
  hashtags = [...new Set(hashtags)].slice(0, 10);
  return {
    title: String(res.title).slice(0, 100),
    description: String(res.description),
    tags: [...new Set(tags)].slice(0, 30),
    hashtags,
    thumbnail_text: String(res.thumbnail_text || p.bible.title_roman || '').slice(0, 40),
    hook_text: String(res.hook_text || res.thumbnail_text || '').slice(0, 50),
  };
}

export function fullDescription(meta, p, partNo, channel) {
  const lines = [meta.description.trim(), ''];
  if (p.partsCount > 1) lines.push(`📺 Series: ${p.bible.title_roman || p.bible.title} - Part ${partNo}/${p.partsCount}`, '');
  if (channel) lines.push(`🔔 Subscribe ${channel.startsWith('@') ? channel : '@' + channel} for more stories!`, '');
  lines.push(
    'ℹ️ This story, visuals, voice and music are original and AI-generated (altered or synthetic content).',
    '',
    meta.hashtags.join(' '),
  );
  return lines.join('\n');
}
