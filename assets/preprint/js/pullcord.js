/* PREPRINT — the pull cord.
 *
 * The drawing is `.pullcord` in core.css. This is the mechanism: the two ways
 * of working it, the moment the mode flips, and the click the housing makes.
 * Load it AFTER js/mode.js, deferred — unlike mode.js it has nothing to say
 * before the first paint.
 *
 *   <script src="…/preprint/js/mode.js"></script>       in <head>, blocking
 *   <script src="…/preprint/js/pullcord.js" defer></script>
 *
 * The contract:
 *
 *   [data-pullcord]      the button, markup as documented in core.css
 *   preprint-sound       localStorage; 'off' silences the click, nothing else
 *
 * TWO GESTURES, ONE MECHANISM. Click it and you get a scripted pull: a short
 * flick, and the mode changes. Or take hold of the bead and PULL, and the cord
 * follows your hand until the detent trips — which is the same event in both
 * cases, reached two different ways. The detent is the whole reason the second
 * one is worth having: a real lamp does not switch when you touch the cord, it
 * switches when you have pulled it far enough, and until you have, you can
 * always change your mind and let go.
 *
 * Sound is on by default and this is the only file in the system that makes
 * any. That is a deliberate exception rather than a door left open: the cord
 * depicts a physical mechanism, and a detent that moves in silence is the one
 * part of the illusion a reader notices missing. It follows from the cord, it
 * does not generalise to anything else.
 */
(function () {
  'use strict';

  /* Rest length, and the travel that trips the detent. 42px is a deliberate
     pull rather than a twitch — far enough that nobody flips the lights by
     brushing the cord on the way to something else, short enough that it is
     one movement of the hand and not a chore.

     GIVE is what is left after the detent: the cord keeps coming, but on a
     curve that runs out, so pulling harder gets you less and less. A string
     that tracked the hand forever would say the mechanism has no end in it. */
  var REST = 72;
  var DETENT = 42;
  var GIVE = 26;

  /* Under this, a press was a click and not a pull. It exists because a
     pointer never comes down and up at exactly the same pixel, and a 2px
     wobble that cancelled the click would make the control feel broken. */
  var TAP = 5;

  /* The scripted pull, for a click or a keypress. Times are from the click;
     each entry says which phase to enter. The mode flips on the way into 2 —
     the release — and the click sounds with it. See core.css for why that is
     the release and not the press.

     Short on purpose: 13px, where a dragged pull travels 42. This one is not a
     small pull, it is an ABBREVIATION of a pull, the way a switch's travel is
     shorter than the gesture it stands for. Animating the full 42 on every
     click read as the page flinching. */
  var SCHEDULE = [[0, 1], [130, 2], [330, 3], [490, 0]];

  /* Phase 2 is the recoil and phase 3 the settle, so a release from a dragged
     pull rejoins the scripted one at its own last two beats rather than
     inventing a second way to come home. The offsets are the gaps in SCHEDULE:
     330 - 130 and 490 - 330. */
  var RECOIL = 200;
  var SETTLE = 160;

  var reduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* One lock for both gestures. A cord you can re-pull mid-pull stacks
     transitions and the bead ends up somewhere the length never was, which is
     the one way these two elements can appear to come apart. Dropping the
     extra pull is right rather than merely easy: a real cord ignores you too
     while it is on its way back up. */
  var busy = false;

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

  function clack() {
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

  /* ── the trip ───────────────────────────────────────────────────────────
     The one event both gestures are for, and the only place the mode changes.
     Sound goes with it rather than with the press, so what you hear is the
     mechanism and not your own finger. */
  function trip(el) {
    if (window.PreprintMode) window.PreprintMode.toggle();
    name(el);
    clack();
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

  /* ── the scripted pull, for a click or a keypress ────────────────────────
     Under reduced motion there is no mechanism to run: the mode flips and the
     cord never moves. */
  function pull(el) {
    if (busy) return;

    if (reduced) { trip(el); return; }

    busy = true;
    SCHEDULE.forEach(function (step) {
      setTimeout(function () {
        el.setAttribute('data-phase', String(step[1]));
        if (step[1] === 2) trip(el);
        if (step[1] === 0) busy = false;
      }, step[0]);
    });
  }

  /* Coming home from wherever the hand left it. The inline length goes and the
     phases take over in the same frame, so one style change carries the cord
     from a dragged 114px to the recoil's 71 — CSS interpolates it, and there
     is no separate spring to write or to keep in step with the click's.

     Under reduced motion the transitions are already off in core.css, so this
     is a jump to rest and the timers only decide when the lock lifts. */
  function letGo(el) {
    busy = true;
    el.style.removeProperty('--pp-cord-h');
    el.removeAttribute('data-dragging');
    el.setAttribute('data-phase', '2');
    setTimeout(function () { el.setAttribute('data-phase', '3'); }, RECOIL);
    setTimeout(function () {
      el.setAttribute('data-phase', '0');
      busy = false;
      /* A click does not always follow a pointer release — let go outside the
         button and the browser fires none at all. Left standing, the flag would
         swallow the NEXT press instead, which for a keyboard user is a control
         that ignores every second Enter. Clearing it here costs nothing: the
         click it is meant for arrives in the same task as the pointerup, long
         before this, and anything later was blocked by the lock anyway. */
      swallowClick = false;
    }, RECOIL + SETTLE);
  }

  /* ── the real pull ──────────────────────────────────────────────────────
     One to one until the detent, then an exponential that approaches REST +
     DETENT + GIVE without reaching it. The straight part is what makes the
     detent findable — travel has to mean distance for a threshold to be felt
     as a position rather than guessed at — and the curve is the spool running
     out afterwards.

     Upward travel is dropped rather than mirrored. You cannot push a string. */
  function lengthFor(travel) {
    if (travel <= DETENT) return REST + travel;
    var give = GIVE * (1 - Math.exp(-(travel - DETENT) / GIVE));
    /* Rounded, because the exponential otherwise writes seventeen significant
       figures into the DOM on every pointer move to describe a length nothing
       can draw to better than a device pixel. */
    return Math.round((REST + DETENT + give) * 10) / 10;
  }

  var drag = null;

  /* A click event still follows the pointer sequence that ended a drag, and
     running the scripted pull on top of a pull already given would flip the
     mode straight back. Set when the pointer handled it, cleared by the click
     it swallows, and cleared again on the next press so it can never stick. */
  var swallowClick = false;

  document.addEventListener('pointerdown', function (e) {
    if (!e.target.closest || e.button !== 0) return;
    var el = e.target.closest('[data-pullcord]');
    if (!el || busy || drag) return;

    swallowClick = false;
    drag = { el: el, id: e.pointerId, y0: e.clientY, far: 0, tripped: false };
    el.setAttribute('data-dragging', '');

    /* Capture, so the cord keeps following a hand that has left the 30px hit
       area — which it will, because the gesture is longer than the target. */
    try { el.setPointerCapture(e.pointerId); } catch (err) {}

    /* Or the press selects the text behind it and drags a ghost of the bead. */
    e.preventDefault();
  });

  document.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    var travel = Math.max(0, e.clientY - drag.y0);
    if (travel > drag.far) drag.far = travel;
    drag.el.style.setProperty('--pp-cord-h', lengthFor(travel) + 'px');

    /* Once per pull. Held past the detent the mechanism has already gone, and
       a cord that kept tripping while you held it down would be a strobe. */
    if (!drag.tripped && travel >= DETENT) {
      drag.tripped = true;
      trip(drag.el);
    }
  });

  function release(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var el = drag.el;
    var tapped = drag.far < TAP;
    try { el.releasePointerCapture(drag.id); } catch (err) {}
    drag = null;

    /* A press that never moved is a click, and the click event about to fire
       is what runs it. Hand the cord back and stay out of the way. */
    if (tapped) {
      el.style.removeProperty('--pp-cord-h');
      el.removeAttribute('data-dragging');
      return;
    }

    /* Everything else was a pull, whether or not it reached far enough to
       matter. Let go short of the detent and the cord springs back with the
       mode untouched and nothing to hear, which is the whole point of having
       a threshold: the gesture is abandonable right up until it lands. */
    swallowClick = true;
    letGo(el);
  }

  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);

  /* Delegated, so a cord built after load still works — the same reason
     mode.js delegates. This is also the keyboard's path in: Enter and Space
     on a <button> fire a click and no pointer events at all, so they get the
     scripted pull without a line of their own. */
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var el = e.target.closest('[data-pullcord]');
    if (!el) return;
    if (swallowClick) { swallowClick = false; return; }
    pull(el);
  });

  function init() {
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-pullcord]'),
      function (el) {
        el.setAttribute('data-phase', '0');
        name(el);
      }
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
