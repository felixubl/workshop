/* The workshop's neon: the two things the fixture does that CSS cannot say on
   its own. The drawing, its colours and the strike animation are all in
   assets/site.css; this file only decides WHEN the tube strikes.

   Load it after preprint/js/mode.js, which is the whole trick: mode.js flips
   `data-mode` from its own delegated click on the way down, so by the time the
   handler below runs the attribute already holds the mode the reader asked for.
   The control is the wall switch; the tubes only answer it.
   Striking is then a question about the state the page has arrived in, not
   about which control was pressed or which way it went — the tube strikes when
   the room it is in has just gone dark, and does nothing at all on the way
   back, because a tube going off does not stutter. */
(function () {
  'use strict';

  var STRIKE = 'is-striking';

  document.addEventListener('click', function (e) {
    /* Any mode control, not the light: the tubes are not a button any more, and
       the switch that flips the room is what the tubes answer. */
    if (!e.target.closest || !e.target.closest('[data-mode-toggle]')) return;
    if (document.documentElement.getAttribute('data-mode') !== 'dark') return;
    var neon = document.querySelector('.neon');
    if (!neon) return;
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
    if (e.target.classList) e.target.classList.remove(STRIKE);
  });
})();
