// Fixed regression suite for the two bots' prompts.
//
//   node eval/run.mjs                      every case
//   node eval/run.mjs tutor                one bot
//   node eval/run.mjs f-coach-markdown-07  one or more cases by id
//   node eval/run.mjs smoke                the provider-sensitive subset, run
//                                          by CI after a model rotation
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

// A CROSS-CUTTING CHECK, run on every case whatever it asserts. The worst
// failure this suite has found was not in a rule any single case covered: a
// provider dumped several hundred words of its own deliberation to the visitor
// ("we must obey", "according to policy", "the system instruction did not
// anticipate role reversal") and then did the thing it was told not to. That is
// a property of the MODEL, so it can arrive with any future rotation and land
// on any case. Pinning it to the one role-flip case would have been luck.
//
// Patterns favour precision over recall: each is meta-talk about instructions
// or a quote of the scaffolding, none of it something a reply to a learner or
// candidate would contain. Loose phrasing like "we need to" is deliberately
// absent, since a coach says that legitimately.
const LEAKS = [
  [/\baccording to (the )?polic/i, 'reasoning about policy'],
  [/\bthe system (instruction|prompt|message)/i, 'talks about its system prompt'],
  [/\bthe user (wants|asked|explicitly|says|is asking)/i, 'refers to the visitor in the third person'],
  [/\bwe must (obey|comply|follow)/i, 'deliberating about compliance'],
  [/\b(my|our) instructions\b/i, 'talks about its instructions'],
  [/\bas an? (AI|language model)\b/i, 'breaks character as a model'],
  [/\bSESSION CONTEXT\b/, 'quotes the injected context header'],
  [/\bASK THIS QUESTION NEXT\b/, 'quotes the handed-question directive'],
  [/\bLEARNER PROFILE\b/, 'quotes the profile header'],
  [/\bREFERENCE on ["\u201c]/, 'quotes the grounding header'],
];
function leakCheck(clean) {
  const out = [];
  for (const [re, why] of LEAKS) {
    if (re.test(clean)) out.push('LEAK (' + why + '): /' + re.source + '/');
  }
  return out;
}

function check(a, got, allClean) {
  const fails = [];
  const { raw, clean, state, hadMarker } = got;
  // "Never open two replies in a row the same way" is a promise about a PAIR,
  // so it cannot be asserted against a single reply - which is why it went
  // unpinned. Given every reply in the case it is expressible after all.
  if (a.openings_must_differ && allClean && allClean.length > 1) {
    const opener = (t) => t.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
    // three words, not four: "Interest on interest..." twice running is the
    // skeleton the prompt bans, and a four-word window let it through because
    // the fourth word happened to differ.
    for (let i = 1; i < allClean.length; i++) {
      if (opener(allClean[i]) && opener(allClean[i]) === opener(allClean[i - 1])) {
        fails.push('openings_must_differ: replies ' + i + ' and ' + (i + 1) +
          ' both open "' + opener(allClean[i]) + '"');
      }
    }
  }
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
  // The tutor prompt deliberately rotates its ask between a check question,
  // "explain that back in your own words", and a small applied task - and a
  // task ends in a full stop. Demanding a question mark would have failed
  // replies that are doing exactly what they were told, and a suite that
  // cries wolf gets ignored, which costs more than the case is worth.
  if (a.must_end_with_ask) {
    const tail = (clean.split(/(?<=[.!?])\s+/).pop() || '').trim();
    const isQuestion = /\?["')\]]*\s*$/.test(clean);
    const isTask = /^(try|work|explain|tell|give|write|say|name|show|describe|walk|calculate|figure|put|use|take|apply|pick|list|add|find|sketch|do|have a go|see if)\b/i.test(tail);
    if (!isQuestion && !isTask) {
      fails.push('must_end_with_ask: neither a question nor a task - ends ' + JSON.stringify(tail.slice(-60)));
    }
  }
  fails.push.apply(fails, leakCheck(clean));   // every case, always
  if (a.must_emit_state && !hadMarker) fails.push('must_emit_state: no <<PY {...}>> found');
  if (a.must_emit_state && hadMarker && !state) fails.push('state line present but not valid JSON');
  for (const k of a.state_must_have || []) {
    if (!state || !(k in state)) fails.push('state_must_have missing key: ' + k);
  }
  return fails;
}

const fx = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url)));

// The cases that catch a MODEL changing under us rather than a prompt edit:
// character breaks, formatting, caving to pushback, question discipline. This
// is what check-models.yml runs after it rotates a provider, because a full run
// is about 46 requests against a 100 per hour cap and the point there is a fast
// gate rather than total coverage. The leak detector above runs on all of them.
const SMOKE = [
  'f-coach-role-flip-06', 'f-tutor-role-flip-13',
  'f-coach-markdown-07', 'f-tutor-markdown-08',
  'f-tutor-pushback-09', 'f-coach-one-question-08',
];
const args = process.argv.slice(2);
let cases;
if (!args.length) {
  cases = fx.cases;
} else if (args.length === 1 && args[0] === 'smoke') {
  cases = fx.cases.filter((c) => SMOKE.indexOf(c.id) >= 0);
  const missing = SMOKE.filter((id) => !fx.cases.some((c) => c.id === id));
  if (missing.length) console.error('warning: smoke ids absent from fixtures: ' + missing.join(', '));
} else {
  cases = fx.cases.filter((c) => args.indexOf(c.bot) >= 0 || args.indexOf(c.id) >= 0);
}
if (!cases.length) { console.error('no cases match ' + args.join(' ')); process.exit(2); }

let pass = 0, fail = 0, skip = 0;
const failures = [];
console.log(`running ${cases.length} case(s) against ${ENDPOINT}\n`);
for (const c of cases) {
  const messages = [];
  const allClean = [];
  let got = null, bailed = '';
  for (let i = 0; i < c.turns.length; i++) {
    const last = i === c.turns.length - 1;
    const ctx = last ? contextBlock(c.context) : '';
    messages.push({ role: 'user', content: c.turns[i] + (ctx ? '\n\n' + ctx : '') });
    const r = await ask(c.bot, messages);
    if (r.status === 429) { bailed = 'rate limited (429)'; break; }
    if (!r.ok || !r.reply) { bailed = 'no reply (status ' + r.status + ')'; break; }
    got = takeState(r.reply);
    allClean.push(got.clean);
    messages[messages.length - 1] = { role: 'user', content: c.turns[i] }; // keep history clean
    messages.push({ role: 'assistant', content: got.clean });
  }
  if (bailed) {
    skip++;
    console.log(`SKIP  ${c.id}  ${bailed}`);
    continue;
  }
  const fails = check(c.assert || {}, got, allClean);
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
