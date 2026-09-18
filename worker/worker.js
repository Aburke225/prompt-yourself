// Prompt Yourself — free chat relay.
// A tiny Cloudflare Worker that keeps the API keys secret and forwards chat
// messages to free-tier AI providers, trying each in order until one answers.
// $0 rule: run this on the Workers free plan with NO payment method attached,
// and create every provider key WITHOUT enabling billing. Exhausted quotas
// return errors, never charges — the site shows its copy-paste fallback.

const ALLOWED_ORIGINS = [
  'https://aburke225.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

// NO VISITOR LIMITS AT ALL, per person or site-wide. A counter here could never
// create provider quota - it only chose which wall got hit first, and the wall
// it chose was the worse one: a 429 is the site telling someone they have had
// enough, where running out of quota is the providers doing it, which the
// fallback chain already handles by trying the next one and finally collapsing
// to the guide. Same outcome, one fewer refusal that is ours.
//
// The $0 rule is unaffected: the providers' own free tiers are the hard
// backstop, and an exhausted free tier returns an error rather than a bill.

// NO LENGTH CAP. Nothing a visitor types is cut or dropped: the per-message
// slice and the whole-conversation trim are both gone, so a pasted resume or a
// wall of notes goes through whole. The only limit left is the model's own, and
// that one announces itself instead of quietly eating the end of a sentence.
//
// MAX_MESSAGES stays as a window rather than a cap. It loses nothing anyone
// typed - older turns simply scroll out of the model's view, the way every
// chat works - and without it a long session would resend its entire history
// on every single turn.
//
// What removing the caps hands over is the failure mode, which is why the
// oversized case is classified separately below: a request too big for every
// provider must not look like every provider being down.
const MAX_MESSAGES = 48;
// Not a cap on what is accepted or sent. Purely the line above which an
// all-provider failure is read as "too long for the free models" instead of
// "the free models are down" - about 30k tokens, past any real message.
const LIKELY_TOO_LONG_CHARS = 120000;
const MAX_OUTPUT_TOKENS = 1024;

// Live prompts are fetched from the site (prompts.json in this repo) and
// cached ~5 minutes, so prompt edits ship with a git push — no re-paste.
// The built-in copies below are the fallback if the fetch ever fails.
const PROMPTS_URL = 'https://aburke225.github.io/prompt-yourself/prompts.json';
const PROMPTS_TTL_MS = 5 * 60 * 1000;
const MODELS_URL = 'https://aburke225.github.io/prompt-yourself/models.json';
let modelCache = { at: 0, data: null };
async function getModels() {
  const now = Date.now();
  if (modelCache.data && now - modelCache.at < PROMPTS_TTL_MS) return modelCache.data;
  try {
    const res = await fetch(MODELS_URL, { cf: { cacheTtl: 240 } });
    if (res.ok) {
      const data = await res.json();
      const sane = (m) => typeof m === 'string' && m.length > 3 && m.length < 100 && !/[\s`]/.test(m);
      if (data && sane(data.gemini) && sane(data.groq) && sane(data.openrouter)) {
        modelCache = { at: now, data };
        return data;
      }
    }
  } catch (e) {
    console.log('models fetch failed: ' + e.message);
  }
  modelCache.at = now; // don't refetch on every request while it's failing
  return modelCache.data || null;
}
let promptCache = { at: 0, data: null };
async function getPrompts() {
  const now = Date.now();
  if (promptCache.data && now - promptCache.at < PROMPTS_TTL_MS) return promptCache.data;
  try {
    const res = await fetch(PROMPTS_URL, { cf: { cacheTtl: 240 } });
    if (res.ok) {
      const data = await res.json();
      // a fetched prompt must look like prose, not leaked source: a publish
      // accident once appended worker code to a prompt, so garbage now falls
      // back to the built-ins instead of shipping for five minutes at a time
      const sane = (p) =>
        typeof p === 'string' &&
        p.length > 200 &&
        p.length < 12000 &&
        !p.includes('function ') &&
        !p.includes('=>') &&
        !p.includes('`');
      if (data && sane(data.tutor) && sane(data.coach)) {
        promptCache = { at: now, data };
        return data;
      }
      console.log('fetched prompts failed sanity check - using built-ins');
    }
  } catch (e) {
    console.log('prompt fetch failed: ' + e.message);
  }
  promptCache.at = now; // don't refetch on every request while it's failing
  return promptCache.data || SYSTEM_PROMPTS;
}

const SYSTEM_PROMPTS = {
  tutor: `You are a patient, professional tutor embedded in a site about learning any topic with AI. The visitor may want to learn anything: budgeting, anatomy, algebra, wine, plumbing, programming.

Setup: you need their topic, level, and goal. If any are missing, ask once, briefly. If they give partial information, make a reasonable assumption, state it in one short line ("I'll assume complete beginner — correct me anytime"), and begin. Never interrogate.

How you teach:
- ONE small piece at a time, then one short question about it. Wait for the answer. Never lecture.
- Vary what you ask for so the session never feels scripted. Rotate between: a check question, "explain that back in your own words", a small applied task, and — every few exchanges — one quick recall question about something covered earlier.
- React to THEIR words: quote the exact phrase that was right or wrong. Never say "good" without naming what was good. If they are wrong, give a hint and let them retry once before revealing the answer.
- Adapt on evidence: two clean answers in a row means step up a level and say so; a struggle means shrink the next piece, same topic.
- Plain, everyday words; define any technical term in the same sentence. An analogy only when it genuinely clarifies, and keep it brief.
- After roughly 10 exchanges, offer a short recap: what they now know, what was shaky, and the one thing to review next time.

Style: plain text — no markdown headings or tables, lists of three items at most. Under 120 words per reply except worked examples. Warm but professional: no jokes, no cutesy asides, no exclamation-heavy pep. Never open two replies in a row with the same phrase. If the visitor writes in another language, respond in that language.

Honesty: never bluff. If a fact is worth double-checking, say so plainly. If asked how you work: you run on a written prompt, and this site's guide teaches how to build your own — then continue the lesson.

Never ask for private personal information.`,

  coach: `You are an experienced interviewer running a practice session, embedded in a site that teaches people to build their own AI interview coach. Any field: nursing, retail, law, teaching, software, grad school. You are tough but fair — the visitor succeeds because you tell them the truth.

Setup: you need the job or program, a couple of background highlights, and their weak spots. If any are missing, ask once, briefly. If they give partial information, make a reasonable assumption, state it in one short line ("I'll assume entry level — correct me anytime"), and move on. Never interrogate. If they upload or paste a resume, treat it as their background: draw questions from specific items on it, and never recite it back to them.

Opening the session: set the stage in one or two natural sentences, the way a real interviewer opens — what kinds of questions this role usually gets (their background and experience, plus the knowledge and skills of their field) and that you'll give honest feedback along the way. Never announce an exact question count; "some questions" is how a person talks. Then, before the first interview question, ask how they want to practice: technical questions for their field (general, or a specific area — for a developer that might be coding in general or specific algorithms), behavioral questions about their background and experience, or a mix. Default to a mix if they have no preference.

Running the session:
- ONE question per message, never two. Number each question ("Question 3:").
- Cover the real interview's parts: even in a behavioral-leaning session include at least one technical question from their field, and in a technical session at least one behavioral. Each question tests a different competency drawn from the role's real requirements; never re-ask anything.
- Sound like a real interviewer: start broad, go deeper, and probe claims they state but do not prove before moving on.
- Feedback after each answer, before the next question — never formulaic. A weak answer gets the full treatment: what worked, the biggest problem (quote their exact words), and a two-sentence example of a stronger answer. A strong answer gets one specific line of credit and a harder question. Never open two feedback messages the same way.
- Watch answer shape: a clear situation, actions said with "I" not "we", a real result at the end. Name the missing part — and if the same part is missing twice, call out the pattern.
- Adapt on evidence: strong answers earn harder questions or pressure follow-ups; struggling earns one simpler question on the same competency.
- After around six questions — or sooner if they ask to stop — close with a debrief: two strongest habits, two weakest, and the single thing to practice before the real interview, each tied to something they actually said.

Style: plain text — no markdown headings or tables. Under 120 words per reply. Professional and direct, like a real interviewer: no jokes, no banter, no cutesy phrasing, no rigid script — speak the way a person speaks. Encouragement must be earned with specifics. If the visitor writes in another language, respond in that language.

If asked something unrelated to interview practice, steer back in one line. If asked how you work: you run on a written prompt, and this site's guide teaches how to build your own.

Never ask for or encourage sharing of private personal information (ID numbers, addresses, confidential employer data) — general highlights are enough.`
};

// Providers are tried in order; any without a configured key is skipped.
// The ORDER of this list is the fallback order, and it is no longer fixed:
// models.json can carry an `order` array written by the daily ranking pass, so
// a provider that behaves better today is tried first tomorrow. Absent or
// partial, whatever is unlisted keeps its place at the back - sort is stable -
// and with no `order` at all this is exactly the original hardcoded order.
function providersUnordered(env, models) {
  return [
    {
      name: 'gemini',
      key: env.GEMINI_API_KEY,
      call: async (key, system, messages) => {
        const model = env.GEMINI_MODEL || (models && models.gemini) || 'gemini-flash-lite-latest';
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: system }] },
              contents: messages.map((m) => {
                const parts = [{ text: m.content }];
                if (m.image) {
                  const [head, data] = m.image.split(',');
                  parts.push({
                    inline_data: {
                      mime_type: head.slice(5, head.indexOf(';')),
                      data,
                    },
                  });
                }
                return { role: m.role === 'assistant' ? 'model' : 'user', parts };
              }),
              generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.8 },
            }),
          }
        );
        if (!res.ok) throw new Error(`gemini ${res.status}`);
        const data = await res.json();
        const parts = data.candidates?.[0]?.content?.parts;
        const text = parts ? parts.map((p) => p.text || '').join('') : '';
        if (!text) throw new Error('gemini empty');
        return text;
      },
    },
    {
      name: 'groq',
      key: env.GROQ_API_KEY,
      call: (key, system, messages) =>
        openAiStyle(
          'https://api.groq.com/openai/v1/chat/completions',
          key,
          env.GROQ_MODEL || (models && models.groq) || 'openai/gpt-oss-120b',
          system,
          messages
        ),
    },
    {
      name: 'openrouter',
      key: env.OPENROUTER_API_KEY,
      call: (key, system, messages) =>
        openAiStyle(
          'https://openrouter.ai/api/v1/chat/completions',
          key,
          env.OPENROUTER_MODEL || (models && models.openrouter) || 'nvidia/nemotron-3-super-120b-a12b:free',
          system,
          messages
        ),
    },
  ];
}

function providers(env, models) {
  const list = providersUnordered(env, models);
  const want = models && Array.isArray(models.order) ? models.order : null;
  if (!want || !want.length) return list;
  const rank = (n) => {
    const i = want.indexOf(n);
    return i < 0 ? 99 : i;
  };
  return list.sort((a, b) => rank(a.name) - rank(b.name));
}

async function openAiStyle(url, key, model, system, messages) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }].concat(messages),
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.8,
    }),
  });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('empty completion');
  return text;
}

// ---- rate limiting (best-effort, in-memory) ----
let lastAllFail = 0; // when every provider last failed; page checks via GET
const lastProviderErrors = []; // last few failures, visible via the keyed /debug route
const RESTING_WINDOW_MS = 10 * 60 * 1000;

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
  });
}

// ---------- burke-bot game capture (keyed; only flagged games are stored) ----------
// POST /chess/game   { key, id, color, result, moves[], ts }  -> stored in KV
// GET  /chess/games?key=...                                   -> every stored game
// Needs a CHESS_GAMES KV binding and a CHESS_KEY secret; until both exist the
// routes answer 503 and the rest of the worker is untouched. Games live in
// monthly buckets (one KV value per month) so reads stay far under the free
// plan's 50-subrequests-per-request cap.
async function handleChess(request, env, url) {
  const origin = request.headers.get('origin') || '';
  const cors = ALLOWED_ORIGINS.includes(origin) ? corsHeaders(origin) : {};
  const reply = (body, status) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...cors },
    });
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (!env.CHESS_GAMES || !env.CHESS_KEY) {
    return reply({ error: 'not_configured' }, 503);
  }

  if (url.pathname === '/chess/game' && request.method === 'POST') {
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response('forbidden', { status: 403 });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return reply({ error: 'bad_json' }, 400);
    }
    if (body.key !== env.CHESS_KEY) {
      return reply({ error: 'bad_key' }, 403);
    }
    if (
      !Array.isArray(body.moves) ||
      body.moves.length < 6 ||
      body.moves.length > 400 ||
      !['w', 'b'].includes(body.color) ||
      !['w', 'l', 'd'].includes(body.result)
    ) {
      return reply({ error: 'bad_game' }, 400);
    }
    const ts = Number(body.ts) || Date.now();
    const id = String(body.id || ts).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) || String(ts);
    const bucket = 'games:' + new Date(ts).toISOString().slice(0, 7);
    let arr;
    try {
      arr = JSON.parse((await env.CHESS_GAMES.get(bucket)) || '[]');
    } catch {
      arr = [];
    }
    if (!arr.some((g) => g.id === id)) {
      arr.push({
        id,
        color: body.color,
        result: body.result,
        moves: body.moves.slice(0, 400).map((m) => String(m).slice(0, 5)),
        ts,
      });
      await env.CHESS_GAMES.put(bucket, JSON.stringify(arr));
    }
    return reply({ ok: true, stored: arr.length }, 200);
  }

  if (url.pathname === '/chess/games' && request.method === 'GET') {
    if (url.searchParams.get('key') !== env.CHESS_KEY) {
      return reply({ error: 'bad_key' }, 403);
    }
    const games = [];
    let cursor;
    do {
      const page = await env.CHESS_GAMES.list({ prefix: 'games:', cursor });
      for (const k of page.keys) {
        try {
          games.push(...JSON.parse((await env.CHESS_GAMES.get(k.name)) || '[]'));
        } catch {}
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    games.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return reply(games, 200);
  }

  return reply({ error: 'not_found' }, 404);
}

// ---------- /tts: the coach's voice ----------
// POST /tts  { text }  ->  audio/mpeg
//
// The browser's own speechSynthesis can only use voices installed on the
// visitor's machine, which on a Mac with no Chrome voices means Samantha and
// sounds two decades old. This proxies a chosen ElevenLabs voice instead.
//
// THE KEY NEVER REACHES THE PAGE. That is the only reason this route exists
// rather than calling ElevenLabs from chat.js: a key in client JavaScript is
// public the moment it ships.
//
// $0 rule: the ElevenLabs key is created on the free plan with a monthly
// character limit set on the key itself, so an exhausted quota returns an
// error and never a charge - the same shape as every other provider here. The
// page falls back to speechSynthesis on ANY failure, so a spent quota costs
// the nice voice, never the conversation.
// A premade ElevenLabs voice, not a Voice Library one - which matters, because
// the free tier cannot call Library voices through the API and the first voice
// tried here came back 402 Payment Required for exactly that reason.
// ELEVENLABS_VOICE_ID overrides it, so a different voice can be tried from the
// dashboard without touching this file.
const TTS_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9';
// Flash: ~75ms and HALF a credit per character rather than one, which doubles
// what the monthly allowance buys. Turbo v2.5 is deprecated in favour of it.
const TTS_MODEL = 'eleven_flash_v2_5';
// One reply is 300-500 characters. 1200 leaves room for a debrief while still
// bounding a single call, because the failure mode worth guarding is one
// runaway request eating the month, not a long answer.
const TTS_MAX_CHARS = 1200;

async function handleTts(request, env, origin) {
  if (!env.ELEVENLABS_API_KEY) {
    return json({ error: 'tts_unconfigured' }, 503, origin);
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'bad_json' }, 400, origin);
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return json({ error: 'bad_request' }, 400, origin);
  if (text.length > TTS_MAX_CHARS) {
    return json({ error: 'tts_too_long', chars: text.length }, 413, origin);
  }
  const voice = env.ELEVENLABS_VOICE_ID || TTS_VOICE_ID;
  let res;
  try {
    res = await fetch(
      'https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voice),
      {
        method: 'POST',
        headers: {
          'xi-api-key': env.ELEVENLABS_API_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: env.ELEVENLABS_MODEL || TTS_MODEL,
        }),
      }
    );
  } catch (e) {
    return json({ error: 'tts_unreachable' }, 502, origin);
  }
  if (!res.ok) {
    // The upstream body can name the account and its plan, so only the status
    // crosses back. 401 is the key or its scopes, 403 is a voice this plan may
    // not use, 429 is the quota. All three mean the same thing to the page:
    // stop asking and speak locally.
    return json({ error: 'tts_failed', status: res.status }, 502, origin);
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/chess/')) {
      return handleChess(request, env, url);
    }
    if (url.pathname === '/debug') {
      if (!env.CHESS_KEY || url.searchParams.get('key') !== env.CHESS_KEY) {
        return new Response('forbidden', { status: 403 });
      }
      return new Response(
        JSON.stringify({
          resting: Date.now() - lastAllFail < RESTING_WINDOW_MS,
          keys: {
            gemini: !!env.GEMINI_API_KEY,
            groq: !!env.GROQ_API_KEY,
            openrouter: !!env.OPENROUTER_API_KEY,
            elevenlabs: !!env.ELEVENLABS_API_KEY,
          },
          tts: {
            voice: env.ELEVENLABS_VOICE_ID || TTS_VOICE_ID,
            model: env.ELEVENLABS_MODEL || TTS_MODEL,
            max_chars: TTS_MAX_CHARS,
          },
          models: await (async () => {
            const m = await getModels();
            return {
              gemini: env.GEMINI_MODEL || (m && m.gemini) || 'gemini-flash-lite-latest',
              groq: env.GROQ_MODEL || (m && m.groq) || 'openai/gpt-oss-120b',
              openrouter: env.OPENROUTER_MODEL || (m && m.openrouter) || 'nvidia/nemotron-3-super-120b-a12b:free',
              fetched_config: !!m,
            };
          })(),
          recent_provider_errors: lastProviderErrors,
        }, null, 1),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    const origin = request.headers.get('origin') || '';
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response('forbidden', { status: 403 });
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    // The origin lock above decides who may ask at all, and the ElevenLabs key's
    // own monthly character limit is the ceiling. Nothing else gates this.
    if (url.pathname === '/tts') {
      if (request.method !== 'POST') return json({ error: 'method' }, 405, origin);
      return handleTts(request, env, origin);
    }
    if (request.method === 'GET') {
      // page-load health check: is the bot resting, or is the site's day spent?
      return json(
        {
          ok: true,
          resting: Date.now() - lastAllFail < RESTING_WINDOW_MS,
          // Kept and always false. A page cached from before the limits were
          // removed still reads this field, and a missing one is falsy anyway -
          // but saying it outright means an old page can never collapse on it.
          limited: false,
          // Zero means unlimited, and the page reads it that way: it stops
          // warning about length entirely. Reporting it rather than
          // hard-coding it means an older deployed Worker still gets the
          // conservative warning instead of a promise this one cannot keep.
          limits: { messageChars: 0, totalChars: 0, messages: MAX_MESSAGES },
        },
        200,
        origin
      );
    }
    if (request.method !== 'POST') {
      return json({ error: 'method' }, 405, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'bad_json' }, 400, origin);
    }

    if (
      (body.bot !== 'tutor' && body.bot !== 'coach') ||
      !Array.isArray(body.messages) ||
      body.messages.length === 0
    ) {
      return json({ error: 'bad_request' }, 400, origin);
    }
    const system = (await getPrompts())[body.bot];

    // sanitize history: roles, sizes, count; a whiteboard image may ride on
    // the FINAL user message only (older ones are dropped to keep payloads small)
    const IMG_RE = /^data:(?:image\/(?:png|jpeg)|application\/pdf);base64,[A-Za-z0-9+/=]+$/;
    let messages = body.messages
      .filter(
        (m) =>
          m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.trim().length > 0
      )
      .slice(-MAX_MESSAGES)
      .map((m) => {
        const out = { role: m.role, content: m.content };
        if (
          m.role === 'user' &&
          typeof m.image === 'string' &&
          m.image.length < 4_000_000 &&
          IMG_RE.test(m.image)
        ) {
          out.image = m.image;
        }
        return out;
      });
    for (let i = 0; i < messages.length - 1; i++) delete messages[i].image;
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
      return json({ error: 'bad_request' }, 400, origin);
    }

    // a message carrying a drawing can only go to a provider that can see it
    const hasImage = messages.some((m) => m.image);
    const models = await getModels();
    for (const p of providers(env, models)) {
      if (!p.key) continue;
      if (hasImage && p.name !== 'gemini') continue;
      try {
        const reply = await p.call(p.key, system, messages);
        lastAllFail = 0;
        return json({ reply, provider: p.name }, 200, origin);
      } catch (e) {
        // quota hit, model gone, or provider down — fall through to the next
        console.log(`provider ${p.name} failed: ${e.message}`);
        lastProviderErrors.push({ at: new Date().toISOString(), provider: p.name, error: String(e.message).slice(0, 200) });
        if (lastProviderErrors.length > 12) lastProviderErrors.shift();
      }
    }
    if (hasImage) {
      // text chat may still be fine — don't put the whole bot to rest
      return json({ error: 'image_unavailable' }, 503, origin);
    }
    // ONE OVERSIZED REQUEST MUST NOT REST THE BOTS FOR EVERYONE. The resting
    // flag is read by every visitor's page load, so setting it here would let
    // one person pasting a book take the site down for ten minutes. With no
    // length cap that stopped being hypothetical, so a failure on an enormous
    // payload is reported to that visitor alone - the same call the image path
    // above already makes for the same reason.
    const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
    if (totalChars > LIKELY_TOO_LONG_CHARS) {
      return json({ error: 'too_long', chars: totalChars }, 413, origin);
    }
    lastAllFail = Date.now();
    return json({ error: 'resting' }, 503, origin);
  },
};
