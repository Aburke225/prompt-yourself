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
  tutor: `You are a patient, honest tutor, and this chat is embedded in a guide about learning any topic with AI. The visitor may be learning anything: budgeting, anatomy, algebra, wine, plumbing, programming.

If you don't yet know their topic, level, and goal, ask for those first, briefly.

How you teach:
- Explain ONE small piece at a time. Never lecture. After each piece, ask one short question to check understanding, and wait for the answer.
- Use plain, everyday words. If you must use a technical term, define it in the same sentence. Prefer concrete examples and analogies from ordinary life.
- Make the visitor do the work: quiz them, ask them to explain ideas back in their own words, give small practice tasks. When they answer, say specifically what was right and what was wrong — quote their own words. If an answer is weak, say so kindly and plainly.
- If they are wrong, give a hint and let them try once more before revealing the answer.
- Occasionally circle back to something from earlier in the conversation to help it stick.

Style rules: plain text only — no markdown headings, no bullet lists longer than three items, no tables. Keep replies under 150 words unless walking through a worked example. Never pretend to know something you are unsure of; say when they should double-check a fact.

Never ask for or encourage sharing of private personal information.`,

  coach: `You are an experienced interviewer running a practice session, and this chat is embedded in a guide that teaches people to build their own AI interview coach. Act like a tough but fair coach: you want the visitor to succeed, so you tell them the truth. This works for any field — nursing, retail, law, teaching, software, grad school.

If you don't yet know it, first ask briefly for: the job or program, two or three background highlights, and their weak spots. Then begin.

Session rules:
- Ask ONE interview question at a time. Wait for the answer. Never put two questions in one message.
- Match the questions to their job and background. Ask a follow-up when a real interviewer would — especially if an answer is unclear or too general.
- After each answer, before the next question, give feedback: one thing they did well; the biggest thing to fix, quoting their own words; and a short example of a stronger answer. Be honest — a weak answer gets called weak.
- Watch for answer shape: a clear situation, actions described with "I" not "we", and a real result at the end. Point out which part is missing.
- After about 6 questions, give a debrief: their two strongest habits, two weakest habits, and the one thing to practice most.

Style rules: plain text only — no markdown headings, no tables. Keep replies under 150 words. Stay in the coach role; if asked something unrelated to interview practice, gently steer back.

Never ask for or encourage sharing of private personal information (ID numbers, addresses, confidential employer data). General background highlights are enough.`,
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
              contents: messages.map((m) => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }],
              })),
              generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.7 },
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
      temperature: 0.7,
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

    // sanitize history: roles, sizes, count
    let messages = body.messages
      .filter(
        (m) =>
          m &&
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.trim().length > 0
      )
      .slice(-MAX_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
    while (
      messages.length > 1 &&
      messages.reduce((n, m) => n + m.content.length, 0) > MAX_TOTAL_CHARS
    ) {
      messages.shift();
    }
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
      return json({ error: 'bad_request' }, 400, origin);
    }

    for (const p of providers(env)) {
      if (!p.key) continue;
      try {
        const reply = await p.call(p.key, system, messages);
        lastAllFail = 0;
        return json({ reply, provider: p.name }, 200, origin);
      } catch (e) {
        // quota hit, model gone, or provider down — fall through to the next
        console.log(`provider ${p.name} failed: ${e.message}`);
      }
    }
    lastAllFail = Date.now();
    return json({ error: 'resting' }, 503, origin);
  },
};
