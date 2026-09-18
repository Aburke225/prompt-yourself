// Fixed regression suite for the two bots' prompts.
//
//   node eval/run.mjs              every case
//   node eval/run.mjs tutor        one bot
//   node eval/run.mjs f-coach-ask-01   one case by id
//
// Why this exists: both rounds of prompt improvements so far were graded by
// ad-hoc judge panels, which cannot tell you that an edit QUIETLY BROKE
// something that used to work. These are the behaviours the prompts promise,
// pinned to assertions, so a regression is a failing line rather than a thing
// nobody happened to check this time.
//
// Two things about talking to the Worker, both learned the hard way:
//   - Cloudflare's edge rejects a bare script User-Agent before the Worker is
//     ever reached, so a browser UA is mandatory.
//   - The Worker is origin-locked, so the Origin header has to be the site.
// It also rate-limits 100 requests per IP per hour. A full run is about 45
// requests, so two full runs inside an hour will start collapsing into 429s,
// which the runner reports as SKIP rather than pretending they are failures.

import { readFileSync } from 'node:fs';

const ENDPOINT = 'https://prompt-yourself-bot.andrewburke225.workers.dev';
const ORIGIN = 'https://aburke225.github.io';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const STATE_RE = /<<\s*PY\s*(\{[\s\S]*?\})\s*>>/;
function takeState(text) {
  const m = STATE_RE.exec(text);
  let state = null;
  if (m) { try { state = JSON.parse(m[1]); } catch { state = null; } }
  return {
    raw: text,
    clean: text.replace(/<<\s*PY\s*\{[\s\S]*?\}\s*>>/g, '').trim(),
    state,
    hadMarker: !!m,
  };
}

// Mirrors the context block chat.js attaches to the latest message, so the
// suite exercises the same shape the site actually sends.
function contextBlock(ctx) {
  if (!ctx) return '';
  const lines = [];
  if (ctx.grounding) lines.push('REFERENCE (Wikipedia, teach from this and prefer it over memory):\n' + ctx.grounding);
  if (ctx.profile) lines.push('LEARNER PROFILE, from earlier sessions: ' + ctx.profile);
  if (ctx.open) lines.push('STILL UNRESOLVED from before, revisit before new material: ' + ctx.open);
  if (ctx.settled) lines.push('ALREADY UNDERSTOOD, do not re-teach: ' + ctx.settled);
  if (ctx.question) {
    // some fixtures write the question as "q-conflict-01: Tell me about...".
    // The id is for the state line, not for the coach to say out loud, so it is
    // split off here rather than handed over inside the sentence.
    const m = /^\s*(q-[a-z]+-\d+)\s*:\s*([\s\S]+)$/.exec(ctx.question);
    const qid = ctx.qid || (m && m[1]) || '';
    const text = m ? m[2] : ctx.question;
    lines.push('ASK THIS QUESTION NEXT, close to word for word: "' + text + '"');
    if (qid) lines.push('Report this question id in your state line: ' + qid);
  }
  if (ctx.covered) lines.push('COVERED so far: ' + ctx.covered + '. Do not drift back to these while others are untouched.');
  if (ctx.seconds) lines.push('They took ' + ctx.seconds + ' seconds to answer aloud. Mention pacing only if it is notably long (over two minutes) or clipped (under twenty seconds).');
  if (!lines.length) return '';
  return 'SESSION CONTEXT, from the site and not from them - use it, never quote it back or mention it:\n' + lines.join('\n');
}

async function ask(bot, messages) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'user-agent': UA },
    body: JSON.stringify({ bot, messages }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, reply: data.reply || '', provider: data.provider || '' };
}

function check(a, got) {
  const fails = [];
  const { raw, clean, state, hadMarker } = got;
  // regexes run on the RAW reply so a case can assert on the state line itself;
  // shape assertions run on what the visitor actually sees
  for (const p of a.must_match || []) {
    if (!new RegExp(p, 'i').test(raw)) fails.push('must_match failed: /' + p + '/');
  }
  for (const p of a.must_not_match || []) {
    if (new RegExp(p, 'i').test(raw)) fails.push('must_not_match hit: /' + p + '/');
  }
  if (a.must_include_any && a.must_include_any.length) {
    const hit = a.must_include_any.some((t) => clean.toLowerCase().includes(t.toLowerCase()));
    if (!hit) fails.push('must_include_any: none of ' + JSON.stringify(a.must_include_any));
  }
  for (const t of a.must_not_include || []) {
    if (clean.toLowerCase().includes(t.toLowerCase())) fails.push('must_not_include hit: ' + JSON.stringify(t));
  }
  if (a.max_words) {
    const n = clean.split(/\s+/).filter(Boolean).length;
    if (n > a.max_words) fails.push('max_words ' + a.max_words + ', got ' + n);
  }
  if (a.must_end_with_question && !/\?["')\]]*\s*$/.test(clean)) {
    fails.push('must_end_with_question: ends ' + JSON.stringify(clean.slice(-40)));
  }
  if (a.must_emit_state && !hadMarker) fails.push('must_emit_state: no <<PY {...}>> found');
  if (a.must_emit_state && hadMarker && !state) fails.push('state line present but not valid JSON');
  for (const k of a.state_must_have || []) {
    if (!state || !(k in state)) fails.push('state_must_have missing key: ' + k);
  }
  return fails;
}

const fx = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url)));
const arg = process.argv[2];
const cases = fx.cases.filter((c) => !arg || c.bot === arg || c.id === arg);
if (!cases.length) { console.error('no cases match ' + arg); process.exit(2); }

let pass = 0, fail = 0, skip = 0;
const failures = [];
console.log(`running ${cases.length} case(s) against ${ENDPOINT}\n`);
for (const c of cases) {
  const messages = [];
  let got = null, bailed = '';
  for (let i = 0; i < c.turns.length; i++) {
    const last = i === c.turns.length - 1;
    const ctx = last ? contextBlock(c.context) : '';
    messages.push({ role: 'user', content: c.turns[i] + (ctx ? '\n\n' + ctx : '') });
    const r = await ask(c.bot, messages);
    if (r.status === 429) { bailed = 'rate limited (429)'; break; }
    if (!r.ok || !r.reply) { bailed = 'no reply (status ' + r.status + ')'; break; }
    got = takeState(r.reply);
    messages[messages.length - 1] = { role: 'user', content: c.turns[i] }; // keep history clean
    messages.push({ role: 'assistant', content: got.clean });
  }
  if (bailed) {
    skip++;
    console.log(`SKIP  ${c.id}  ${bailed}`);
    continue;
  }
  const fails = check(c.assert || {}, got);
  if (fails.length) {
    fail++;
    failures.push({ id: c.id, why: c.why, fails, reply: got.clean });
    console.log(`FAIL  ${c.id}  (${fails.length})`);
    for (const f of fails) console.log('        ' + f);
  } else {
    pass++;
    console.log(`pass  ${c.id}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped, of ${cases.length}`);
if (failures.length) {
  console.log('\n--- failing replies in full ---');
  for (const f of failures) {
    console.log(`\n[${f.id}] ${f.why}\n${f.reply}\n`);
  }
}
process.exit(fail ? 1 : 0);
