/* PREPRINT — the mode switch.
 *
 * There is exactly ONE dark mode in this system, so there is exactly one file
 * that turns it on. Load it in <head>, before the stylesheets:
 *
 *   <script src="…/preprint/js/mode.js"></script>
 *
 * It runs synchronously and sets `data-mode` before the first paint, which is
 * the whole reason it cannot be deferred or bundled with a site's own script.
 * A page that sets the attribute after paint flashes the wrong mode, and the
 * flash is worse than the wait.
 *
 * The contract, which was already the same on both surfaces before this file
 * existed:
 *
 *   data-mode="light|dark"   on <html>
 *   preprint-mode            the localStorage key
 *   [data-mode-toggle]       any element that flips it
 *   [data-mode-label]        optional, receives the name of the OTHER mode
 *
 * The control is named by what it does, not by what it shows: a reader can
 * already see which mode they are in, because the mode is the whole surface.
 */
(function () {
  'use strict';

  var root = document.documentElement;

  /* Pre-paint. An explicit choice wins forever after it is made. Before that,
     the operating system's preference is the better guess than a default. */
  var stored = null;
  try { stored = localStorage.getItem('preprint-mode'); } catch (e) {}
  var prefersDark = window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.setAttribute('data-mode', stored || (prefersDark ? 'dark' : 'light'));

  function other() {
    return root.getAttribute('data-mode') === 'dark' ? 'light' : 'dark';
  }

  /* The accessible name and the drawn tip both name the DESTINATION. `title` is
     deliberately not set: it is the operating system's box in the operating
     system's type, and this system replaced it with [data-tip]. */
  function label() {
    var next = other();
    var each = function (sel, fn) {
      Array.prototype.forEach.call(document.querySelectorAll(sel), fn);
    };
    each('[data-mode-label]', function (el) { el.textContent = next; });
    each('[data-mode-toggle]', function (el) {
      el.setAttribute('aria-label', 'Switch to ' + next + ' mode');
      el.setAttribute('data-tip', next);
    });
  }

  /* Flipping the attribute is the whole interaction. Anything that moves is
     moved by CSS transitioning its own offset, so there is nothing to drive
     from here. */
  function toggle() {
    var next = other();
    root.setAttribute('data-mode', next);
    try { localStorage.setItem('preprint-mode', next); } catch (err) {}
    label();
    return next;
  }

  /* Delegated, so a toggle built after load still works. */
  document.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('[data-mode-toggle]')) return;
    toggle();
  });

  /* The one seam in this file, and it exists for exactly one caller: a
     control that flips the mode at a moment of its own choosing rather than
     at the click. `[data-mode-toggle]` cannot express "not yet" — the
     delegated handler fires on the way down — so the pull cord, which flips
     on its mechanism's release 130ms in, drives it from here instead.
     `other` and `label` come with it so that caller can name itself without
     a second copy of the rule about naming the destination. */
  window.PreprintMode = { toggle: toggle, other: other, relabel: label };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', label);
  } else {
    label();
  }
})();
