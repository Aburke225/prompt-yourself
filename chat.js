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

  var GREETINGS = {
    tutor:
      "Hey — I'm the live tutor from this guide. Tell me three things and we'll start: the topic you want to learn, your level (complete beginner? know the basics?), and what you want to be able to do.",
    coach:
      "I'm the live version of the coach this guide teaches you to build. Before we start, tell me: the job or program you're interviewing for, two or three highlights from your background, and your weak spots. Then I'll ask my first question.",
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

  var msgs = document.createElement('div');
  msgs.className = 'bc-msgs';

  var form = document.createElement('form');
  form.className = 'bc-form';
  var input = document.createElement('textarea');
  input.className = 'bc-input';
  input.rows = 1;
  input.placeholder = 'Type your message…';
  input.setAttribute('aria-label', 'Your message');
  var send = document.createElement('button');
  send.type = 'submit';
  send.className = 'btn bc-send';
  send.textContent = 'Send';
  form.appendChild(input);
  form.appendChild(send);

  host.className = 'bot-chat';
  host.appendChild(head);
  host.appendChild(msgs);
  host.appendChild(form);

  var history = []; // {role, content} — greeting included for context

  function setStatus(live) {
    dot.className = 'bc-dot' + (live ? '' : ' resting');
    headLabel.textContent = live ? 'live practice ' + noun : 'practice ' + noun + ' · resting';
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

  function addUser(text) {
    var d = document.createElement('div');
    d.className = 'bc-user';
    d.textContent = text;
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
    var greeting = GREETINGS[bot] || GREETINGS.tutor;
    addBot(greeting);
    history.push({ role: 'assistant', content: greeting });
  }

  if (!ENDPOINT) {
    collapse(RESTING_MSG);
  } else {
    var boot = addTyping();
    fetch(ENDPOINT, { method: 'GET' })
      .then(function (res) { return res.json(); })
      .then(function (s) {
        boot.remove();
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

  function autogrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 128) + 'px';
  }
  input.addEventListener('input', autogrow);
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
    if (!text) return;
    input.value = '';
    autogrow();
    addUser(text);
    history.push({ role: 'user', content: text });

    pending = true;
    send.disabled = true;
    var typing = addTyping();

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bot: bot, messages: history.slice(-16) }),
    })
      .then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      })
      .then(function (r) {
        typing.remove();
        if (r.ok && r.data.reply) {
          addBot(r.data.reply);
          history.push({ role: 'assistant', content: r.data.reply });
        } else if (r.status === 429) {
          collapse(LIMIT_MSG);
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
})();
