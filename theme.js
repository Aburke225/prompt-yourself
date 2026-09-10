// Prompt Yourself — manual light/dark toggle.
// Default follows the system; a click stores an override in localStorage.
// The icon shows what you can switch TO the moment you see it in context:
// sun while in dark mode, moon while in light mode.

(function () {
  var root = document.documentElement;
  var mq = window.matchMedia('(prefers-color-scheme: dark)');

  function stored() {
    try { return localStorage.getItem('theme'); } catch (e) { return null; }
  }
  function current() {
    var s = stored();
    return s === 'light' || s === 'dark' ? s : (mq.matches ? 'dark' : 'light');
  }

  var navList = document.querySelector('.nav ul');
  if (!navList) return;

  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  var li = document.createElement('li');
  var btn = document.createElement('button');
  btn.className = 'theme-toggle';
  btn.type = 'button';

  function render() {
    var dark = current() === 'dark';
    btn.innerHTML = dark ? SUN : MOON;
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.title = dark ? 'Light mode' : 'Dark mode';
  }

  btn.addEventListener('click', function () {
    var next = current() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('theme', next); } catch (e) {}
    root.setAttribute('data-theme', next);
    render();
  });

  // follow live system changes while no manual override is stored
  if (mq.addEventListener) {
    mq.addEventListener('change', function () { if (!stored()) render(); });
  }

  li.appendChild(btn);
  navList.appendChild(li);
  render();
})();
