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

/* The control is the same object fubl.org wears: a rectangle three-quarters
   full of ink that slides to the other end. It says nothing out loud, because
   the thing it is about is the one thing on the page a reader can already see
   — the mode is the whole surface. The word it used to carry was a caption for
   a picture the reader is standing inside.

   That leaves the name to the accessible layer, where it names the destination
   rather than the state, since a control is named by what it does. */
function syncModeLabels() {
  var next = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark';
  document.querySelectorAll('[data-mode-label]').forEach(function (el) {
    el.textContent = next;
  });
  document.querySelectorAll('[data-mode-toggle]').forEach(function (btn) {
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
