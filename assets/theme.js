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

/* The control carries no visible text, so the only thing that names the mode it
   takes you to is its tooltip — and that string is mode-dependent, so it is
   written from here rather than hard-coded in each page's markup. The
   aria-label stays fixed in the markup and describes the control itself, which
   is what a screen reader needs first.

   It sets data-tip, not title: assets/controls.js draws the tooltip, and a
   title attribute would put the operating system's grey box on the one control
   that appears on every page in the family. */
function syncModeLabels() {
  var next = document.documentElement.dataset.mode === 'dark' ? 'Light' : 'Dark';
  document.querySelectorAll('[data-mode-title]').forEach(function (el) {
    el.dataset.tip = next;
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
