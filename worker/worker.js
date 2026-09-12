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

// Visitor limits (in-memory, per Worker isolate — resets when the isolate is
// recycled, so treat it as a speed bump; the providers' own free-tier quotas
// are the hard backstop that keeps everything at $0).
// generous per person: multiple full sessions with both bots in one sitting.
// Traffic is 2-4 visitors/day, so even everyone maxing out stays inside the
// combined free tiers of Gemini + Groq + OpenRouter.
const PER_IP_PER_HOUR = 100;
const GLOBAL_PER_DAY = 600;

const MAX_MESSAGES = 16;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TOTAL_CHARS = 20000;
const MAX_OUTPUT_TOKENS = 1024;

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

Setup: you need the job or program, a couple of background highlights, and their weak spots. If any are missing, ask once, briefly. If they give partial information, make a reasonable assumption, state it in one short line ("I'll assume entry level — correct me anytime"), and start. Never interrogate.

Running the session:
- Announce the shape once at the start: about 6 questions, then a debrief. Number each question ("Question 3:").
- ONE question per message, never two. Each question tests a different competency drawn from the role's real requirements; never re-ask anything.
- Sound like a real interviewer: start broad, go deeper, and probe claims they state but do not prove before moving on.
- Give feedback after each answer, before the next question — never formulaic. A weak answer gets the full treatment: what worked, the biggest problem (quote their exact words), and a two-sentence example of a stronger answer. A strong answer gets one specific line of credit and a harder question. Never open two feedback messages the same way.
- Watch answer shape: a clear situation, actions said with "I" not "we", a real result at the end. Name the missing part — and if the same part is missing twice, call out the pattern.
- Adapt on evidence: strong answers earn harder questions or pressure follow-ups; struggling earns one simpler question on the same competency.
- After question 6, or when they ask to stop: a debrief — two strongest habits, two weakest, and the single thing to practice before the real interview, each tied to something they actually said.

Style: plain text — no markdown headings or tables. Under 120 words per reply. Professional and direct, like a real interviewer: no jokes, no banter, no cutesy phrasing; encouragement must be earned with specifics. If the visitor writes in another language, respond in that language.

If asked something unrelated to interview practice, steer back in one line. If asked how you work: you run on a written prompt, and this site's guide teaches how to build your own.

Never ask for or encourage sharing of private personal information (ID numbers, addresses, confidential employer data) — general highlights are enough.`,
};

// Providers are tried in order; any without a configured key is skipped.
function providers(env) {
  return [
    {
      name: 'gemini',
      key: env.GEMINI_API_KEY,
      call: async (key, system, messages) => {
        const model = env.GEMINI_MODEL || 'gemini-flash-lite-latest';
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
                      mime_type: head.includes('jpeg') ? 'image/jpeg' : 'image/png',
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
          env.GROQ_MODEL || 'llama-3.3-70b-versatile',
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
          env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
          system,
          messages
        ),
    },
  ];
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
const ipHits = new Map(); // ip -> [timestamps]
let dayStamp = '';
let dayCount = 0;
let lastAllFail = 0; // when every provider last failed; page checks via GET
const RESTING_WINDOW_MS = 10 * 60 * 1000;

// check without recording a hit — used by the GET status endpoint
function peekLimited(ip) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (today === dayStamp && dayCount >= GLOBAL_PER_DAY) return true;
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 3600_000);
  return hits.length >= PER_IP_PER_HOUR;
}

function rateLimited(ip) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayStamp) {
    dayStamp = today;
    dayCount = 0;
  }
  if (dayCount >= GLOBAL_PER_DAY) return true;
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (hits.length >= PER_IP_PER_HOUR) {
    ipHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  dayCount += 1;
  if (ipHits.size > 5000) ipHits.clear(); // crude memory cap
  return false;
}

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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response('forbidden', { status: 403 });
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method === 'GET') {
      // page-load health check: is the bot resting or this visitor limited?
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      return json(
        {
          ok: true,
          resting: Date.now() - lastAllFail < RESTING_WINDOW_MS,
          limited: peekLimited(ip),
        },
        200,
        origin
      );
    }
    if (request.method !== 'POST') {
      return json({ error: 'method' }, 405, origin);
    }

    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    if (rateLimited(ip)) {
      return json({ error: 'rate_limited' }, 429, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'bad_json' }, 400, origin);
    }

    const system = SYSTEM_PROMPTS[body.bot];
    if (!system || !Array.isArray(body.messages) || body.messages.length === 0) {
      return json({ error: 'bad_request' }, 400, origin);
    }

    // sanitize history: roles, sizes, count; a whiteboard image may ride on
    // the FINAL user message only (older ones are dropped to keep payloads small)
    const IMG_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
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
        const out = { role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) };
        if (
          m.role === 'user' &&
          typeof m.image === 'string' &&
          m.image.length < 1_800_000 &&
          IMG_RE.test(m.image)
        ) {
          out.image = m.image;
        }
        return out;
      });
    for (let i = 0; i < messages.length - 1; i++) delete messages[i].image;
    while (
      messages.length > 1 &&
      messages.reduce((n, m) => n + m.content.length, 0) > MAX_TOTAL_CHARS
    ) {
      messages.shift();
    }
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
      return json({ error: 'bad_request' }, 400, origin);
    }

    // a message carrying a drawing can only go to a provider that can see it
    const hasImage = messages.some((m) => m.image);
    for (const p of providers(env)) {
      if (!p.key) continue;
      if (hasImage && p.name !== 'gemini') continue;
      try {
        const reply = await p.call(p.key, system, messages);
        lastAllFail = 0;
        return json({ reply, provider: p.name }, 200, origin);
      } catch (e) {
        // quota hit, model gone, or provider down — fall through to the next
        console.log(`provider ${p.name} failed: ${e.message}`);
      }
    }
    if (hasImage) {
      // text chat may still be fine — don't put the whole bot to rest
      return json({ error: 'image_unavailable' }, 503, origin);
    }
    lastAllFail = Date.now();
    return json({ error: 'resting' }, 503, origin);
  },
};
