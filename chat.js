// Prompt Yourself — the live practice bot.
// A small chat window that talks to a Cloudflare Worker relay (see worker/).
// With no ENDPOINT configured, or when every free model's quota is spent,
// it degrades to the guide's own copy-paste prompt — the site's whole thesis.

(function () {
  // Set to the deployed Worker URL to bring the bots live. Empty = resting.
  var ENDPOINT = 'https://prompt-yourself-bot.andrewburke225.workers.dev';

  var host = document.getElementById('bot-chat');
  if (!host) return;
  var bot = host.dataset.bot; // 'tutor' | 'coach'
  var noun = bot === 'coach' ? 'coach' : 'tutor';
  var multimodal = bot === 'coach'; // voice + whiteboard: interview practice only

  // WHAT THE OPENER HAS TO CARRY CHANGED, so these did too.
  //
  // It used to ask for three things each, because the bots had nothing but the
  // conversation to go on. Two of the six are now measured better than they can
  // be self-reported, so asking for them is asking someone to guess at
  // something the system finds out:
  //   the tutor's "level" - the mastery gate learns it from the first check,
  //     and a failed check is evidence where "complete beginner" is a guess
  //   the coach's "weak spots" - the rubric scores all five dimensions of every
  //     answer, so the debrief reports a pattern instead of repeating a worry
  //
  // The remaining items got MORE load-bearing, not less, and the examples lead
  // with them. The tutor's topic is the grounding query, so no topic means no
  // reference to teach from. The coach's field is what roleHint reads, and
  // without it the role-tagged questions stay out of the pool entirely.
  var GREETINGS = {
    tutor:
      "I'm the tutor bot. Name a topic and what you want out of it, something like: " +
      "\"Compound interest, so I can work out what my savings account is actually doing.\"",
    coach:
      "I'm the interview bot. Tell me what you're interviewing for and a line on your background, something like: " +
      "\"Backend engineer, three years of Python and Postgres, interviewing for a mid-level platform role.\"",
  };

  // A returning visitor gets its own greeting rather than the new-visitor one
  // with a line bolted on the end. The old append contradicted itself: it asked
  // them to name a topic as though nothing had happened AND said it would carry
  // on from last time.
  var RETURNING = {
    tutor:
      "I'm the tutor bot, and we've done this before. I'll pick up from what was " +
      "still unfinished last time. Name a new topic instead if you'd rather move on.",
    coach: "Great to see you again! Let's pick up where we left off.",
  };

  // where the guide lives (its own page) — the resting button points there
  var GUIDE_URL = host.dataset.guide || './';

  // ---------- build the chat UI ----------
  var head = document.createElement('div');
  head.className = 'bc-head';
  var dot = document.createElement('span');
  dot.className = 'bc-dot';
  var headLabel = document.createElement('span');
  head.appendChild(dot);
  head.appendChild(headLabel);
  var headTools = document.createElement('span');
  headTools.className = 'bc-head-tools';
  head.appendChild(headTools);

  var msgs = document.createElement('div');
  msgs.className = 'bc-msgs';

  var form = document.createElement('form');
  form.className = 'bc-form';
  var input = document.createElement('textarea');
  input.className = 'bc-input';
  input.rows = 1;
  // one word - the long version wrapped and clipped inside the narrow
  // mobile input
  input.placeholder = 'Message…';
  input.setAttribute('aria-label', 'Your message');
  var send = document.createElement('button');
  send.type = 'submit';
  send.className = 'btn bc-send';
  send.textContent = 'Send';

  // whiteboard button — draw something and send it with your message
  var drawBtn = document.createElement('button');
  drawBtn.type = 'button';
  drawBtn.className = 'bc-icon';
  drawBtn.setAttribute('aria-label', 'Draw on a whiteboard');
  drawBtn.title = 'Draw';
  drawBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';

  // mic button — speak instead of type (browser speech-to-text, no server)
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var micBtn = null;
  if (SR && multimodal) {
    micBtn = document.createElement('button');
    micBtn.type = 'button';
    micBtn.className = 'bc-icon';
    micBtn.setAttribute('aria-label', 'Speak your answer');
    micBtn.title = 'Speak';
    micBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>';
  }

  form.appendChild(input);
  if (multimodal) form.appendChild(drawBtn);
  if (micBtn) form.appendChild(micBtn);
  form.appendChild(send);

  // attach strip: shows a thumbnail of the drawing waiting to be sent
  var attachRow = document.createElement('div');
  attachRow.className = 'bc-attach';
  attachRow.hidden = true;

  // sits under the input; only ever visible when the message is too long
  var capNotice = document.createElement('div');
  capNotice.className = 'bc-cap-notice';
  capNotice.hidden = true;

  // the whiteboard panel itself
  var wb = document.createElement('div');
  wb.className = 'bc-wb';
  wb.hidden = true;
  var canvas = document.createElement('canvas');
  canvas.width = 700;
  canvas.height = 380;
  var wbRow = document.createElement('div');
  wbRow.className = 'bc-wb-row';
  var wbClear = document.createElement('button');
  wbClear.type = 'button';
  wbClear.className = 'btn btn-quiet bc-wb-btn';
  wbClear.textContent = 'Clear';
  var wbCancel = document.createElement('button');
  wbCancel.type = 'button';
  wbCancel.className = 'btn btn-quiet bc-wb-btn';
  wbCancel.textContent = 'Cancel';
  var wbAttach = document.createElement('button');
  wbAttach.type = 'button';
  wbAttach.className = 'btn bc-wb-btn';
  wbAttach.textContent = 'Attach drawing';
  wbRow.appendChild(wbClear);
  wbRow.appendChild(wbCancel);
  wbRow.appendChild(wbAttach);
  wb.appendChild(canvas);
  wb.appendChild(wbRow);

  host.className = 'bot-chat';
  host.appendChild(head);
  host.appendChild(msgs);
  if (multimodal) {
    host.appendChild(attachRow);
    host.appendChild(wb);
  }
  host.appendChild(form);
  host.appendChild(capNotice);

  var history = []; // {role, content, image?} — greeting included for context
  var pendingImage = null;

  // ---------- session memory ----------
  // Everything below lives in THIS visitor's browser and is sent only as part
  // of their own next message. Nothing is stored on any server: the Worker is
  // stateless by design and there is no account, so localStorage is the only
  // place a profile can live without breaking that promise. Every read and
  // write is guarded because a private window throws on access rather than
  // returning empty.
  var STORE_KEY = 'py-' + bot + '-v1';
  function freshStore() {
    return bot === 'coach'
      ? { sessions: 0, asked: [], covered: {}, scores: [], best: null }
      : { sessions: 0, topics: {}, open: [], settled: [] };
  }
  function loadStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return freshStore();
      var v = JSON.parse(raw);
      var base = freshStore();
      for (var k in base) if (!(k in v)) v[k] = base[k];
      return v;
    } catch (e) {
      return freshStore();
    }
  }
  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {}
  }
  var store = loadStore();
  var priorSessions = store.sessions || 0;
  store.sessions = priorSessions + 1;
  saveStore();

  // ---------- the state line the bots emit ----------
  // Each reply ends with <<PY {...}>>, which is how the model reports what it
  // just did: the topic, whether a check passed, the rubric scores. The client
  // strips it before anything is displayed or stored, so the visitor never sees
  // it. A missing or malformed line is normal and simply means no update —
  // never a broken reply, because free-tier models will not comply every time.
  // STRIPPING CANNOT DEPEND ON THE MODEL GETTING THE SYNTAX RIGHT. Live replies
  // produced both of these, and the first version of this regex, which required
  // a closing >> around a well formed object, matched neither - so the raw
  // machinery went to the screen:
  //     <<PY {"topic":"personal budgeting","check":"none"}}     (no closing >>)
  //     <<PY>>                                                  (empty)
  // So the strip is deliberately greedy: anything from <<PY to the closing >>
  // or, failing that, to the end of the reply. Parsing is a separate, tolerant
  // step, because a marker we cannot read still has to disappear.
  var STATE_STRIP = /<<\s*PY\b[\s\S]*?(?:>>|$)/g;
  function parseState(chunk) {
    var open = chunk.indexOf('{');
    var close = chunk.lastIndexOf('}');
    if (open < 0 || close <= open) return null;
    var body = chunk.slice(open, close + 1);
    for (var i = 0; i < 3; i++) {
      try { return JSON.parse(body); } catch (e) {}
      // models overshoot the closing brace ("}}"), so peel one and retry
      body = body.replace(/\}\s*$/, '');
      if (body.charAt(body.length - 1) !== '}') body += '}';
    }
    return null;
  }
  function takeState(text) {
    var found = String(text).match(STATE_STRIP);
    var state = null;
    if (found) {
      for (var i = 0; i < found.length && !state; i++) state = parseState(found[i]);
    }
    var clean = String(text).replace(STATE_STRIP, '').trim();
    // If the reply was nothing but machinery there is genuinely nothing to
    // show. An empty bubble reads as broken and the raw marker reads as worse,
    // so it becomes a short human line that invites another go.
    if (!clean) clean = 'That came through empty on my end. Say that again?';
    return { clean: clean, state: state };
  }

  // ---------- grounding: Wikipedia, open CORS, no key, no account ----------
  // The free-tier models behind this are small, and a tutor that states a wrong
  // fact confidently is worse than no tutor. So the topic is looked up and the
  // summary is handed to the model to teach FROM. Fetched fresh per topic and
  // cached for the session; a slow or failed lookup is skipped rather than
  // waited on, because a late answer is worse than an ungrounded one.
  var WIKI_TIMEOUT_MS = 1800;
  var groundCache = {};
  var groundNow = null; // {title, extract, url} for the topic in play
  var reportedTopic = ''; // what the model says the subject is, from its state line
  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms);
      promise.then(function (v) {
        if (!done) { done = true; clearTimeout(t); resolve(v); }
      }, function () {
        if (!done) { done = true; clearTimeout(t); resolve(null); }
      });
    });
  }
  // Pull a searchable topic out of a conversational message. This is the whole
  // difficulty of grounding a chat: "I want to learn how photosynthesis works,
  // complete beginner" is not a search query. Measured against real openers,
  // handing that sentence straight to Wikipedia returns nothing from the title
  // search and outright garbage from the full-text one - "teach me about the
  // krebs cycle please" came back as Dan Rather. Stripping the instruction
  // wrapper first turns the same twelve openers into the right article.
  function topicOf(msg) {
    var t = String(msg || '').toLowerCase();
    // their own punctuation marks where the topic ends and the level and goal
    // begin; a comma followed by a pronoun is that same boundary in prose, and
    // so is one followed by "so", "because" or "and I" - "compound interest, so
    // I can work out my savings account" is a topic with a goal attached, and
    // without these the goal rode along and the search found the wrong article
    t = t.split(/[\u2014\u2013;\n]|(?:\s[-]\s)|,\s*(?=i\b|i'm|im\b|we\b|my\b|never\b|trying\b|so\b|because\b|and i\b|just\b)/)[0];
    t = t
      .replace(/\b(i(?:'| a)?m|i|we)?\s*(want|would like|wanna|need|hope|try(?:ing)?)\s+to\s+(learn|understand|know|study|get)\b/g, ' ')
      .replace(/\b(teach|explain|help|show|tell|walk)\s+(me|us)?\s*(about|through)?\b/g, ' ')
      .replace(/\b(how|what|why|when|where)\s+(do|does|did|is|are|was|were|can|could)?\b/g, ' ')
      .replace(/\b(can|could|would)\s+you\b/g, ' ')
      .replace(/\bi\s+(know|have|never)\b[^,.]*/g, ' ')
      .replace(/\b(complete|total|absolute)?\s*(beginner|novice|newbie|expert|intermediate|advanced)s?\b/g, ' ')
      .replace(/\b(basics|fundamentals|introduction|intro|crash course|overview|from scratch|for dummies|level)\b/g, ' ')
      .replace(/\b(please|thanks|thank you|pls)\b/g, ' ')
      .replace(/\b(work|works|working|mean|means)\b/g, ' ')
      .replace(/[?!.,:"']/g, ' ');
    var STOP = ('a an the and or of to in on for with about is are was were do does did my your our i we ' +
      'you it that this these those as at by from so but if then than very really just want need learn ' +
      'understand know study get me us please help explain teach tell show how what why when where which ' +
      'who be been being have has had will would can could should may might not no yes ok okay job ' +
      // continuations, which are the visitor saying "keep going", not a subject.
      // Without these, "go on" extracted to "go" and grounded the lesson on
      // Wikipedia's disambiguation page for the board game.
      'go going on next more continue sure yeah yep yes right thanks done ready start begin again ' +
      'another keep tell told said ask asked one two three first second last ' +
      'now today currently actually also still lets let us maybe perhaps really quite').split(' ');
    var words = t.split(/\s+/).filter(function (w) {
      return w && w.length > 1 && STOP.indexOf(w) < 0;
    });
    var out = words.slice(0, 5).join(' ').trim();
    // a single short scrap is noise, not a subject: searching it lands on a
    // disambiguation page and grounds the lesson on the wrong thing entirely
    if (out.length < 4) return '';
    return out;
  }
  function wikiJson(url) {
    // Wikipedia answers a throttled client with prose, not JSON, so parsing has
    // to be allowed to fail and simply mean "no grounding this turn"
    return fetch(url).then(function (r) {
      if (!r.ok) return null;
      return r.json().catch(function () { return null; });
    });
  }
  function wikiLookup(query) {
    var q = topicOf(query);
    if (!q) return Promise.resolve(null);
    if (groundCache[q] !== undefined) return Promise.resolve(groundCache[q]);
    var base = 'https://en.wikipedia.org/w/api.php?format=json&origin=*&namespace=0';
    return withTimeout(
      // the title search is precise and answers most openers; full text is the
      // fallback for a phrase with no article of its own ("offside rule soccer")
      wikiJson(base + '&action=opensearch&limit=1&search=' + encodeURIComponent(q))
        .then(function (d) {
          var title = d && d[1] && d[1][0];
          if (title) return title;
          return wikiJson(base + '&action=query&list=search&srlimit=1&srsearch=' + encodeURIComponent(q))
            .then(function (d2) {
              var hits = d2 && d2.query && d2.query.search;
              return (hits && hits[0] && hits[0].title) || null;
            });
        })
        .then(function (title) {
          if (!title) return null;
          return wikiJson(
            'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title)
          );
        })
        .then(function (d) {
          if (!d || !d.extract) return null;
          // "Go" and "Python" are disambiguation pages: a list of unrelated
          // meanings is worse than no reference at all, so it is refused here
          // regardless of how the query got there
          if (d.type && d.type !== 'standard') return null;
          return {
            title: d.title,
            // 700 chars is the useful part of a lead section and leaves room
            // for the profile inside the Worker's 4000-char message cap
            extract: String(d.extract).slice(0, 700),
            url: (d.content_urls && d.content_urls.desktop && d.content_urls.desktop.page) || '',
          };
        }),
      WIKI_TIMEOUT_MS
    ).then(function (v) {
      groundCache[q] = v;
      return v;
    });
  }

  // ---------- the question bank and the exemplar library ----------
  // Same mechanism the Worker already uses for prompts.json: static JSON on
  // Pages, fetched at request time. Same origin, so no CORS and no key. If
  // either fetch fails the bot keeps working with less: the coach invents its
  // own questions as before, and no exemplar is attached.
  var bank = null;
  var exemplars = null;
  function loadJson(name) {
    return withTimeout(
      fetch(name).then(function (r) { return r.ok ? r.json() : null; }),
      2500
    ).catch(function () { return null; });
  }
  if (bot === 'coach') loadJson('questions.json?v=1').then(function (d) { bank = d; });
  loadJson('exemplars.json?v=1').then(function (d) { exemplars = d; });

  // ---------- question selection, with coverage ----------
  // The point of a bank is not variety for its own sake: it is COVERAGE. Left
  // to itself the model recycles the same few questions and a session can end
  // without ever touching failure or ambiguity. Selection walks the least
  // covered competency first, never repeats a question this visitor has
  // already been asked, and steps difficulty up as the session goes on.
  // Role tags were inert until this existed: roleHint was declared, read once,
  // and never assigned, so every role-tagged question was eligible for
  // everyone and the nurse residency candidate could be handed "tell me about
  // a change you shipped that broke something". Guessed once from the opener,
  // where people say what they are interviewing for.
  // Order matters: the unambiguous phrases go first. "school" used to sit in
  // the teaching cues and caught "first job out of school", filing a new
  // graduate as a teacher, so it is gone - students are in schools too.
  var ROLE_CUES = [
    ['newgrad', /\b(new grad|newgrad|no experience|first job|entry level|senior year|final year|graduating|about to graduate)\b/],
    ['healthcare', /\b(nurs\w*|cna|rn\b|patient|clinical|hospital|medical|doctor|physician|paramedic|pharmac\w*|therapist|midwif\w*|ward|bedside)\b/],
    ['teaching', /\b(teach\w*|classroom|pupil|professor|lecturer|curricul\w*|grade team|principal|tutor\w*|educat\w*)\b/],
    ['swe', /\b(software|engineer\w*|developer|programm\w*|backend|back end|frontend|front end|devops|full stack|python|java|javascript|sql|api|platform)\b/],
    ['pm', /\b(product manager|product management|\bpm\b|roadmap|product owner)\b/],
    ['retail', /\b(retail|store|shift|cashier|barista|server|waiter|waitress|hospitality|customer service|front of house)\b/],
    ['finance', /\b(finance|financial|account\w*|audit\w*|bank\w*|cpa|bookkeep\w*|controller|treasury)\b/],
  ];
  var roleHint = '';
  function guessRole(text) {
    if (roleHint) return roleHint;  // the opener decides; later talk does not
    var t = ' ' + String(text || '').toLowerCase() + ' ';
    for (var i = 0; i < ROLE_CUES.length; i++) {
      if (ROLE_CUES[i][1].test(t)) { roleHint = ROLE_CUES[i][0]; return roleHint; }
    }
    return '';
  }
  function pickQuestion() {
    if (!bank || !bank.questions || !bank.questions.length) return null;
    var asked = store.asked || [];
    var covered = store.covered || {};
    var pool = bank.questions.filter(function (q) {
      if (asked.indexOf(q.id) >= 0) return false;
      if (!q.roles || q.roles.indexOf('any') >= 0) return true;
      // no role detected means the role-tagged ones stay out. Asking a
      // question written for another job is worse than asking one less.
      return roleHint ? q.roles.indexOf(roleHint) >= 0 : false;
    });
    if (!pool.length) return null;
    // warm up, then standard, then pressure - by how many have been asked
    var want = askedThisSession < 1 ? 1 : askedThisSession < 4 ? 2 : 3;
    var byDiff = pool.filter(function (q) { return q.difficulty === want; });
    if (byDiff.length) pool = byDiff;
    var least = null;
    pool.forEach(function (q) {
      var n = covered[q.competency] || 0;
      if (least === null || n < least) least = n;
    });
    var final = pool.filter(function (q) {
      return (covered[q.competency] || 0) === least;
    });
    return final[Math.floor(Math.random() * final.length)] || pool[0];
  }
  var askedThisSession = 0;
  var currentQ = null;

  // ---------- voice out ----------
  // The coach already listens; this makes it speak. A spoken question answered
  // out loud under a clock is the actual skill being practised, and typing at a
  // silent interviewer trains something else. Tutor stays silent: reading an
  // explanation at your own pace beats having it read to you.
  var TTS = 'speechSynthesis' in window;
  var voiceOn = false;
  var voiceBtn = null;
  if (TTS && multimodal) {
    try { voiceOn = localStorage.getItem('py-voice') !== 'off'; } catch (e) { voiceOn = true; }
    voiceBtn = document.createElement('button');
    voiceBtn.type = 'button';
    voiceBtn.className = 'bc-head-btn';
    function paintVoice() {
      voiceBtn.textContent = voiceOn ? 'voice on' : 'voice off';
      voiceBtn.setAttribute('aria-pressed', voiceOn ? 'true' : 'false');
      voiceBtn.title = voiceOn ? 'Stop reading questions aloud' : 'Read questions aloud';
    }
    paintVoice();
    voiceBtn.addEventListener('click', function () {
      voiceOn = !voiceOn;
      try { localStorage.setItem('py-voice', voiceOn ? 'on' : 'off'); } catch (e) {}
      if (!voiceOn) try { window.speechSynthesis.cancel(); } catch (e) {}
      paintVoice();
    });
  }
  function speak(text) {
    if (!TTS || !voiceOn || !multimodal) return;
    try {
      window.speechSynthesis.cancel();
      // the state line is already stripped; strip stray punctuation runs so it
      // does not read symbols aloud
      var u = new SpeechSynthesisUtterance(String(text).replace(/[*_`#>]/g, ''));
      u.rate = 1.02;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  // ---------- the answer clock ----------
  // Starts when the interviewer finishes asking and stops when the answer is
  // sent, so the elapsed time can be handed to the coach as evidence. It is
  // reported, not enforced: a hard cut-off would punish a good long answer,
  // while the number lets the coach say "that ran four minutes" and mean it.
  var clockEl = null;
  var clockStart = 0;
  var clockTimer = null;
  var lastAnswerSecs = 0;
  if (multimodal) {
    clockEl = document.createElement('span');
    clockEl.className = 'bc-clock';
    clockEl.hidden = true;
  }
  function fmtSecs(n) {
    var m = Math.floor(n / 60);
    var s2 = n % 60;
    return m ? m + ':' + (s2 < 10 ? '0' : '') + s2 : n + 's';
  }
  function clockGo() {
    if (!clockEl) return;
    clockStart = Date.now();
    clockEl.hidden = false;
    clockEl.classList.remove('over');
    function tick() {
      var secs = Math.round((Date.now() - clockStart) / 1000);
      clockEl.textContent = fmtSecs(secs);
      // 120s is the shape of a good behavioural answer, not a rule
      if (secs > 120) clockEl.classList.add('over');
    }
    tick();
    clearInterval(clockTimer);
    clockTimer = setInterval(tick, 1000);
  }
  function clockStop() {
    if (!clockEl || !clockStart) return 0;
    clearInterval(clockTimer);
    clockTimer = null;
    lastAnswerSecs = Math.round((Date.now() - clockStart) / 1000);
    clockStart = 0;
    clockEl.hidden = true;
    return lastAnswerSecs;
  }

  // ---------- the context block ----------
  // This is the whole grounding mechanism in one function: everything the model
  // needs that it cannot know on its own, assembled fresh and attached to the
  // visitor's LATEST message.
  //
  // Why the latest and not a leading system-ish turn: the Worker caps a
  // conversation at 20,000 characters and trims from the FRONT to get under it
  // (worker.js), so a context turn at the head is the first thing thrown away -
  // exactly at the end of a long session, which is when the debrief needs the
  // scores most. Riding on the last message it can never be trimmed.
  //
  // It is also kept OUT of `history`, so only one message ever carries it
  // instead of every past turn dragging its own stale copy through the cap.
  var CTX_CAP = 1600;
  function contextBlock() {
    var lines = [];
    if (bot === 'tutor') {
      if (groundNow) {
        lines.push('REFERENCE on "' + groundNow.title + '" (Wikipedia, teach from this and prefer it over memory):');
        lines.push(groundNow.extract);
      }
      var names = Object.keys(store.topics || {});
      if (priorSessions > 0 && names.length) {
        var seen = names.slice(-4).map(function (t) {
          var r = store.topics[t];
          return t + ' (' + (r.pass || 0) + ' checks passed, ' + (r.fail || 0) + ' missed)';
        });
        lines.push('LEARNER PROFILE, from ' + priorSessions + ' earlier session(s): ' + seen.join('; '));
      }
      if ((store.open || []).length) {
        lines.push('STILL UNRESOLVED from before, revisit before new material: ' + store.open.slice(-3).join('; '));
      }
      if ((store.settled || []).length) {
        lines.push('ALREADY UNDERSTOOD, do not re-teach: ' + store.settled.slice(-5).join('; '));
      }
      if (lastCheckFailed && exemplars && exemplars.tutor && exemplars.tutor.moves) {
        // a failed check is the one moment a worked example of remediation
        // earns its tokens, so it is attached then and not before
        var mv = exemplars.tutor.moves.filter(function (m) {
          return /fail|wrong|misconception|scaffold/i.test(m.trigger || '');
        })[0] || exemplars.tutor.moves[0];
        if (mv) lines.push('EXAMPLE of handling a failed check - student: "' + mv.student + '" tutor: "' + mv.tutor + '"');
      }
    } else {
      if (currentQ) {
        lines.push('ASK THIS QUESTION NEXT, close to word for word: "' + currentQ.text + '"');
        var looks = currentQ.looks_for || 'a clear situation, their own actions, a real result';
        lines.push('It tests ' + currentQ.competency + '. A strong answer shows: ' +
          looks.replace(/\.\s*$/, '') + '.');
        if ((currentQ.followups || []).length) {
          lines.push('If the answer is strong, press with: "' + currentQ.followups[0] + '"');
        }
        lines.push('Report this question id in your state line: ' + currentQ.id);
      }
      var cov = Object.keys(store.covered || {});
      if (cov.length) {
        lines.push('COVERED so far: ' + cov.map(function (c) { return c + ' x' + store.covered[c]; }).join(', ') + '. Do not drift back to these while others are untouched.');
      }
      if (lastAnswerSecs) {
        lines.push('They took ' + lastAnswerSecs + ' seconds to answer aloud. Mention pacing only if it is notably long (over two minutes) or clipped (under twenty seconds).');
      }
      if (askedThisSession >= 5) {
        lines.push('This is question ' + (askedThisSession + 1) + '. Close with the debrief soon, and cite the rubric scores you have been giving.');
      }
      if (lastWeak && exemplars && exemplars.coach && exemplars.coach.answers) {
        var pool = exemplars.coach.answers;
        // prefer the same competency; any strong answer still shows the shape
        var ex = pool.filter(function (a) {
          return currentQ && a.competency === currentQ.competency;
        })[0] || pool[Math.floor(Math.random() * pool.length)];
        if (ex) lines.push('EXAMPLE of the same story told well: "' + ex.strong + '"');
      }
    }
    if (!lines.length) return '';
    var out = 'SESSION CONTEXT, from the site and not from them - use it, never quote it back or mention it:\n' + lines.join('\n');
    return out.length > CTX_CAP ? out.slice(0, CTX_CAP) : out;
  }
  var lastCheckFailed = false;
  var lastWeak = false;
  var lastUserText = '';   // what they actually sent, for judging the state line

  // A message that is only "go on" is not an attempt at anything. The prompt
  // says so now, but the prompt is advice and this is enforcement: a phantom
  // fail writes a misconception into a durable profile, and a phantom score
  // pollutes the rubric trend, so neither is accepted on the client's say-so.
  // Token based rather than phrase based, because the real message was "Go
  // ahead, start me off" and a fixed list of phrases will always be one comma
  // behind. If every word is a continuation word, nothing was attempted.
  var GO_WORDS = ('go on ahead onward carry start started starting me off again next more continue ' +
    'ok okay sure yes yeah yep ready begin keep going please do sounds good great fine ' +
    'lets let us now then and so i im ill will you can just').split(' ');
  function isNonAttempt(t) {
    var words = String(t || '').toLowerCase().replace(/[^a-z\s']/g, ' ')
      .split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 8) return false;
    for (var i = 0; i < words.length; i++) {
      if (GO_WORDS.indexOf(words[i].replace(/'/g, '')) < 0) return false;
    }
    return true;
  }
  function wordCount(t) {
    return String(t || '').split(/\s+/).filter(Boolean).length;
  }

  // ---------- learning from the state line ----------
  // Defensive throughout: this is a free-tier model's self-report, so every
  // field is treated as absent until it proves otherwise. A wrong or missing
  // field costs an update, never a broken session.
  function applyState(st) {
    if (!st || typeof st !== 'object') return;
    if (bot === 'tutor') {
      var topic = typeof st.topic === 'string' ? st.topic.slice(0, 60).trim() : '';
      if (topic) {
        store.topics = store.topics || {};
        store.topics[topic] = store.topics[topic] || { pass: 0, fail: 0 };
      }
      if (topic) reportedTopic = topic;
      var check = st.check === 'pass' || st.check === 'fail' ? st.check : 'none';
      // measured: handed "Go ahead, start me off" the tutor reported a failed
      // check and invented a mistake. Short answers are legitimate here
      // ("carbon dioxide"), so the guard is on non-attempts, not on length.
      if (check === 'fail' && isNonAttempt(lastUserText)) check = 'none';
      lastCheckFailed = check === 'fail';
      if (topic && check === 'pass') store.topics[topic].pass++;
      if (topic && check === 'fail') store.topics[topic].fail++;
      var mis = typeof st.misconception === 'string' ? st.misconception.slice(0, 120).trim() : '';
      store.open = store.open || [];
      store.settled = store.settled || [];
      if (mis && check === 'fail' && store.open.indexOf(mis) < 0) {
        store.open.push(mis);
        if (store.open.length > 8) store.open.shift();
      }
      if (check === 'pass' && store.open.length) {
        // a passed check settles the thing it was checking
        var settled = mis && store.open.indexOf(mis) >= 0 ? mis : store.open[store.open.length - 1];
        store.open = store.open.filter(function (x) { return x !== settled; });
        if (store.settled.indexOf(settled) < 0) store.settled.push(settled);
        if (store.settled.length > 12) store.settled.shift();
      }
      saveStore();
      return;
    }
    // coach
    var qid = typeof st.qid === 'string' ? st.qid : '';
    store.asked = store.asked || [];
    store.covered = store.covered || {};
    store.scores = store.scores || [];
    if (qid && store.asked.indexOf(qid) < 0) {
      store.asked.push(qid);
      askedThisSession++;
      var comp = (currentQ && currentQ.id === qid && currentQ.competency) ||
        (typeof st.competency === 'string' ? st.competency : '');
      if (comp) store.covered[comp] = (store.covered[comp] || 0) + 1;
    }
    var sc = st.scores;
    // measured: it sent scores for "A mix, please". A behavioural answer is
    // never four words, so a short turn cannot have been scored.
    if (sc && (wordCount(lastUserText) < 12 || isNonAttempt(lastUserText))) sc = null;
    if (sc && typeof sc === 'object') {
      var dims = ['star', 'specific', 'impact', 'ownership', 'concision'];
      var clean = {};
      var total = 0;
      var any = false;
      dims.forEach(function (d) {
        var v = Number(sc[d]);
        if (isFinite(v)) {
          clean[d] = Math.max(0, Math.min(2, Math.round(v)));
          total += clean[d];
          any = true;
        }
      });
      if (any) {
        store.scores.push({
          session: store.sessions,
          qid: qid || null,
          competency: (currentQ && currentQ.competency) || null,
          scores: clean,
          seconds: lastAnswerSecs || null,
        });
        if (store.scores.length > 200) store.scores.shift();
        // a weak answer is what earns an exemplar on the next turn
        lastWeak = total <= 5;
        if (store.best === null || total > store.best) store.best = total;
      }
    }
    // hand the next question forward so it is in context before it is needed
    if (qid) {
      var next = pickQuestion();
      if (next) currentQ = next;
    }
    saveStore();
  }

  // ---------- progress across sessions ----------
  // The reason to keep any of this is that the visitor can see it. A score with
  // no trend is a number; a score next to last session's is a reason to come
  // back. Rendered into the transcript on demand, never sent anywhere.
  function progressText() {
    if (bot === 'coach') {
      var sc = store.scores || [];
      if (!sc.length) return 'No scored answers yet. Answer a question and I will score it.';
      var dims = ['star', 'specific', 'impact', 'ownership', 'concision'];
      var mean = function (arr, d) {
        var v = arr.map(function (x) { return (x.scores && x.scores[d]) || 0; });
        return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : 0;
      };
      var thisS = sc.filter(function (x) { return x.session === store.sessions; });
      var prev = sc.filter(function (x) { return x.session === store.sessions - 1; });
      var out = ['Answers scored this session: ' + thisS.length + '. All time: ' + sc.length + '.'];
      dims.forEach(function (d) {
        var a = mean(thisS, d);
        var line = '  ' + d + ': ' + a.toFixed(1) + ' of 2';
        if (prev.length) {
          var b = mean(prev, d);
          var delta = a - b;
          line += '  (last session ' + b.toFixed(1) + ', ' +
            (delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : 'flat') + ')';
        }
        out.push(line);
      });
      var cov = Object.keys(store.covered || {});
      if (cov.length) out.push('Competencies practised: ' + cov.join(', ') + '.');
      var miss = (bank && bank.competencies ? bank.competencies : []).filter(function (c) {
        return !(store.covered || {})[c];
      });
      if (miss.length) out.push('Not yet touched: ' + miss.join(', ') + '.');
      return out.join('\n');
    }
    var names = Object.keys(store.topics || {});
    if (!names.length) return 'Nothing tracked yet. Name a topic and I will start keeping score.';
    var out2 = ['Sessions: ' + store.sessions + '.'];
    names.forEach(function (t) {
      var r = store.topics[t];
      out2.push('  ' + t + ': ' + (r.pass || 0) + ' checks passed, ' + (r.fail || 0) + ' missed');
    });
    if ((store.settled || []).length) out2.push('Settled: ' + store.settled.join('; '));
    if ((store.open || []).length) out2.push('Still open: ' + store.open.join('; '));
    return out2.join('\n');
  }

  // ---------- whiteboard behavior ----------
  var ctx = canvas.getContext('2d');
  function wbBlank() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }
  var drawing = false;
  function wbPoint(e) {
    var r = canvas.getBoundingClientRect();
    return [
      (e.clientX - r.left) * (canvas.width / r.width),
      (e.clientY - r.top) * (canvas.height / r.height),
    ];
  }
  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    drawing = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    var p = wbPoint(e);
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[0] + 0.1, p[1] + 0.1);
    ctx.stroke();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!drawing) return;
    var p = wbPoint(e);
    ctx.lineTo(p[0], p[1]);
    ctx.stroke();
  });
  canvas.addEventListener('pointerup', function () { drawing = false; });
  drawBtn.addEventListener('click', function () {
    wb.hidden = !wb.hidden;
    if (!wb.hidden && !canvas.dataset.inited) {
      wbBlank();
      canvas.dataset.inited = '1';
    }
  });
  wbClear.addEventListener('click', wbBlank);
  wbCancel.addEventListener('click', function () { wb.hidden = true; });
  function clearAttachment() {
    pendingImage = null;
    attachRow.hidden = true;
    attachRow.innerHTML = '';
  }
  // one pipeline for resume files, fed by the upload button and drag-and-drop
  var uploadRow = null;
  function handleResumeFile(f) {
    if (!f || !form.isConnected) return;
    if (f.size > 3 * 1024 * 1024) {
      addBot('That file is over 3 MB — export a smaller version and try again.');
      return;
    }
    function finish() {
      if (uploadRow) { uploadRow.remove(); uploadRow = null; }
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
    if (/\.txt$/i.test(f.name) || f.type === 'text/plain') {
      f.text().then(function (t) {
        input.value = 'Here is my resume:\n' + t.slice(0, 3500);
        finish();
      });
      return;
    }
    if (!/pdf|png|jpe?g/i.test(f.type + ' ' + f.name)) {
      addBot('I can read PDF, PNG, JPG, or TXT resumes.');
      return;
    }
    var rd = new FileReader();
    rd.onload = function () {
      pendingImage = rd.result; // a PDF or image rides the drawing rails
      input.value = 'Here is my resume. Use it as my background for this interview.';
      finish();
    };
    rd.readAsDataURL(f);
  }
  if (multimodal) {
    var dragDepth = 0;
    host.addEventListener('dragenter', function (e) {
      e.preventDefault();
      dragDepth++;
      host.classList.add('bc-dropping');
    });
    host.addEventListener('dragover', function (e) { e.preventDefault(); });
    host.addEventListener('dragleave', function () {
      dragDepth--;
      if (dragDepth <= 0) { dragDepth = 0; host.classList.remove('bc-dropping'); }
    });
    host.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      host.classList.remove('bc-dropping');
      handleResumeFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });
  }

  wbAttach.addEventListener('click', function () {
    pendingImage = canvas.toDataURL('image/png');
    wb.hidden = true;
    attachRow.innerHTML = '';
    var thumb = document.createElement('img');
    thumb.src = pendingImage;
    thumb.alt = 'your drawing';
    var label = document.createElement('span');
    label.textContent = 'drawing attached — sends with your next message';
    var x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Remove drawing');
    x.addEventListener('click', clearAttachment);
    attachRow.appendChild(thumb);
    attachRow.appendChild(label);
    attachRow.appendChild(x);
    attachRow.hidden = false;
    input.focus();
  });

  // ---------- voice input ----------
  if (micBtn) {
    var rec = null;
    var listening = false;
    micBtn.addEventListener('click', function () {
      if (listening) {
        rec.stop();
        return;
      }
      rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = document.documentElement.lang || 'en-US';
      var base = input.value ? input.value.replace(/\s+$/, '') + ' ' : '';
      var finals = '';
      rec.onresult = function (ev) {
        var interim = '';
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) finals += ev.results[i][0].transcript;
          else interim += ev.results[i][0].transcript;
        }
        input.value = base + finals + interim;
        autogrow();
      };
      rec.onend = function () {
        listening = false;
        micBtn.classList.remove('listening');
        input.focus();
      };
      rec.onerror = function () {
        listening = false;
        micBtn.classList.remove('listening');
      };
      rec.start();
      listening = true;
      micBtn.classList.add('listening');
    });
  }

  var lastProvider = '';

  function setStatus(live) {
    dot.className = 'bc-dot' + (live ? '' : ' resting');
    headLabel.textContent = live
      ? 'session active' + (lastProvider ? ' (' + lastProvider + ')' : '')
      : 'session resting';
  }

  function render(text) {
    // minimal, safe formatting: escape, then **bold**, `code`, line breaks
    var s = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  function addBot(text) {
    var d = document.createElement('div');
    d.className = 'bc-bot';
    d.innerHTML = render(text);
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  function addUser(text, image) {
    var d = document.createElement('div');
    d.className = 'bc-user';
    if (image && image.indexOf('data:application/pdf') === 0) {
      var fileChip = document.createElement('span');
      fileChip.className = 'bc-user-file';
      fileChip.textContent = '\ud83d\udcc4 resume (PDF)';
      d.appendChild(fileChip);
    } else if (image) {
      var img = document.createElement('img');
      img.className = 'bc-user-img';
      img.src = image;
      img.alt = 'your drawing';
      d.appendChild(img);
    }
    d.appendChild(document.createTextNode(text));
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function addTyping() {
    var d = document.createElement('div');
    d.className = 'bc-bot bc-typing';
    d.innerHTML = '<span></span><span></span><span></span>';
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
    return d;
  }

  function addFallback(intro) {
    var wrap = document.createElement('div');
    wrap.className = 'bc-bot bc-fallback';
    var p = document.createElement('p');
    p.innerHTML = render(intro);
    wrap.appendChild(p);
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
  }

  var RESTING_MSG =
    'the free bot is resting — take a look at the guide below to create your own.';
  var LIMIT_MSG =
    'you’ve hit the hourly limit for the free bot — take a look at the guide below to create your own.';

  // collapse: the bot is out of service, so the chat shrinks to the resting
  // message, typing goes away entirely, and the guide opens below.
  function collapse(message) {
    setStatus(false);
    msgs.innerHTML = ''; // the resting line replaces the whole transcript
    addFallback(message);
    form.remove();
    // the guide button takes the bridge line's spot below the box
    var go = document.createElement('a');
    go.className = 'btn bc-go';
    go.href = GUIDE_URL;
    go.textContent = 'Go prompt yourself.';
    var bridge = document.querySelector('.guide-bridge');
    if (bridge) bridge.replaceWith(go);
    else host.insertAdjacentElement('afterend', go);
  }

  // ---------- start ----------
  // Before greeting, ask the Worker whether the bot can actually serve this
  // visitor. Arriving mid-outage collapses straight to the guide — no dead
  // greeting, no input that goes nowhere. (An old Worker without the status
  // endpoint answers with neither flag, which reads as live.)

  function goLive() {
    setStatus(true);
    if (clockEl) headTools.appendChild(clockEl);
    if (voiceBtn) headTools.appendChild(voiceBtn);
    var progBtn = document.createElement('button');
    progBtn.type = 'button';
    progBtn.className = 'bc-head-btn';
    progBtn.textContent = 'progress';
    progBtn.title = bot === 'coach'
      ? 'Your rubric scores and how they compare with last session'
      : 'What you have covered and what is still open';
    progBtn.addEventListener('click', function () {
      var d = addBot(progressText());
      d.classList.add('bc-report');
    });
    headTools.appendChild(progBtn);
    var greeting = priorSessions > 0
      ? (RETURNING[bot] || RETURNING.tutor)
      : (GREETINGS[bot] || GREETINGS.tutor);
    if (bot === 'coach') {
      currentQ = pickQuestion();   // ready before the first answer arrives
    }
    var greetEl = addBot(greeting);
    history.push({ role: 'assistant', content: greeting });
    if (!multimodal) return;

    // The resume is only worth asking for once. A returning candidate already
    // handed theirs over, or decided not to, and being asked again on every
    // visit reads as the site having forgotten them - which is the opposite of
    // what the profile is for. So they get one small way out instead, and the
    // upload only comes back if they say the job has changed.
    function showUpload() {
      var up = document.createElement('div');
      var upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'bc-upload';
      upBtn.textContent = 'or save time by dropping your resume here';
      var fileIn = document.createElement('input');
      fileIn.type = 'file';
      fileIn.accept = '.pdf,.png,.jpg,.jpeg,.txt';
      fileIn.hidden = true;
      upBtn.addEventListener('click', function () { fileIn.click(); });
      fileIn.addEventListener('change', function () {
        handleResumeFile(fileIn.files && fileIn.files[0]);
      });
      up.appendChild(upBtn);
      up.appendChild(fileIn);
      msgs.appendChild(up);
      msgs.scrollTop = msgs.scrollHeight;
      uploadRow = up;
    }

    if (priorSessions < 1) {
      showUpload();
      return;
    }

    var switchRow = document.createElement('div');
    var switchBtn = document.createElement('button');
    switchBtn.type = 'button';
    switchBtn.className = 'bc-upload bc-switch';
    switchBtn.textContent = "I'm interviewing for something different";
    switchBtn.addEventListener('click', function () {
      // Becomes a first-time session in everything the candidate can see: the
      // greeting on screen is replaced rather than added to, so the transcript
      // does not keep a welcome back that no longer applies. History is
      // rewritten with it too, or the model would still be working from a
      // greeting the visitor cannot see.
      var fresh = GREETINGS.coach;
      greetEl.innerHTML = render(fresh);
      for (var i = 0; i < history.length; i++) {
        if (history[i].role === 'assistant') { history[i].content = fresh; break; }
      }
      switchRow.remove();
      showUpload();
      input.focus();
    });
    switchRow.appendChild(switchBtn);
    msgs.appendChild(switchRow);
    msgs.scrollTop = msgs.scrollHeight;
  }

  if (!ENDPOINT) {
    collapse(RESTING_MSG);
  } else {
    var boot = addTyping();
    fetch(ENDPOINT, { method: 'GET' })
      .then(function (res) { return res.json(); })
      .then(function (s) {
        boot.remove();
        if (s && s.limits && s.limits.messageChars > 0) msgCap = s.limits.messageChars;
        if (s.limited) collapse(LIMIT_MSG);
        else if (s.resting) collapse(RESTING_MSG);
        else goLive();
      })
      .catch(function () {
        boot.remove();
        collapse(RESTING_MSG);
      });
  }

  var pending = false;

  // The Worker truncates an over-long message by slicing it, with nothing said
  // to the visitor, so a pasted resume lost its tail in silence. It now reports
  // its own caps on the health check and the page warns BEFORE sending rather
  // than letting the text vanish. Until a Worker that reports them is deployed
  // the old 4000 is assumed, so the warning is never wrong in the direction
  // that matters.
  var msgCap = 4000;
  var capNoticeShown = false;
  function checkLength() {
    if (input.value.length <= msgCap) {
      if (capNotice) capNotice.hidden = true;
      return;
    }
    if (!capNotice) return;
    capNotice.hidden = false;
    capNotice.textContent =
      'That is ' + input.value.length.toLocaleString() + ' characters and only the first ' +
      msgCap.toLocaleString() + ' will be sent. Trim it, or send it in two goes.';
    capNoticeShown = true;
  }

  function autogrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 128) + 'px';
  }
  input.addEventListener('input', autogrow);
  input.addEventListener('input', checkLength);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (pending || !ENDPOINT) return;
    var text = input.value.trim();
    if (!text && !pendingImage) return;
    if (!text) text = 'Here is my drawing.';
    var image = pendingImage;
    clearAttachment();
    input.value = '';
    autogrow();
    checkLength();
    addUser(text, image);
    var msg = { role: 'user', content: text };
    if (image) msg.image = image;
    history.push(msg);

    pending = true;
    send.disabled = true;
    lastUserText = text;
    clockStop();                 // they have answered; the clock is evidence now
    if (bot === 'coach' && !roleHint) {
      guessRole(text);
      var reQ = pickQuestion();  // re-pick now that the role is known
      if (reQ) currentQ = reQ;
    }
    var typing = addTyping();

    // Ground the topic before asking. The tutor looks the subject up so it can
    // teach from a source rather than from whatever the free-tier model half
    // remembers. A different top hit means the visitor changed subject, which
    // is the only signal needed to re-ground.
    // Extraction handles the opener; from then on the model's own reported
    // topic is the better query, because it is already the canonical name of
    // the subject. A message with no extractable topic ("go on", "yes") keeps
    // whatever is already grounded instead of dropping it.
    var query = topicOf(text) || reportedTopic;
    var prep = bot === 'tutor' && query
      ? wikiLookup(query).then(function (g) {
          if (g && (!groundNow || g.title !== groundNow.title)) groundNow = g;
        })
      : Promise.resolve();

    prep.then(function () {
      // the payload carries at most one drawing: the latest
      var recent = history.slice(-16);
      var payload = recent.map(function (m, i) {
        return i === recent.length - 1 && m.image
          ? m
          : { role: m.role, content: m.content };
      });
      // context rides on the last message so the Worker's front-trim can never
      // drop it, and never enters `history` so it is carried exactly once
      var ctxText = contextBlock();
      if (ctxText && payload.length) {
        var last = payload[payload.length - 1];
        payload[payload.length - 1] = {
          role: last.role,
          content: last.content + '\n\n' + ctxText,
          image: last.image,
        };
        if (!last.image) delete payload[payload.length - 1].image;
      }

      return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bot: bot, messages: payload }),
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      })
      .then(function (r) {
        typing.remove();
        if (r.ok && r.data.reply) {
          if (r.data.provider) {
            lastProvider = r.data.provider;
            setStatus(true);
          }
          var got = takeState(r.data.reply);
          applyState(got.state);
          addBot(got.clean);
          history.push({ role: 'assistant', content: got.clean });
          speak(got.clean);
          if (multimodal) clockGo();   // their turn: the clock starts again
        } else if (r.status === 429) {
          collapse(LIMIT_MSG);
        } else if (r.data && r.data.error === 'image_unavailable') {
          addBot("I can't see drawings right now — describe it in words instead.");
        } else {
          collapse(RESTING_MSG);
        }
      })
      .catch(function () {
        typing.remove();
        collapse(RESTING_MSG);
      })
      .finally(function () {
        pending = false;
        send.disabled = false;
      });
    });
  });
})();
