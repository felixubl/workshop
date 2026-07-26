/* Pre-paint mode script: OS preference on first visit, an explicit choice
   (persisted in localStorage) wins after that. Runs synchronously in <head>,
   before the stylesheet paints, so there's no flash. Any element with a
   [data-mode-toggle] attribute flips the mode when clicked.

   The system reads [data-mode='dark'] and there is exactly one dark mode for
   every surface, so this sets the attribute and nothing else. */
(function () {
  var stored = null;
  try {
    stored = localStorage.getItem('preprint-mode');
  } catch (e) {}
  var mode =
    stored || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.mode = mode;
})();

/* The control names the mode it would take you to, in the button itself, and
   that string is mode-dependent so it is written from here rather than
   hard-coded in each page's markup.

   It writes a word rather than a tooltip. A tooltip is for a control that has
   more to say than it can show, and this one has exactly one word to say. It
   also only appears on hover, which is no help at all on the device where the
   mode control matters most.

   The accessible name is written alongside it and contains the visible word, so
   the two agree rather than the aria-label overriding what a sighted reader can
   already see. */
function syncModeLabels() {
  var next = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark';
  document.querySelectorAll('[data-mode-label]').forEach(function (el) {
    el.textContent = next;
    var btn = el.closest('[data-mode-toggle]') || el;
    btn.setAttribute('aria-label', 'Switch to ' + next + ' mode');
  });
}

document.addEventListener('DOMContentLoaded', syncModeLabels);

document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-mode-toggle]');
  if (!btn) return;
  var next = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.mode = next;
  syncModeLabels();
  try {
    localStorage.setItem('preprint-mode', next);
  } catch (err) {}
});
