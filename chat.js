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
      "\"The nitrogen cycle, I have a Biology test on Friday.\"",
    coach:
      // Two lines, like the tutor's. The tutor line is the budget - 927px in
      // the loaded serif - and the coach's example is inherently longer than
      // "a Biology test on Friday", so the framing pays for it: "something
      // like:" goes and the colon introduces the example instead. Checked
      // against Source Serif 4 AND the Georgia/Times fallbacks, since a 5px
      // margin in the webfont becomes a third line when the webfont fails.
      "I'm the interview bot. Name the role and your background: " +
      "\"Staff engineer role, three years as a senior backend engineer.\"",
  };

  // A returning visitor gets its own greeting rather than the new-visitor one
  // with a line bolted on the end. The old append contradicted itself: it asked
  // them to name a topic as though nothing had happened AND said it would carry
  // on from last time.
  var RETURNING = {
    tutor: "Great to see you again! Let's pick up where we left off.",
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

  // Words, not an icon. No glyph says "stop typing and have a conversation" -
  // a microphone says dictate, a headset says support call - so it says what it
  // does. It sits INSIDE the message box, against the right edge, because that
  // is where the eye already is when someone is deciding whether to type.
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var micBtn = null;
  if (SR && multimodal) {
    micBtn = document.createElement('button');
    micBtn.type = 'button';
    micBtn.className = 'bc-hands';
    micBtn.textContent = 'talk instead';
  }

  // the input and the talk button share a wrapper so the button can sit inside
  // the box's border rather than beside it
  var inputWrap = document.createElement('div');
  inputWrap.className = 'bc-input-wrap';
  inputWrap.appendChild(input);
  if (micBtn) inputWrap.appendChild(micBtn);
  form.appendChild(inputWrap);
  if (multimodal) form.appendChild(drawBtn);
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
  wbAttach.textContent = 'Submit';
  // cancel, clear, submit: leaving first, then undoing, then committing, which
  // is the order of increasing consequence
  wbRow.appendChild(wbCancel);
  wbRow.appendChild(wbClear);
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
  // out loud is the actual skill being practised, and typing at a
  // silent interviewer trains something else. Tutor stays silent: reading an
  // explanation at your own pace beats having it read to you.
  // ---------- hands-free conversation ----------
  // The old control was a voice-on toggle, which read questions aloud while
  // the candidate still typed and still pressed send. That trains the wrong
  // thing: a real interview is spoken both ways, and stopping to type between
  // answers is the part that does not happen on the day.
  //
  // So this is a mode, not a setting. It listens, notices when they have
  // stopped talking, sends on its own, speaks the reply, and listens again.
  // Nobody touches the keyboard until they end it. Reading a reply at your own
  // pace is the better experience everywhere else, so the bot is silent
  // outside this mode and there is no separate switch for it.
  var TTS = 'speechSynthesis' in window;
  // The Worker can serve a chosen ElevenLabs voice, which beats whatever the
  // visitor's machine happens to have installed. Remote first, local as the
  // safety net - never the other way round, and never remote-only: a spent
  // quota must cost the nice voice, not the conversation.
  var ttsRemote = !!ENDPOINT;
  var ttsAudio = null;

  // ---------- which voice ----------
  // The browser can only offer what the visitor's own machine has installed,
  // so this cannot be one hard-coded name: a choice made here would silently
  // fall back to whatever the next machine defaults to, which on a Mac is
  // Samantha and sounds two decades old. So there is a preference order, a
  // per-visitor override, and a picker that speaks a sample on change, because
  // "Reed" and "Flo" tell nobody anything until they hear them.
  //
  // macOS ships a pile of novelty voices - Bells, Boing, Zarvox, Bubbles - that
  // sing or joke rather than speak. Whatever they are for, it is not conducting
  // an interview, so they are kept out of the list entirely.
  var VOICE_NOVELTY = /^(bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|fred|junior|ralph|kathy|grandma|grandpa|rocko)\b/i;
  // Ordered best first. Newer system voices beat the legacy ones, and a
  // measured neutral voice suits an interviewer better than a bright one.
  // Google US English first, by choice. It is a Chrome network voice rather
  // than a system one, so it is absent on a Mac with no Chrome voices loaded
  // and on every other browser - hence the rest of the list, in descending
  // order of how much like a person they sound. Whatever the machine defaults
  // to is the last resort, and on a Mac that is Samantha.
  var VOICE_PREFERRED = ['Google US English', 'Google UK English Male',
                         'Microsoft Aria', 'Microsoft Guy',
                         'Daniel', 'Reed', 'Flo', 'Sandy', 'Shelley',
                         'Karen', 'Moira', 'Tessa', 'Samantha'];

  function usableVoices() {
    if (!TTS) return [];
    var all = [];
    try { all = window.speechSynthesis.getVoices() || []; } catch (e) { return []; }
    return all.filter(function (v) {
      return /^en/i.test(v.lang) && !VOICE_NOVELTY.test(v.name);
    });
  }
  function pickVoice() {
    var list = usableVoices();
    if (!list.length) return null;
    for (var j = 0; j < VOICE_PREFERRED.length; j++) {
      for (var k = 0; k < list.length; k++) {
        if (list[k].name.indexOf(VOICE_PREFERRED[j]) === 0) return list[k];
      }
    }
    return list[0];
  }

  var talking = false;      // in a hands-free session
  var speaking = false;     // the bot has the floor
  var convoRec = null;
  var hushTimer = null;
  // Long enough for a real thinking pause mid-answer, short enough that the
  // silence does not feel like a dropped call. Behavioural answers are full of
  // pauses, so this errs generous.
  var HUSH_MS = 2000;

  // With the labelled button gone, the state has to be legible from the icon
  // and the input. The icon carries whose turn it is by colour, and the
  // placeholder says it in words, which is the one spot the eye already goes
  // when it expects to type.
  var PLACEHOLDER = 'Message…';
  function paintTalk(state) {
    if (!micBtn) return;
    micBtn.classList.toggle('live', talking);
    micBtn.classList.toggle('hearing', talking && state === 'listening');
    micBtn.classList.toggle('talking', talking && state === 'speaking');
    micBtn.textContent = !talking ? 'talk instead'
      : state === 'listening' ? 'listening'
      : state === 'speaking' ? 'speaking'
      : 'thinking';
    var label = !talking
      ? 'Start a hands-free spoken session'
      : 'End the spoken session and go back to typing';
    micBtn.title = label;
    micBtn.setAttribute('aria-label', label);
    input.placeholder = !talking ? PLACEHOLDER
      : state === 'listening' ? 'Listening…'
      : state === 'speaking' ? 'Speaking…'
      : 'Thinking…';
    paintHands();
  }

  // The button sits INSIDE the box, so the moment there is text in the box it
  // is in the way: it holds the right end of the line and offers the one
  // action a person who is already typing does not want. A single character
  // retires it, and the padding reserved for it goes too, so the text runs the
  // full width as though it had never been there. Emptying the box - by
  // deleting or by sending - brings it back.
  //
  // Clicking into the box is not typing, and deliberately so: someone who
  // clicks may still be deciding how to answer, and that is exactly when the
  // offer is worth seeing.
  //
  // It stays put for the whole spoken session. There the label is the state
  // readout and the only way back to typing, and the live transcript fills the
  // box on its own - hiding it on the first word heard would delete the exit.
  function paintHands() {
    if (!micBtn) return;
    var typed = !talking && input.value.length > 0;
    micBtn.hidden = typed;
    inputWrap.classList.toggle('bc-has-text', typed);
  }

  // Stops whichever voice is talking. Both have to be named: cancelling
  // speechSynthesis does nothing to an <audio> element, and the spoken session
  // can end mid-sentence in either one.
  function silence() {
    if (ttsAudio) {
      try { ttsAudio.pause(); } catch (e) {}
      ttsAudio = null;
    }
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }

  function speakLocal(clean, finish) {
    if (!TTS) { finish(); return; }
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(clean);
      var chosen = pickVoice();
      if (chosen) { u.voice = chosen; u.lang = chosen.lang; }
      u.rate = 1.02;
      u.onend = finish;
      u.onerror = finish;
      paintTalk('speaking');
      window.speechSynthesis.speak(u);
      // Some browsers drop onend on a long utterance and the loop would hang
      // waiting for a turn that never comes, so the length of the text sets a
      // backstop: roughly fifteen characters a second, plus a margin.
      setTimeout(finish, 4000 + clean.length * 70);
    } catch (e) {
      finish();
    }
  }

  function speak(text, done) {
    if (!talking || !multimodal || (!TTS && !ttsRemote)) { if (done) done(); return; }
    silence();
    // the state line is already stripped; strip stray punctuation runs so it
    // does not read symbols aloud
    var clean = String(text).replace(/[*_`#>]/g, '');
    var fired = false;
    function finish() {
      if (fired) return;
      fired = true;
      speaking = false;
      if (done) done();
    }
    // Claimed before the fetch, not after it. listenTurn refuses to start
    // while the bot has the floor, and the round-trip below is time the
    // microphone must stay shut - otherwise it hears the reply being fetched
    // as the visitor's answer.
    speaking = true;
    if (!ttsRemote) { speakLocal(clean, finish); return; }
    fetch(ENDPOINT + '/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: clean }),
    }).then(function (r) {
      if (!r.ok) throw new Error('tts ' + r.status);
      return r.blob();
    }).then(function (b) {
      if (fired) return;
      if (!talking) { finish(); return; } // they ended the session mid-fetch
      var src = URL.createObjectURL(b);
      var a = new Audio(src);
      ttsAudio = a;
      function drop() {
        try { URL.revokeObjectURL(src); } catch (e) {}
        if (ttsAudio === a) ttsAudio = null;
      }
      a.onended = function () { drop(); finish(); };
      // A file that will not decode, or a play() the browser refuses, is this
      // reply's problem rather than the route's - so it falls to the local
      // voice for this turn instead of going quiet, and tries remote again on
      // the next one.
      a.onerror = function () { drop(); if (!fired) speakLocal(clean, finish); };
      // paintTalk only now. During the fetch nothing is speaking yet, and a
      // label that says "speaking" over a silent room reads as a hang.
      paintTalk('speaking');
      var played = a.play();
      if (played && played.catch) {
        played.catch(function () { drop(); if (!fired) speakLocal(clean, finish); });
      }
      setTimeout(function () { drop(); finish(); }, 6000 + clean.length * 70);
    }).catch(function () {
      // One hard refusal is enough for the rest of the page load. A missing
      // key, a spent monthly quota and a voice the plan may not serve all fail
      // identically every time, and retrying per reply would add a round-trip
      // of silence to each one.
      ttsRemote = false;
      if (!fired) speakLocal(clean, finish);
    });
  }

  function hush() {
    clearTimeout(hushTimer);
    hushTimer = null;
    if (convoRec) {
      try { convoRec.onend = null; convoRec.abort(); } catch (e) {}
      convoRec = null;
    }
  }

  function listenTurn() {
    if (!talking || speaking || pending || !SR) return;
    hush();
    var rec2 = new SR();
    convoRec = rec2;
    rec2.continuous = true;
    rec2.interimResults = true;
    rec2.lang = document.documentElement.lang || 'en-US';
    var heard = '';
    paintTalk('listening');
    rec2.onresult = function (ev) {
      var interim = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) heard += ev.results[i][0].transcript;
        else interim += ev.results[i][0].transcript;
      }
      input.value = (heard + interim).replace(/^\s+/, '');
      autogrow();
      // every scrap of speech restarts the silence timer, so the send only
      // happens once they have actually stopped
      clearTimeout(hushTimer);
      if (input.value.trim()) {
        hushTimer = setTimeout(function () {
          if (!talking || !input.value.trim()) return;
          hush();
          paintTalk('thinking');
          form.dispatchEvent(new Event('submit', { cancelable: true }));
        }, HUSH_MS);
      }
    };
    rec2.onend = function () {
      // Chrome ends recognition on its own after a lull. In a conversation that
      // is not the end of anything, so it starts again unless the bot has the
      // floor or a send is in flight.
      if (talking && !speaking && !pending) listenTurn();
    };
    rec2.onerror = function (e) {
      var fatal = e && (e.error === 'not-allowed' || e.error === 'service-not-allowed');
      if (fatal) {
        stopTalking();
        addBot('I cannot hear you without microphone access. Turn it on for this site and press talk again, or just type.');
      }
      // 'no-speech' and 'aborted' are ordinary in a conversation: onend
      // restarts the listener
    };
    try { rec2.start(); } catch (e) {}
  }

  // The bot can stop speaking BEFORE the request that produced it has finished
  // settling - and always does when speech fails outright, since then the
  // callback fires synchronously. listenTurn refuses to start while a request
  // is in flight, quite rightly, so calling it straight from the speech
  // callback dropped the microphone and killed the conversation after one turn.
  // This waits for the turn to actually be over, whichever order that happens
  // in, and gives up rather than polling forever if a request hangs.
  function resumeListening(tries) {
    if (!talking) return;
    if ((pending || speaking) && (tries || 0) < 80) {
      setTimeout(function () { resumeListening((tries || 0) + 1); }, 150);
      return;
    }
    if (!pending && !speaking) listenTurn();
  }

  function startTalking() {
    if (talking) return;
    talking = true;
    paintTalk('listening');
    listenTurn();
  }
  function stopTalking() {
    talking = false;
    speaking = false;
    hush();
    silence();
    paintTalk('talk');
    input.focus();
  }

  if (SR && (TTS || ttsRemote) && multimodal && micBtn) {
    paintTalk('talk');
    micBtn.addEventListener('click', function () {
      if (talking) stopTalking();
      else startTalking();
    });
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
  // Opening the board pushes the page down by the height of a 700x380 canvas,
  // and on a laptop window the button row lands below the fold - so the panel
  // looks like it has no way to submit and the drawing looks stuck. This
  // scrolls by exactly the overflow, so the whole panel including the buttons
  // is on screen, and does nothing at all when it already is.
  //
  // Reading the rect right after unhiding is safe: the layout is computed on
  // demand when the rect is read, not on a later frame.
  function revealWb() {
    var r = wb.getBoundingClientRect();
    var view = window.innerHeight || document.documentElement.clientHeight;
    var over = r.bottom + 12 - view;
    if (over <= 0) return;
    var reduce = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      window.scrollBy({ top: over, behavior: reduce ? 'auto' : 'smooth' });
    } catch (e) {
      window.scrollBy(0, over); // older Safari only takes (x, y)
    }
  }
  drawBtn.addEventListener('click', function () {
    wb.hidden = !wb.hidden;
    if (!wb.hidden && !canvas.dataset.inited) {
      wbBlank();
      canvas.dataset.inited = '1';
    }
    if (!wb.hidden) revealWb();
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
    if (typeof stopTalking === 'function') stopTalking();
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

    // The resume is only worth asking for once. A returning visitor already
    // handed theirs over, or decided not to, and being asked again every visit
    // reads as the site having forgotten them - the opposite of what keeping a
    // profile is for. Both bots offer one quiet way out instead, and for the
    // coach the upload comes back only if they take it.
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
      if (multimodal) showUpload();
      return;
    }

    var switchRow = document.createElement('div');
    var switchBtn = document.createElement('button');
    switchBtn.type = 'button';
    switchBtn.className = 'bc-upload bc-switch';
    switchBtn.textContent = multimodal
      ? "I'm interviewing for something different"
      : 'I want to learn a different topic';
    switchBtn.addEventListener('click', function () {
      // Becomes a first-time session in everything the visitor can see: the
      // greeting on screen is replaced rather than added to, so the transcript
      // is not left holding a welcome back that no longer applies. History is
      // rewritten with it too, or the model would keep working from a greeting
      // the visitor can no longer see.
      var fresh = GREETINGS[bot] || GREETINGS.tutor;
      greetEl.innerHTML = render(fresh);
      for (var i = 0; i < history.length; i++) {
        if (history[i].role === 'assistant') { history[i].content = fresh; break; }
      }
      switchRow.remove();
      if (multimodal) showUpload();
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
        // zero means the deployed Worker has no length cap, so there is
        // nothing to warn about; a Worker that reports nothing at all is an
        // older one and keeps the conservative 4000
        if (s && s.limits && typeof s.limits.messageChars === 'number') {
          msgCap = s.limits.messageChars > 0 ? s.limits.messageChars : Infinity;
        }
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
    // every place the value changes - typing, a send, a transcript, a resume
    // file - already calls autogrow, so the talk button follows from here
    paintHands();
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
    // The board survives Submit on purpose, so a drawing can be adjusted before
    // it goes. Once it has actually been sent it is spent, and reopening to a
    // stale sketch invites attaching the previous answer's diagram to the next
    // question by accident.
    if (image) wbBlank();
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
          // closing the loop: the mic comes back only once the bot has stopped
          // talking, or it would transcribe the interviewer's own question
          speak(got.clean, function () {
            resumeListening(0);
          });
        } else if (r.status === 429) {
          collapse(LIMIT_MSG);
        } else if (r.data && r.data.error === 'too_long') {
          addBot('That was too long for the free models to read in one go. ' +
                 'Send it in two halves and I will keep both in mind.');
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
