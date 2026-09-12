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

  var GREETINGS = {
    tutor:
      "Hey — I'm the live tutor. Tell me three things and we'll start: the topic, your level, and your goal. For example: \"Excel basics — never used it — I want to build a budget for my apartment.\"",
    coach:
      "I'm a practice interviewer. To start, tell me the job or program, a highlight or two from your background, and your weak spots. For example: \"Nurse residency at a city hospital; two years as a CNA; I ramble and freeze on 'tell me about yourself'.\"",
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

  var history = []; // {role, content, image?} — greeting included for context
  var pendingImage = null;

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

  function addUser(text, image) {
    var d = document.createElement('div');
    d.className = 'bc-user';
    if (image) {
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
    if (!text && !pendingImage) return;
    if (!text) text = 'Here is my drawing.';
    var image = pendingImage;
    clearAttachment();
    input.value = '';
    autogrow();
    addUser(text, image);
    var msg = { role: 'user', content: text };
    if (image) msg.image = image;
    history.push(msg);

    pending = true;
    send.disabled = true;
    var typing = addTyping();

    // the payload carries at most one drawing: the latest
    var recent = history.slice(-16);
    var payload = recent.map(function (m, i) {
      return i === recent.length - 1 && m.image
        ? m
        : { role: m.role, content: m.content };
    });

    fetch(ENDPOINT, {
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
          addBot(r.data.reply);
          history.push({ role: 'assistant', content: r.data.reply });
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
})();
