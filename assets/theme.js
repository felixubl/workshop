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

/* The toggle is not an icon: it is a lowercase mono state label plus a button
   naming the mode it takes you TO. Both strings are mode-dependent, so they
   are written from here rather than hard-coded in each page's markup. */
function syncModeLabels() {
  var mode = document.documentElement.dataset.mode;
  var next = mode === 'dark' ? 'Light' : 'Dark';
  document.querySelectorAll('[data-mode-label]').forEach(function (el) {
    el.textContent = mode;
  });
  document.querySelectorAll('[data-mode-next]').forEach(function (el) {
    el.textContent = next;
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
