/* The workshop's ceiling lamp — the swing.
 *
 * The drawing is `.lamp` in assets/site.css. This is the mechanism: what the
 * fixture does when it is pushed, and what stops it doing that. Load it at the
 * end of the body, after js/controls.js, with the site's own scripts:
 *
 *   <script src="…/assets/lamp.js"></script>
 *
 * The contract, and all of it:
 *
 *   .lamp                the fixture. A box of no width, pinned to the top of
 *                        the header: its top corner is the ceiling point.
 *   .lamp__hang          turned by --w-lamp-swing, the flex's angle
 *   .lamp__head          turned by --w-lamp-tilt, the shade's angle ON the flex
 *   .lamp-switch         the target, and the thing the hand takes hold of
 *
 * Both angles are written onto the header, which is the nearest element that
 * holds the drawing and the switch alike, and inherit down into everything that
 * has to turn.
 *
 * THE SWITCH IS NOT THIS FILE'S. `[data-mode-toggle]` is the system's hook and
 * js/mode.js answers it on click, names the control after its destination and
 * stores the choice — all of which keeps working with this script missing,
 * blocked or still on the wire, and the lamp is then exactly what it was: a
 * fixture that hangs straight and lights the page. Everything here is the
 * gesture, and the gesture is an addition. The one thing this file does to the
 * switch is take a click away from it: a drag ends in a click event, and a
 * shove that also turned the lights out would be a control that punishes
 * touching it.
 *
 * WHY A PENDULUM AND NOT AN ANIMATION. A lamp on a flex has one number in it —
 * the angle — and gravity already says what that number does next. Written as
 * keyframes it would need a length, an easing and an amplitude per gesture, all
 * three invented, and the small lamp on a phone would swing at the same rate as
 * the big one on a desktop, which is the one thing a reader would notice as
 * wrong without being able to say why. Integrated, the period falls out of the
 * drawing's own size: √(L/g), so the half-size fixture swings half again as
 * fast, for free and correctly.
 */
(function () {
  'use strict';

  var DEG = 180 / Math.PI;

  /* Gravity, in the page's units. Not 9.81 of anything: the drawing is a lamp
     at some unstated scale, and what has to be right is the PERIOD, which is
     2π√(L/g) with L the drop from the ceiling to the mouth. At 2600 the full-size
     fixture — 178px of drop — comes to about 1.6s a swing, which is a slow,
     heavy shade rather than a keyring. The phone-sized one is 85px and lands
     near 1.1s on the same constant, and that difference is the point of doing
     this the honest way. */
  var G = 2600;

  /* Air, the flex's own stiffness, and friction at the rose, all as one number.
     Three or four swings and it is done, inside about five seconds. A real lamp
     on a real flex swings for the best part of a minute; this one is a drawing
     on a page somebody came to read, and a fixture still moving when they start
     is the drawing asking for attention it has already had. */
  var DAMP = 2.0;

  /* How far it may go, and how far it may go when the page is too narrow to
     allow that. The wall is not where the shade stops, it is where the LIGHT
     stops: the header clips at its own edge, and a beam sliced off down a
     vertical line in the middle of a wide page is a worse thing to look at than
     a shade that simply did not swing that far. So the room beside the fixture
     is measured at the moment of the press, and the swing is bounded by
     whichever runs out of page first, the shade or the pool of light it throws
     on the spine.

     The floor is what stops a narrow page from having a control that cannot
     move. Below about 700px the beam is nearly as wide as the page and is
     already cut at rest, so the rule above would bound the swing at nothing —
     and there the cut lands on the edge of the SCREEN, where light running out
     of page is what a reader would expect anyway. */
  var MAX = 40 / DEG;
  var LEAST = 16 / DEG;

  /* Under this, a press was a click and not a drag. It exists because a pointer
     never comes down and up at exactly the same pixel, and a 2px wobble that
     swallowed the click would make the switch feel broken. */
  var TAP = 5;

  /* A press is a poke, and a poke off the axis is a torque. Pressing the near
     edge of a hanging shade tips it: the side under the finger goes down, so the
     mouth swings AWAY from the finger, which is the sign below and the reason
     it is a subtraction. Per pixel of offset, so the middle of the shade barely
     moves and the rim gets a visible nudge — the same gesture, told apart by
     where it landed, which is what a real object does. */
  var POKE = 0.014;

  /* The shade on the end of the flex, as a spring: a stiff hinge with a lot of
     damping in it, driven by the flex's own angular acceleration. This is what
     a compound pendulum does — the mass lags the cord when the cord changes
     direction, and catches up a beat later — and it is worth the six lines
     because it is exactly the difference between a lamp and a cardboard cutout
     of one. Held to a few degrees: past that it stops reading as weight and
     starts reading as a hinge nobody tightened. */
  var HINGE = 190;
  var HINGE_DAMP = 9.5;
  var HINGE_LAG = 0.55;
  var HINGE_MAX = 7 / DEG;

  /* Under reduced motion there is no mechanism to run. The lamp hangs straight,
     the switch is the system's own and still flips the page, and nothing here
     ever touches the DOM — including the drag, which is not a gesture the
     reader is missing so much as one they asked not to be given. */
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  function fix(n) {
    return Math.round(n * 100) / 100;
  }

  /* One curve, and tanh is the whole of it. It leaves the origin at one to one,
     so the beginning of a drag tracks the hand exactly and the shade reads as
     held, and then it bends over and approaches the limit without arriving, so
     the further out you already are the more hand the next degree costs. A hard
     clamp would be a shade that stopped dead while the hand kept going, which is
     the moment the illusion of holding it ends. */
  function soften(a, limit) {
    return limit * Math.tanh(a / limit);
  }

  function rig(lamp, sw) {
    var host = lamp.parentElement;
    var head = lamp.querySelector('.lamp__head');
    var beam = lamp.querySelector('.lamp__beam');
    var art = lamp.querySelector('.lamp__head-art');
    if (!host || !head || !beam || !art) return;

    /* The state, and there is not much of it. `angle` is the flex off vertical
       in radians, POSITIVE MEANING THE SHADE HAS GONE RIGHT; `tilt` is the shade
       off the flex, same sign. Both are written to CSS negated, because a
       positive CSS rotation is clockwise and a clockwise turn takes the bottom
       of a hanging thing to the left. Doing that once, here, is what lets every
       line above be ordinary physics with ordinary signs. */
    var angle = 0, vel = 0, acc = 0;
    var tilt = 0, tiltVel = 0;

    var running = false, last = 0;
    var hand = null;
    var swallow = false;

    /* The last measurement, kept for the free swing: the period depends on the
       drop and the drop is a page measurement, not a constant. Seeded at the
       full-size drawing's drop so nothing can divide by an unread page. */
    var gauge = { rate: Math.sqrt(G / 178), limit: MAX };

    /* The whole geometry, read off the DOM rather than agreed with the
       stylesheet — which is what lets site.css redraw the lamp, rescale it or
       hang it somewhere else without a matching edit here. `.lamp` has no width
       and does not itself turn, so its box IS the ceiling point and its height IS
       the drop from there to the spine, and both stay put while the fixture
       swings under them. Read at every press, because the page between two
       gestures may have been resized, zoomed or reflowed. */
    function measure() {
      var box = lamp.getBoundingClientRect();
      var edge = host.getBoundingClientRect();

      /* The shade's width off its computed style rather than its box, because
         its box is turned by however far the lamp has already got and would
         report a wider, shorter shade at every angle but nought. `offsetWidth`
         is not available here at all: the drawing is an SVG element and those
         carry none of the offset properties. */
      var half = (parseFloat(getComputedStyle(art).width) || 0) / 2;
      var reach = head.offsetTop + beam.offsetTop;
      var drop = lamp.offsetHeight;

      /* How fast the beam widens, taken from the beam's own box rather than from
         the fraction site.css spreads it by — reading it twice would be two
         places to change it. Taken as if the light left the mouth at the shade's
         full width, which it does not quite, so every pool worked out below is a
         shade wider than the real one. Erring outward is the right way to be
         wrong about where light lands. */
      var flare = beam.offsetHeight > 0
        ? Math.atan((beam.offsetWidth / 2 - half) / beam.offsetHeight)
        : 0;

      /* The room on the tight side, and one number for both sides because a
         pendulum let go on the left arrives on the right: a lamp allowed 40
         degrees into the open half of the page would come back through the same
         40 into the half that has 20. The clip edge is the header's own box, and
         the fixture is hung in from the right, so the right is nearly always the
         tight side — nearly, because a surface is free to hang it somewhere
         else, and this file should not be the reason that breaks. */
      var side = Math.min(edge.right - box.left, box.left - edge.left);

      /* Whether the page has room for the lamp at this angle. Two questions, and
         the second is the one that matters: the corner of the shade is a rigid
         point and simply turns, but the outer edge of the light is a RAY, and a
         ray leaning further over has further to travel before it reaches the
         spine — so the pool it lands in runs for the edge of the page faster
         than the shade does, and it is the pool that runs out of page first. */
      function fits(phi) {
        var c = Math.cos(phi), s = Math.sin(phi);
        var cornerX = reach * s + half * c;
        if (cornerX > side) return false;
        var cornerY = reach * c - half * s;
        return cornerX + Math.max(0, drop - cornerY) * Math.tan(phi + flare) <= side;
      }

      /* No closed form for that, and none needed: the angle is bisected out of
         a question that answers yes or no. Sixteen halvings of a 40 degree range
         settle it to under a hundredth of a degree, once, at the press. */
      var lo = 0, hi = MAX;
      for (var i = 0; i < 16; i++) {
        var mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid; else hi = mid;
      }

      return {
        x: box.left,
        y: box.top,
        reach: reach,
        rate: Math.sqrt(G / Math.max(reach, 1)),
        limit: Math.max(LEAST, lo)
      };
    }

    function write() {
      host.style.setProperty('--w-lamp-swing', fix(-angle * DEG) + 'deg');
      host.style.setProperty('--w-lamp-tilt', fix(-tilt * DEG) + 'deg');
    }

    function start() {
      if (running) return;
      running = true;
      last = 0;
      host.setAttribute('data-swinging', '');
      requestAnimationFrame(frame);
    }

    /* Still enough to stop drawing. Both angles and both rates, because a lamp
       that has arrived at vertical with speed left in it has not arrived. Three
       thousandths of a radian is a third of a pixel at the mouth of the biggest
       shade this draws: past there the swing is arithmetic nobody can see, and
       the honest end of it is to stop asking for frames. */
    function spent() {
      return !hand
        && Math.abs(angle) < 0.003 && Math.abs(vel) < 0.03
        && Math.abs(tilt) < 0.003 && Math.abs(tiltVel) < 0.03;
    }

    function frame(now) {
      var dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;

      /* One step per 4ms, so the integration does not depend on how busy the
         machine is. A dropped frame at 60fps is 32ms of pendulum, and Euler over
         32ms at this stiffness gains energy instead of losing it — the lamp
         would wind itself up rather than settle. The hinge is stiffer than the
         swing and needs the small step even while the hand is driving. */
      var steps = Math.max(1, Math.ceil(dt / 0.004));
      var h = dt / steps;
      var i;

      if (hand) {
        /* Held: the hand says where the flex is, and the flex's speed and
           acceleration are read back off that rather than integrated. Both are
           smoothed, because they are differences of a pointer stream and the raw
           ones are noise; the acceleration is capped as well, at a few times the
           most gravity can manage, so that a flick reaches the end of the shade's
           travel rather than asking for ten times it. Speed is kept, because the
           speed the hand had at the moment it let go is the swing it gets. */
        var raw = dt > 0 ? (hand.angle - angle) / dt : 0;
        var was = vel;
        vel = vel * 0.55 + raw * 0.45;
        acc = dt > 0 ? (vel - was) / dt : 0;
        if (acc > 40) acc = 40;
        if (acc < -40) acc = -40;
        angle = hand.angle;
        for (i = 0; i < steps; i++) hinge(h);
      } else {
        for (i = 0; i < steps; i++) {
          acc = -gauge.rate * gauge.rate * Math.sin(angle) - DAMP * vel;
          vel += acc * h;
          angle += vel * h;
          hinge(h);
        }
      }

      write();

      if (spent()) {
        angle = vel = acc = tilt = tiltVel = 0;
        write();
        running = false;
        host.removeAttribute('data-swinging');
        return;
      }
      requestAnimationFrame(frame);
    }

    /* The shade catching up with the flex. Driven by -acc: when the flex is
       being accelerated one way the shade is left behind the other, which is the
       whole of what inertia looks like from outside. */
    function hinge(h) {
      var a = -HINGE * tilt - HINGE_DAMP * tiltVel - HINGE_LAG * acc;
      tiltVel += a * h;
      tilt += tiltVel * h;
      if (tilt > HINGE_MAX) { tilt = HINGE_MAX; tiltVel = 0; }
      if (tilt < -HINGE_MAX) { tilt = -HINGE_MAX; tiltVel = 0; }
    }

    sw.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var m = measure();
      gauge = m;
      swallow = false;
      hand = {
        id: e.pointerId, m: m,
        x0: e.clientX, y0: e.clientY,
        far: 0, angle: angle
      };
      /* Capture, so the fixture keeps following a hand that has left the 46px
         target — which it will, because the gesture is an arc and the target is
         a square in the middle of it. */
      try { sw.setPointerCapture(e.pointerId); } catch (err) {}
      start();
      /* No preventDefault here, which is a departure from the pull cord and a
         considered one. It is the usual way to stop a drag selecting the text
         behind it, but it also cancels the focus a press gives a button, and
         restoring that by hand is worse than not taking it: focus moved from
         script counts as focus moved by the keyboard, so every click on the lamp
         would leave the focus ring a click is not supposed to draw. The
         selection is already handled where it belongs — `user-select: none` on
         the switch in site.css — and a drag that starts on an unselectable box
         selects nothing. */
    });

    document.addEventListener('pointermove', function (e) {
      if (!hand || e.pointerId !== hand.id) return;

      var dx = e.clientX - hand.m.x;
      /* A pendulum cannot be pushed upward past its own pivot, and a hand that
         goes above the ceiling is still asking for the sideways part of what it
         did. Flooring the drop rather than dropping the whole sample is what
         keeps an up-and-across drag working as the across drag it mostly is. */
      var dy = Math.max(e.clientY - hand.m.y, 1);

      var moved = Math.sqrt(
        (e.clientX - hand.x0) * (e.clientX - hand.x0) +
        (e.clientY - hand.y0) * (e.clientY - hand.y0));
      if (moved > hand.far) hand.far = moved;

      hand.angle = soften(Math.atan2(dx, dy), hand.m.limit);
    });

    function release(e) {
      if (!hand || e.pointerId !== hand.id) return;
      var h = hand;
      hand = null;
      try { sw.releasePointerCapture(h.id); } catch (err) {}

      if (h.far < TAP) {
        /* A press that never moved is a click, and the click event about to fire
           is what flips the page. All this adds is the shove the finger actually
           gave: a poke on the axis does nothing, a poke on the rim rocks it. */
        vel -= POKE * (h.x0 - h.m.x);
      } else {
        /* Everything else was a drag. The throw is capped so that the swing it
           buys stays inside the room measured at the press: for a pendulum the
           reach is √(θ² + (ω/rate)²), so solving that for ω is the largest fling
           the page has space for. A cap rather than a wall — the lamp is slowed
           on the way out, not stopped on the way there. */
        var room = h.m.limit * h.m.limit - angle * angle;
        var cap = room > 0 ? h.m.rate * Math.sqrt(room) : 0;
        if (vel > cap) vel = cap;
        if (vel < -cap) vel = -cap;
        swallow = true;
      }
      start();
    }

    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', release);

    /* The one click this file takes away, and it is taken in the capture phase
       at the document, which is where js/mode.js is listening in the bubble
       phase. Stopping it there is what keeps the seam one-way: this file knows
       the system's control exists, the system's control knows nothing about
       drags. Cleared on the next press as well as here, because a release
       outside the button fires no click at all and a flag left standing would
       eat the NEXT one — which, for someone using the keyboard, is a switch that
       ignores every second Enter. */
    document.addEventListener('click', function (e) {
      if (!swallow) return;
      swallow = false;
      if (e.target.closest && e.target.closest('.lamp-switch') === sw) {
        e.stopPropagation();
        e.preventDefault();
      }
    }, true);

    write();
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('.lamp'), function (lamp) {
      var host = lamp.parentElement;
      var sw = host && host.querySelector('.lamp-switch');
      if (sw) rig(lamp, sw);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
