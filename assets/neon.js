/* The workshop's neon: the two things the fixture does that CSS cannot say on
   its own. The drawing, its colours and the strike animation are all in
   assets/site.css; this file only decides WHEN the tube strikes.

   Load it after preprint/js/mode.js, which is the whole trick: mode.js flips
   `data-mode` from its own delegated click on the way down, so by the time the
   handler below runs the attribute already holds the mode the reader asked for.
   Striking is then a question about the state the page has arrived in, not
   about which control was pressed or which way it went — the tube strikes when
   the room it is in has just gone dark, and does nothing at all on the way
   back, because a tube going off does not stutter. */
(function () {
  'use strict';

  var STRIKE = 'is-striking';

  function neonOf(node) {
    return node && node.closest ? node.closest('.neon') : null;
  }

  document.addEventListener('click', function (e) {
    var neon = neonOf(e.target);
    if (!neon) return;
    if (document.documentElement.getAttribute('data-mode') !== 'dark') return;
    /* Taking the class off and reading a layout value back puts the animation
       at its start again. Without the read the browser coalesces the two class
       changes into no change at all, and a second press does nothing. */
    neon.classList.remove(STRIKE);
    void neon.offsetWidth;
    neon.classList.add(STRIKE);
  });

  /* Off at the end, so the next press starts from nothing rather than from
     wherever the last one stopped. */
  document.addEventListener('animationend', function (e) {
    if (e.animationName !== 'w-neon-strike') return;
    var neon = neonOf(e.target);
    if (neon) neon.classList.remove(STRIKE);
  });
})();
