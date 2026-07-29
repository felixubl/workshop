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
 * The pull is in two dimensions and it fights back. The cord hangs from a fixed
 * point and swings toward the hand wherever the hand goes, and both the length
 * and the angle come out of one resistance curve that starts at one to one and
 * runs out, so the further you have got the more hand the next pixel costs. On
 * release it swings once past rest and settles. All of that is geometry the
 * script computes and hands to core.css as two custom properties.
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

     GIVE is the whole stretch the cord has in it and SWAY the whole sideways
     reach, both approached and never arrived at. A string that tracked the hand
     forever would say the mechanism has no end in it.

     SWAY is a ceiling and not the limit itself: the real limit is how much page
     there is beside the cord, measured on the way in, and EDGE is the margin
     kept between the bead and that edge. A cord hung 25px from the side of a
     phone gets 25px of sway, because the alternative is a bead that leaves the
     page and takes a horizontal scrollbar with it. There is a wall there and
     the cord is allowed to know. */
  var REST = 72;
  var DETENT = 42;
  var GIVE = 64;
  var SWAY = 72;
  var EDGE = 8;

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

  /* Coming home from wherever the hand left it, in length and in angle at
     once. Both inline values go and the phases take over in the same frame, so
     one style change carries the cord from a dragged 108px at 24deg to the
     recoil's 71 at a few degrees the other way. CSS interpolates it, and there
     is no separate spring to write or to keep in step with the click's.

     The counter-swing is a fifth of the angle let go at, reversed. A fraction
     rather than a fixed number of degrees, because the overshoot has to be
     proportional to the energy that was in the cord: a gentle nudge sideways
     that came back through 6deg the other way would look sprung, not hung. A
     fifth is far enough to read as a swing and near enough that the two beats
     in core.css are the end of it and nothing needs a third.

     Under reduced motion the transitions are already off in core.css, so this
     is a jump to rest and the timers only decide when the lock lifts. */
  function letGo(el, angle) {
    busy = true;
    el.style.removeProperty('--pp-cord-h');
    el.style.removeProperty('--pp-cord-a');
    /* Not under reduced motion. With the transitions off an overshoot is not a
       swing, it is the cord jumping a few degrees sideways for one frame and
       back, which is the exact thing the query is asking us not to do. Left
       unwritten it keeps the 0deg core.css declares, phase 2 is the pure recoil,
       and the cord simply arrives. */
    if (!reduced) el.style.setProperty('--pp-cord-swing', (-angle / 5).toFixed(1) + 'deg');
    el.removeAttribute('data-dragging');
    el.setAttribute('data-phase', '2');
    setTimeout(function () { el.setAttribute('data-phase', '3'); }, RECOIL);
    setTimeout(function () {
      el.setAttribute('data-phase', '0');
      busy = false;
      /* Gone once it is spent, so the next click's phase 2 is the pure recoil
         it was before any of this and not the tail of somebody's last swing. */
      el.style.removeProperty('--pp-cord-swing');
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
     One curve, used on both axes, and tanh is the whole of it. It leaves the
     origin at one to one, so the beginning of any pull tracks the hand exactly
     and the cord reads as attached to it, and then it bends over and approaches
     `max` without ever arriving, so the further out you already are the more
     hand the next pixel costs. That is the asked-for feel and it is also the
     honest one: a real cord does not stretch at all, it is a spring in a housing
     giving way and then running out of travel.

     The same function on both axes is what makes the gesture feel like one
     object. A cord that resisted going down but swung freely sideways would be
     two mechanisms sharing a bead. It is signed, so pulling left and pulling
     right are the same curve read in opposite directions. */
  function give(x, max) {
    return max * Math.tanh(x / max);
  }

  /* Rounded, because tanh otherwise writes seventeen significant figures into
     the DOM on every pointer move to describe a position nothing can draw to
     better than a device pixel. */
  function tidy(n) {
    return Math.round(n * 10) / 10;
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

    /* The screw in the ceiling, in page coordinates: the middle of the 1px line,
       read off the line itself rather than computed from the button, so the one
       place the geometry is written down stays core.css. Safe to read at rest,
       and `busy` is what guarantees this is rest and not the middle of a
       recoil. */
    var line = el.querySelector('.pullcord__cord');
    var box = (line || el).getBoundingClientRect();
    var anchor = box.left + box.width / 2;

    /* clientWidth and not innerWidth: the first is where the content ends, the
       second includes a scrollbar the cord would be swinging underneath. */
    var page = document.documentElement.clientWidth;

    swallowClick = false;
    drag = {
      el: el, id: e.pointerId,
      x0: e.clientX, y0: e.clientY,
      roomR: Math.min(SWAY, Math.max(0, page - anchor - EDGE)),
      roomL: Math.min(SWAY, Math.max(0, anchor - EDGE)),
      far: 0, angle: 0, tripped: false
    };
    el.setAttribute('data-dragging', '');

    /* Capture, so the cord keeps following a hand that has left the 30px hit
       area, which it will, because the gesture is longer than the target and
       now goes sideways out of it as well. */
    try { el.setPointerCapture(e.pointerId); } catch (err) {}

    /* Or the press selects the text behind it and drags a ghost of the bead. */
    e.preventDefault();
  });

  document.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;

    var dx = e.clientX - drag.x0;
    var dy = e.clientY - drag.y0;

    /* How far the HAND went, kept separately from what the cord did with it,
       because this one is only ever asked whether a press was a click. A 30px
       sideways drag barely lengthens the string and is still unmistakably a
       drag. */
    var moved = Math.sqrt(dx * dx + dy * dy);
    if (moved > drag.far) drag.far = moved;

    /* The tip is taken to start at rest length below the anchor and to move by
       the drag, whatever part of the cord the hand actually closed on. Measure
       from the real grab point instead and taking hold near the ceiling would
       cost 50px of pull before the string moved at all.

       Upward travel is dropped rather than mirrored: you cannot push a string.
       Dropping the vertical alone rather than the whole vector is what lets an
       up-and-sideways drag still swing the cord, which is right, because the
       part of that gesture a string can answer is the sideways part. */
    var down = Math.max(0, dy);

    /* The distance the mechanism has been given, taken before the resistance
       decides how much of it to show, and the only thing the detent looks at.
       Straight down it is exactly `dy`, which is why the trip still happens at
       the same 42px of hand it always did even though the cord drawn at that
       moment is shorter than it used to be. Putting the threshold on the drawn
       length instead would move it every time the curve was tuned. */
    var travel = Math.sqrt(dx * dx + (REST + down) * (REST + down)) - REST;

    /* Where the tip ends up: one rubber band per axis, out of the same curve,
       with its own budget. Down it is the stretch the mechanism has. Sideways it
       is the room beside the cord, and asymptotic rather than clamped, so a hand
       that keeps going gets less and less rather than a bead that stops dead and
       stops looking held.

       Length and angle then come out of a position rather than being written
       independently, and the bead cannot be at an angle the length disagrees
       with. The angle is negated because a positive CSS rotation is clockwise,
       and a hand going right takes the bottom of a cord anticlockwise. */
    var room = dx >= 0 ? drag.roomR : drag.roomL;
    var tipY = REST + give(down, GIVE);
    var tipX = room > 0 ? give(dx, room) : 0;

    drag.angle = -tidy(Math.atan2(tipX, tipY) * 180 / Math.PI);
    drag.el.style.setProperty('--pp-cord-h', tidy(Math.sqrt(tipX * tipX + tipY * tipY)) + 'px');
    drag.el.style.setProperty('--pp-cord-a', drag.angle + 'deg');

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
    var angle = drag.angle;
    try { el.releasePointerCapture(drag.id); } catch (err) {}
    drag = null;

    /* A press that never moved is a click, and the click event about to fire
       is what runs it. Hand the cord back and stay out of the way. */
    if (tapped) {
      el.style.removeProperty('--pp-cord-h');
      el.style.removeProperty('--pp-cord-a');
      el.removeAttribute('data-dragging');
      return;
    }

    /* Everything else was a pull, whether or not it reached far enough to
       matter. Let go short of the detent and the cord springs back with the
       mode untouched and nothing to hear, which is the whole point of having
       a threshold: the gesture is abandonable right up until it lands. */
    swallowClick = true;
    letGo(el, angle);
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
