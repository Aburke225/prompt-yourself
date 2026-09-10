// Prompt Yourself — guide page behavior.
// Progressive enhancement: with no JavaScript, the full guide is visible
// and prompts are plain selectable text.

(function () {
  // copy buttons on prompt bubbles
  document.querySelectorAll('.prompt').forEach(function (p) {
    var b = document.createElement('button');
    b.className = 'copy';
    b.type = 'button';
    b.textContent = 'Copy';
    b.addEventListener('click', function () {
      navigator.clipboard.writeText(p.querySelector('pre').innerText).then(function () {
        b.textContent = 'Copied!';
        setTimeout(function () { b.textContent = 'Copy'; }, 1600);
      }, function () {
        b.textContent = 'Select & copy';
      });
    });
    p.appendChild(b);
  });

  // pager: one part at a time, Back/Next, #part-N in the URL
  var parts = Array.prototype.slice.call(document.querySelectorAll('main .part'));
  if (parts.length < 2) return;
  var main = document.querySelector('main');
  var tldr = document.querySelector('.tldr');

  var pager = document.createElement('div');
  pager.className = 'pager';

  var back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn btn-quiet';
  back.textContent = 'Back';

  var count = document.createElement('span');
  count.className = 'pager-count';

  var next = document.createElement('button');
  next.type = 'button';
  next.className = 'btn';
  next.textContent = 'Next';

  var nextGuide = null;
  if (main.dataset.nextHref) {
    nextGuide = document.createElement('a');
    nextGuide.className = 'btn';
    nextGuide.href = main.dataset.nextHref;
    nextGuide.textContent = main.dataset.nextLabel || 'Next guide';
  }

  pager.appendChild(back);
  pager.appendChild(count);
  pager.appendChild(next);
  if (nextGuide) pager.appendChild(nextGuide);
  main.appendChild(pager);

  function idx() {
    var m = location.hash.match(/^#part-(\d+)$/);
    var i = m ? parseInt(m[1], 10) - 1 : 0;
    return Math.min(Math.max(i, 0), parts.length - 1);
  }

  function show(i, scroll) {
    parts.forEach(function (s, j) { s.hidden = j !== i; });
    if (tldr) tldr.hidden = i !== 0;
    var last = i === parts.length - 1;
    back.hidden = i === 0;
    next.hidden = last;
    if (nextGuide) nextGuide.hidden = !last;
    count.textContent = 'Part ' + (i + 1) + ' of ' + parts.length;
    if (scroll) window.scrollTo({ top: 0 });
  }

  back.addEventListener('click', function () { location.hash = '#part-' + idx(); });
  next.addEventListener('click', function () { location.hash = '#part-' + (idx() + 2); });
  window.addEventListener('hashchange', function () { show(idx(), true); });
  show(idx(), false);
})();
