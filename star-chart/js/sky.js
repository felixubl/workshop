/* The projection and the drawing. Given a scene -- objects already reduced to
   altitude and azimuth -- this file decides where each one lands on the canvas
   and what it looks like. It reads no elements and no state of its own.

   The chart is stereographic and looks at the sky from the inside, the way you
   do. That is why east is on the LEFT with north at the top: the map is not a
   map of the ground, it is what you see with your head tipped back. Every
   planisphere ever printed does the same thing and it is the single detail
   that most often gets built backwards. */
var Sky = (function () {
  'use strict';

  var RAD = Math.PI / 180;
  var DEG = 180 / Math.PI;

  /* The whole sky, north up. Centring on the zenith leaves the roll angle
     undefined, so azimuth 180 is what pins north to the top. */
  function initialView() {
    return { alt: 90, az: 180, fov: 180 };
  }

  function basis(view) {
    var a = view.alt * RAD, A = view.az * RAD;
    var ca = Math.cos(a), sa = Math.sin(a), cA = Math.cos(A), sA = Math.sin(A);
    return {
      f: [ca * cA, ca * sA, sa],
      up: [-sa * cA, -sa * sA, ca],
      right: [-sA, cA, 0]
    };
  }

  function vector(alt, az) {
    var a = alt * RAD, A = az * RAD, ca = Math.cos(a);
    return [ca * Math.cos(A), ca * Math.sin(A), Math.sin(a)];
  }

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  /* Scale so that the edge of the drawn circle is fov/2 away from the centre.
     tan(fov/4) is the stereographic radius of that edge. */
  function scaleOf(view, radiusPx) {
    return radiusPx / Math.tan(view.fov * RAD / 4);
  }

  function project(view, geom, alt, az) {
    var v = vector(alt, az);
    var c = dot(v, geom.b.f);
    if (c <= -0.999) return null;
    var k = geom.scale / (1 + c);
    return {
      x: geom.cx + k * dot(v, geom.b.right),
      y: geom.cy - k * dot(v, geom.b.up),
      cos: c
    };
  }

  function unproject(view, geom, x, y) {
    var px = (x - geom.cx) / geom.scale, py = -(y - geom.cy) / geom.scale;
    var d2 = px * px + py * py;
    var c = (1 - d2) / (1 + d2);
    var k = (1 + c);
    var v = [
      geom.b.f[0] * c + geom.b.right[0] * px * k + geom.b.up[0] * py * k,
      geom.b.f[1] * c + geom.b.right[1] * px * k + geom.b.up[1] * py * k,
      geom.b.f[2] * c + geom.b.right[2] * px * k + geom.b.up[2] * py * k
    ];
    var n = Math.sqrt(dot(v, v));
    return { alt: Math.asin(v[2] / n) * DEG, az: (Math.atan2(v[1], v[0]) * DEG + 360) % 360 };
  }

  function geometry(view, width, height) {
    var radius = Math.min(width, height) / 2;
    return {
      b: basis(view), scale: scaleOf(view, radius),
      cx: width / 2, cy: height / 2, radius: radius,
      width: width, height: height
    };
  }

  /* A star's mark grows as it brightens. The exponent is gentler than the real
     flux ratio, which would make Sirius a blot and everything else invisible;
     this is the compromise every printed chart makes. */
  function starRadius(mag, limit, zoom) {
    var d = Math.max(0, limit - mag);
    return (0.55 + 0.62 * Math.pow(d, 0.86)) * zoom;
  }

  /* Five roles and no more, keyed off B-V. Past five an encoding stops sorting
     and starts decorating. The values are read from the page so the chart
     answers to the mode switch like everything else. */
  var CLASSES = ['hot', 'white', 'yellow', 'orange', 'red'];

  function colourIndex(bv) {
    if (bv == null) return 1;
    if (bv < 0.0) return 0;
    if (bv < 0.3) return 1;
    if (bv < 0.6) return 2;
    if (bv < 1.0) return 3;
    return 4;
  }

  function palette(el) {
    var cs = getComputedStyle(el);
    var out = { ink: cs.getPropertyValue('--sky-ink').trim(), star: [] };
    for (var i = 0; i < CLASSES.length; i++) {
      out.star.push(cs.getPropertyValue('--w-star-' + CLASSES[i]).trim());
    }
    out.line = cs.getPropertyValue('--sky-line').trim();
    out.rule = cs.getPropertyValue('--sky-rule').trim();
    out.quiet = cs.getPropertyValue('--sky-quiet').trim();
    out.mark = cs.getPropertyValue('--sky-mark').trim();
    out.ground = cs.getPropertyValue('--sky-ground').trim();
    return out;
  }

  function draw(ctx, view, scene, opts) {
    var g = geometry(view, opts.width, opts.height);
    var p = opts.palette;
    var zoom = Math.min(2.4, 180 / view.fov);

    ctx.clearRect(0, 0, opts.width, opts.height);
    ctx.save();

    /* The ground is everything below the horizon. Clipping to the horizon
       circle is what makes the whole-sky view read as a dome rather than a
       rectangle with stars in the corners. */
    var whole = view.fov >= 179.5;
    if (whole) {
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, g.radius, 0, 2 * Math.PI);
      ctx.clip();
    }
    ctx.fillStyle = p.ground;
    ctx.fillRect(0, 0, opts.width, opts.height);

    /* ---- the horizon and the meridian ---- */
    ctx.strokeStyle = p.rule;
    ctx.lineWidth = 2;
    if (whole) {
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, g.radius - 1, 0, 2 * Math.PI);
      ctx.stroke();
    } else {
      strokePath(ctx, sampleAlmucantar(view, g, 0), 2, p.rule);
    }

    /* Altitude rings every thirty degrees, so height above the horizon is
       readable rather than guessed. */
    ctx.lineWidth = 1;
    [30, 60].forEach(function (alt) {
      strokePath(ctx, sampleAlmucantar(view, g, alt), 1, p.quiet);
    });

    /* ---- constellation figures ---- */
    if (opts.figures && scene.figures.length) {
      ctx.strokeStyle = p.line;
      ctx.lineWidth = Math.min(1.6, 1 * zoom);
      ctx.lineCap = 'round';
      for (var i = 0; i < scene.figures.length; i++) {
        var seg = scene.figures[i];
        var a = project(view, g, seg.a.alt, seg.a.az);
        var b = project(view, g, seg.b.alt, seg.b.az);
        if (!a || !b || a.cos < 0.05 || b.cos < 0.05) continue;
        if (seg.highlight) { ctx.save(); ctx.strokeStyle = p.mark; ctx.lineWidth = 2.2; }
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        if (seg.highlight) ctx.restore();
      }
    }

    /* ---- deep sky ---- */
    if (opts.deep) {
      ctx.strokeStyle = p.quiet;
      ctx.lineWidth = 1;
      for (var d = 0; d < scene.deep.length; d++) {
        var o = scene.deep[d];
        var q = project(view, g, o.alt, o.az);
        if (!q || q.cos < 0) continue;
        var s = 3.2 * zoom;
        ctx.beginPath();
        if (o.kind.indexOf('galaxy') >= 0) {
          ctx.ellipse(q.x, q.y, s * 1.4, s * 0.7, 0, 0, 2 * Math.PI);
        } else {
          ctx.arc(q.x, q.y, s, 0, 2 * Math.PI);
        }
        ctx.stroke();
        o._x = q.x; o._y = q.y;
      }
    }

    /* ---- stars ---- */
    var mono = !opts.colour;
    for (var j = 0; j < scene.stars.length; j++) {
      var st = scene.stars[j];
      var pt = project(view, g, st.alt, st.az);
      if (!pt || pt.cos < 0) { st._x = null; continue; }
      var r = starRadius(st.mag, opts.limit, zoom);
      ctx.fillStyle = mono ? p.ink : p.star[colourIndex(st.bv)];
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, 2 * Math.PI);
      ctx.fill();
      st._x = pt.x; st._y = pt.y; st._r = r;
    }

    /* ---- the Sun, the Moon and the planets ---- */
    var sunPoint = (scene.sunAlt != null)
      ? project(view, g, scene.sunAlt, scene.sunAz) : null;
    if (opts.bodies) {
      for (var k = 0; k < scene.bodies.length; k++) {
        var body = scene.bodies[k];
        var bp = project(view, g, body.alt, body.az);
        if (!bp || bp.cos < 0) { body._x = null; continue; }
        drawBody(ctx, body, bp, zoom, p, g, sunPoint);
        body._x = bp.x; body._y = bp.y;
      }
    }

    /* ---- labels last, so nothing is drawn over a name ---- */
    if (opts.names) drawLabels(ctx, view, g, scene, p, zoom, opts);

    ctx.restore();
    return g;
  }

  function drawBody(ctx, body, bp, zoom, p, g, sunPoint) {
    /* The disc is drawn at its true angular size once that is bigger than the
       mark it would otherwise get, which happens for the Sun and Moon only. */
    var apparent = body.semidiameter ? body.semidiameter * g.scale : 0;
    /* The Sun and Moon get a floor of their own. At the whole-sky zoom their
       true half-degree is barely two pixels, and a Moon too small to show a
       phase is a Moon drawn for nothing. Star marks are exaggerated on every
       printed chart for the same reason; this is that exaggeration, kept to
       the two objects that have a visible disc at all. */
    var floor = (body.name === 'Sun' || body.name === 'Moon') ? 5.5 : 2.6;
    var r = Math.max(floor * zoom, apparent);

    if (body.name === 'Moon') {
      drawMoon(ctx, body, bp, r, p, sunPoint);
      return;
    }
    ctx.fillStyle = body.name === 'Sun' ? p.mark : p.ink;
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, r, 0, 2 * Math.PI);
    ctx.fill();
    if (body.name !== 'Sun') {
      /* A ring around a planet says "this is not a star" without spending a
         colour on it. */
      ctx.strokeStyle = p.ground;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, r + 1.8, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.strokeStyle = p.quiet;
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, r + 2.6, 0, 2 * Math.PI);
      ctx.stroke();
    }
  }

  /* The terminator is an ellipse, not a second circle: the edge of the lit
     half of a sphere is a circle in space, and a circle seen at an angle
     projects to an ellipse. Drawing it as an arc of a circle is the usual
     shortcut and it makes a gibbous moon look like it has had a bite taken
     out of it.

     The lit part is drawn in INK, because on a printed chart the part you can
     see is the part that gets ink. And the bright limb is aimed straight at
     the Sun's own position on the canvas rather than through position angles
     and the parallactic angle: the Sun is where the light comes from, so on
     any projection whatever, the lit side faces it. */
  function drawMoon(ctx, body, bp, r, p, sunPoint) {
    var f = 2 * body.illuminated - 1;
    var aim = sunPoint
      ? Math.atan2(sunPoint.y - bp.y, sunPoint.x - bp.x)
      : (body.waxing ? 0 : Math.PI);

    ctx.save();
    ctx.translate(bp.x, bp.y);
    ctx.rotate(aim);

    ctx.strokeStyle = p.quiet;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, 2 * Math.PI);
    ctx.stroke();

    ctx.fillStyle = p.ink;
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    ctx.ellipse(0, 0, r * Math.abs(f), r, 0, Math.PI / 2, -Math.PI / 2, f <= 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawLabels(ctx, view, g, scene, p, zoom, opts) {
    ctx.fillStyle = p.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    var placed = [];

    function fits(x, y, w, h) {
      for (var i = 0; i < placed.length; i++) {
        var q = placed[i];
        if (x < q.x + q.w && x + w > q.x && y < q.y + q.h && y + h > q.y) return false;
      }
      placed.push({ x: x, y: y, w: w, h: h });
      return true;
    }

    /* Order is priority: whatever is offered a patch of canvas first keeps
       it. The Sun, Moon and planets come before star names, and the figure
       names come last because they are the one label a reader can work out
       for themselves from the shape. */
    if (opts.bodies) {
      ctx.font = '600 12px var(--pp-font-mono, monospace)';
      for (var b = 0; b < scene.bodies.length; b++) {
        var bd = scene.bodies[b];
        if (bd._x == null) continue;
        var w3 = ctx.measureText(bd.name).width;
        if (!fits(bd._x + 10, bd._y - 7, w3, 14)) continue;
        ctx.fillText(bd.name, bd._x + 10, bd._y);
      }
    }

    if (opts.figures) {
      ctx.font = '600 11px var(--pp-font-mono, monospace)';
      ctx.fillStyle = p.quiet;
      for (var c = 0; c < scene.constellations.length; c++) {
        var con = scene.constellations[c];
        var cp = project(view, g, con.alt, con.az);
        if (!cp || cp.cos < 0.1) continue;
        var w = ctx.measureText(con.label).width;
        if (!fits(cp.x - w / 2, cp.y - 7, w, 14)) continue;
        ctx.fillText(con.label, cp.x - w / 2, cp.y);
      }
    }

    ctx.font = '12px var(--pp-font-mono, monospace)';
    ctx.fillStyle = p.ink;
    var named = scene.stars.filter(function (s) { return s.name && s._x != null; });
    named.sort(function (a, b) { return a.mag - b.mag; });
    for (var i = 0; i < named.length && i < 40; i++) {
      var s = named[i];
      if (s.mag > Math.min(opts.limit, 2.6) && view.fov > 60) continue;
      var w2 = ctx.measureText(s.name).width;
      if (!fits(s._x + s._r + 4, s._y - 7, w2, 14)) continue;
      ctx.fillText(s.name, s._x + s._r + 4, s._y);
    }

    if (opts.deep) {
      ctx.font = '11px var(--pp-font-mono, monospace)';
      ctx.fillStyle = p.quiet;
      for (var d = 0; d < scene.deep.length; d++) {
        var o = scene.deep[d];
        if (o._x == null) continue;
        var label = o.name || ('M' + o.m);
        var w4 = ctx.measureText(label).width;
        if (!fits(o._x + 7, o._y - 6, w4, 12)) continue;
        ctx.fillText(label, o._x + 7, o._y);
      }
    }
  }

  /* A circle of constant altitude, sampled and drawn as a polyline. */
  function sampleAlmucantar(view, g, alt) {
    var pts = [];
    for (var az = 0; az <= 360; az += 3) {
      var q = project(view, g, alt, az);
      pts.push(q && q.cos > 0 ? q : null);
    }
    return pts;
  }

  function strokePath(ctx, pts, width, colour) {
    ctx.save();
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    var down = false;
    for (var i = 0; i < pts.length; i++) {
      if (!pts[i]) { down = false; continue; }
      if (!down) { ctx.moveTo(pts[i].x, pts[i].y); down = true; }
      else ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* Nearest thing to a point, in screen space, within a forgiving radius --
     forgiving because a finger is wider than a star. */
  function pick(scene, x, y, opts) {
    var best = null, bestD = (opts && opts.radius) || 22;
    function consider(o, kind) {
      if (o._x == null) return;
      var d = Math.hypot(o._x - x, o._y - y);
      if (d < bestD) { bestD = d; best = { object: o, kind: kind, distance: d }; }
    }
    if (opts.bodies) scene.bodies.forEach(function (b) { consider(b, 'body'); });
    if (opts.deep) scene.deep.forEach(function (o) { consider(o, 'deep'); });
    scene.stars.forEach(function (s) { consider(s, 'star'); });
    return best;
  }

  return {
    initialView: initialView, geometry: geometry, project: project,
    unproject: unproject, draw: draw, pick: pick, palette: palette,
    starRadius: starRadius, colourIndex: colourIndex, classes: CLASSES
  };
})();
if (typeof module !== 'undefined') module.exports = Sky;
