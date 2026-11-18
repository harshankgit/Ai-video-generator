# 🎬 AI Story Video Studio (free)

Create **YouTube Shorts (9:16)** and **long story videos (16:9)** fully with AI — in **Hinglish, Hindi or English**.

- 18 topic categories with idea cards (Gaon ki kahani, Car / road-trip stories, Society comedy, Horror, Family, Moral, Panchatantra animals, Love, Mythology, Motivation, Thriller, Funny, Sci-fi, History, Cricket, Facts, **Trending kids dance Shorts**, **Kids rhymes**) + AI fresh ideas + your own topic or your own story
- Series with **Part 1, Part 2 …** (story planned start → end)
- Voice styles: **one person tells his/her own story** (first person, default), single narrator, or drama (different voice per character)
- AI images with consistent characters, Ken-Burns motion, transitions, big Shorts-style subtitles with word highlight, title/hook, PART badge, **your channel name** watermark, intro + end card (Subscribe / next part)
- Original background music generated in the browser (no copyright) or upload your own (e.g. YouTube Audio Library)
- YouTube-ready **title, description, tags, hashtags and thumbnail**
- Download MP4 + thumbnail + text. Everything is saved in your browser (IndexedDB) — stays after download, delete anytime.
- **Real motion video** (person moves hands, legs, mouth): FREE mode = Hugging Face Wan 2.2 image-to-video (~4-6 clips/day with a free HF token, other scenes use Ken-Burns) · PAID mode = fal.ai (Kling etc.) real-life motion for every scene

## How it works (all free)

| Part | Service |
|---|---|
| Story / script / title (AI text) | Google Gemini (free key, optional, best) → Pollinations.ai anonymous (free, slow) |
| Images | Cloudflare Workers AI FLUX (free key, optional, fast) → Pollinations key (optional) → Pollinations anonymous (free, 1 image / ~45 s) |
| Voice | Microsoft Edge neural TTS (free, Hindi voices Madhur / Swara + multilingual) |
| Music + SFX | Generated in the browser (Web Audio) – original, copyright free |
| Video render | In your browser (Canvas + WebCodecs via Mediabunny) → MP4 |
| Real motion (optional) | FREE: Hugging Face ZeroGPU Space Wan 2.2 (free HF token, daily GPU quota) · PAID: fal.ai key |
| Hosting | Vercel Hobby (free) – static site + 5 small serverless functions |

Use **Chrome or Edge on desktop** for rendering (needs WebCodecs).

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

## Deploy free on Vercel

1. Push this folder to a GitHub repo.
2. Go to https://vercel.com → *Add New → Project* → import the repo → **Deploy** (no build settings needed, `vercel.json` is included).
3. (Optional, recommended) *Project → Settings → Environment Variables*:
   - `GEMINI_API_KEY` – free from https://aistudio.google.com/apikey (fast + better Hindi stories)
   - `CF_ACCOUNT_ID` and `CF_API_TOKEN` – free Cloudflare account → *AI → Workers AI → Use REST API* (fast images, ~100+ / day free)
   - `POLLINATIONS_KEY` – optional key from https://enter.pollinations.ai
   - `HF_TOKEN` – free Hugging Face token (https://huggingface.co/settings/tokens) for FREE real motion clips
   - `FAL_KEY` (+ optional `FAL_MODEL`) – paid fal.ai key for real-life motion in every scene
   Then redeploy. Keys can also be entered per-browser in ⚙️ Settings instead.

## YouTube tips

- In YouTube Studio tick **"Altered or synthetic content" → Yes** for realistic AI content.
- Visuals and music are generated, so there is no third-party copyright material — but YouTube can still refuse monetization for low-effort / mass-produced repetitive videos. Edit scripts, keep a consistent series and add your own touch.
- Characters are original. Don't use names / characters from existing TV shows.
