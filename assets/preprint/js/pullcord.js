/* PREPRINT — the pull cord.
 *
 * The drawing is `.pullcord` in core.css. This is the mechanism: the clock
 * that walks the phases, the moment the mode flips, and the click the housing
 * makes. Load it AFTER js/mode.js, deferred — unlike mode.js it has nothing
 * to say before the first paint.
 *
 *   <script src="…/preprint/js/mode.js"></script>       in <head>, blocking
 *   <script src="…/preprint/js/pullcord.js" defer></script>
 *
 * The contract:
 *
 *   [data-pullcord]      the button, markup as documented in core.css
 *   preprint-sound       localStorage; 'off' silences the click, nothing else
 *
 * Sound is on by default and this is the only file in the system that makes
 * any. That is a deliberate exception rather than a door left open: the cord
 * depicts a physical mechanism, and a detent that moves in silence is the one
 * part of the illusion a reader notices missing. It follows from the cord, it
 * does not generalise to anything else.
 */
(function () {
  'use strict';

  /* The phases, and the clock. Times are from the click; each entry says
     which phase to enter. The mode flips on the way into 2 — the release —
     and the click sounds with it. See core.css for why that is the release
     and not the click.

     490ms is the whole cycle and also the re-entrancy lock. A cord you can
     re-pull mid-pull stacks transitions and the bead ends up somewhere the
     length never was, which is the one way these two elements can appear to
     come apart. Dropping the extra pull is right rather than merely easy: a
     real cord ignores you too while it is on its way back up. */
  var SCHEDULE = [
    [0, 1],
    [130, 2],
    [330, 3],
    [490, 0]
  ];
  var CYCLE = 490;

  var reduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var pulling = false;

  /* ── the click ──────────────────────────────────────────────────────────
     Two bursts 26ms apart. A is the bright snap of the detent letting go, B
     the duller body of the housing taking the shock a moment later; one burst
     alone reads as a UI beep rather than as a mechanism, and the gap is what
     makes it a thing with parts inside it.

     Each burst is filtered noise plus a falling tone. The noise is the
     material and the tone is the cavity it happens in — bright and small for
     A, lower and slower for B. */
  var ctx = null;
  var noise = null;

  function audio() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    return ctx;
  }

  /* White noise with a cubic decay baked into the samples. Cubic rather than
     linear because a click is almost entirely its own onset: (1 - i/n)^3 has
     three quarters of its energy in the first quarter of the buffer, which is
     what a strike sounds like. Built once and replayed — the buffer is the
     material, and the filters are what shape it into two different objects. */
  function buffer(c) {
    if (noise) return noise;
    var n = Math.floor(c.sampleRate * 0.12);
    noise = c.createBuffer(1, n, c.sampleRate);
    var data = noise.getChannelData(0);
    for (var i = 0; i < n; i++) {
      var env = 1 - i / n;
      data[i] = (Math.random() * 2 - 1) * env * env * env;
    }
    return noise;
  }

  /* exponentialRampToValueAtTime, which cannot reach zero — 0.0001 is
     silence at any listening level and the ramp gets there in a curve rather
     than the audible corner a linear one leaves. */
  function burst(c, at, freq, q, gain, dur, tone, toneGain) {
    var src = c.createBufferSource();
    src.buffer = buffer(c);

    var band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq;
    band.Q.value = q;

    var g = c.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    src.connect(band).connect(g).connect(c.destination);
    src.start(at);
    src.stop(at + dur);

    /* The tone falls to 55% of where it started, which is a little under a
       tritone. Enough that the ear hears a pitch moving and not enough that
       it hears a note. */
    var osc = c.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(tone, at);
    osc.frequency.exponentialRampToValueAtTime(tone * 0.55, at + 0.03);

    var og = c.createGain();
    og.gain.setValueAtTime(toneGain, at);
    og.gain.exponentialRampToValueAtTime(0.0001, at + 0.035);

    osc.connect(og).connect(c.destination);
    osc.start(at);
    osc.stop(at + 0.035);
  }

  function click() {
    if (reduced) return;
    try {
      if (localStorage.getItem('preprint-sound') === 'off') return;
    } catch (e) {}
    try {
      var c = audio();
      if (!c) return;
      /* Resumed on every use, not once: a context started before the first
         gesture is suspended, and a tab that has been in the background long
         enough gets suspended again with no event to hang the restart on. */
      if (c.state === 'suspended') c.resume();
      var t = c.currentTime;
      burst(c, t, 3400, 1.1, 0.16, 0.016, 2600, 0.08);
      burst(c, t + 0.026, 1500, 0.9, 0.11, 0.038, 900, 0.055);
    } catch (e) {}
  }

  /* ── the pull ───────────────────────────────────────────────────────────
     Under reduced motion there is no mechanism to run: the mode flips on the
     click and the cord never moves. The sound goes with the motion rather
     than staying behind, because what it is a sound OF is the movement. */
  function pull(el) {
    if (pulling) return;

    if (reduced) {
      flip(el);
      return;
    }

    pulling = true;
    SCHEDULE.forEach(function (step) {
      setTimeout(function () {
        el.setAttribute('data-phase', String(step[1]));
        if (step[1] === 2) { flip(el); click(); }
        if (step[1] === 0) pulling = false;
      }, step[0]);
    });
  }

  function flip(el) {
    if (window.PreprintMode) window.PreprintMode.toggle();
    name(el);
  }

  /* Named for the gesture AND the destination. The system's rule is that a
     control names where it takes you, which "pull the string" on its own
     does not — someone who cannot see the cord learns nothing from it. Both
     halves are here because the gesture is the point of this control and
     dropping it would leave a cord that announces itself as a plain switch. */
  function name(el) {
    var next = window.PreprintMode ? window.PreprintMode.other() : null;
    if (!next) return;
    el.setAttribute('aria-label', 'Pull the string to switch to ' + next + ' mode');
    el.setAttribute('data-tip', next + ' mode');
  }

  function init() {
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-pullcord]'),
      function (el) {
        el.setAttribute('data-phase', '0');
        name(el);
      }
    );
  }

  /* Delegated, so a cord built after load still works — the same reason
     mode.js delegates. */
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var el = e.target.closest('[data-pullcord]');
    if (el) pull(el);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
