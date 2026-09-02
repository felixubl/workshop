/* The page. Everything that touches an element or an event lives here; the
   arithmetic is in astro.js and ephem.js, the drawing in sky.js.

   The one idea worth knowing before reading on: precession, nutation, the
   Earth's rotation and the observer's latitude are all rotations, and a
   rotation composed with a rotation is one rotation. So the whole reduction
   from a year-2000 catalogue position to a direction in the local sky is a
   single 3x3 matrix, rebuilt when the clock or the place moves and then
   applied to nine thousand stars as nine multiplications each. Doing it star
   by star through the trigonometric route costs about a second a frame; this
   costs about a millisecond.

   The exception is the panel: when you actually select a star, its readout
   comes from Astro.starOfDate, the slow and exact route, because a number a
   reader can copy down should not be the fast approximation. The two agree to
   well under an arcsecond, which is a fraction of a pixel. */
(function () {
  'use strict';

  var RAD = Astro.RAD, DEG = Astro.DEG;

  var ui = {};
  ['place', 'here', 'when', 'now', 'play', 'rate', 'limit', 'countOut', 'reset',
   'optFigures', 'optNames', 'optBodies', 'optDeep', 'optColour',
   'sky', 'loading', 'detail', 'detailClose', 'detailKind', 'detailName',
   'detailSub', 'detailRows', 'statusPlace', 'statusTime', 'statusSky', 'stage',
   'find', 'findResults', 'upList', 'skyHover', 'fovOut', 'zoomIn', 'zoomOut'
  ].forEach(function (id) { ui[id] = document.getElementById(id); });
  ui.stage = document.getElementById('stage');
  ui.holder = document.querySelector('.sky-holder');
  ui.compass = document.querySelector('.compass');

  var state = {
    place: { label: 'Vienna, Austria', lat: 48.2085, lon: 16.3721, elevation: 171,
             timezone: 'Europe/Vienna' },
    time: new Date(),
    following: true,
    playing: false,
    view: Sky.initialView(),
    limit: 5,
    selection: null,
    hover: null
  };

  var cat = null;      /* the catalogue, as loaded */
  var stars = null;    /* working array, with unit vectors */
  var scene = null;
  var ctx = ui.sky.getContext('2d');
  var palette = null;
  var needsScene = true;
  var needsDraw = true;

  /* ---- matrices ------------------------------------------------------ */

  function mul(a, b) {
    var o = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < 3; i++)
      for (var j = 0; j < 3; j++)
        o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    return o;
  }

  function apply(m, v) {
    return [
      m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
    ];
  }

  function precessionMatrix(t) {
    var A = Astro.ARCSEC;
    var z1 = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) * A;
    var z2 = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) * A;
    var th = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) * A;
    var cz = Math.cos(z1), sz = Math.sin(z1);
    var cZ = Math.cos(z2), sZ = Math.sin(z2);
    var ct = Math.cos(th), st = Math.sin(th);
    return [
      cz * ct * cZ - sz * sZ, -sz * ct * cZ - cz * sZ, -st * cZ,
      cz * ct * sZ + sz * cZ, -sz * ct * sZ + cz * cZ, -st * sZ,
      cz * st, -sz * st, ct
    ];
  }

  function rotX(a) {
    var c = Math.cos(a), s = Math.sin(a);
    return [1, 0, 0, 0, c, s, 0, -s, c];
  }
  function rotZ(a) {
    var c = Math.cos(a), s = Math.sin(a);
    return [c, s, 0, -s, c, 0, 0, 0, 1];
  }

  function nutationMatrix(t) {
    var n = Astro.nutation(t);
    var eps = Astro.obliquity(t);
    return mul(rotX(-(eps + n.deps)), mul(rotZ(-n.dpsi), rotX(eps)));
  }

  /* Equatorial of date -> north, east, up at the observer. */
  function observerMatrix(lst, latDeg) {
    var phi = latDeg * RAD;
    var cl = Math.cos(lst), sl = Math.sin(lst);
    var hourAngle = [cl, sl, 0, sl, -cl, 0, 0, 0, 1];
    var cp = Math.cos(phi), sp = Math.sin(phi);
    var horizon = [-sp, 0, cp, 0, -1, 0, cp, 0, sp];
    return mul(horizon, hourAngle);
  }

  function altAz(v) {
    return {
      alt: Math.asin(Math.max(-1, Math.min(1, v[2]))) * DEG,
      az: (Math.atan2(v[1], v[0]) * DEG + 360) % 360
    };
  }

  /* ---- the scene ----------------------------------------------------- */

  function buildScene() {
    if (!cat) return;
    var jdUt = Astro.julianDay(state.time);
    var jdTt = Astro.ttFromUt(jdUt);
    var t = Astro.centuries(jdTt);
    var years = (jdTt - Astro.J2000) / 365.25;
    var lst = Astro.localSidereal(jdUt, jdTt, state.place.lon);

    var obs = observerMatrix(lst, state.place.lat);
    var fromJ2000 = mul(obs, mul(nutationMatrix(t), precessionMatrix(t)));

    var limit = state.limit;
    var drawn = [];
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      /* Every star is reduced, not only the ones the limit lets through. The
         magnitude limit decides what is DRAWN, and that is a separate
         question from where a star is. Reducing them all costs nine
         multiplications each and buys a list of what is up and a finder that
         both keep working when the limit moves. It also removes a real fault:
         skipping a star left its alt and az at whatever they were the last
         time the limit was high enough, so lowering the limit froze a figure
         vertex in place while the rest of the sky turned. */
      /* Proper motion as a straight-line nudge on the unit sphere. Over a
         century the largest of these is a fifth of a degree and the geometry
         of the shortcut costs far less than that. */
      var v = [s.v[0] + s.pm[0] * years, s.v[1] + s.pm[1] * years, s.v[2] + s.pm[2] * years];
      var h = apply(fromJ2000, v);
      var n = Math.sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]);
      h[0] /= n; h[1] /= n; h[2] /= n;
      var aa = altAz(h);
      s.alt = aa.alt; s.az = aa.az; s._x = null;
      if (s.mag <= limit && aa.alt > -2) drawn.push(s);
    }

    var figures = [];
    var conLabels = [];
    if (ui.optFigures.checked) {
      for (var key in cat.figures) {
        var polys = cat.figures[key];
        var sumX = 0, sumY = 0, sumZ = 0, count = 0, anyUp = false;
        for (var p = 0; p < polys.length; p++) {
          var line = polys[p];
          for (var q = 0; q + 1 < line.length; q++) {
            var a = stars[line[q]], b = stars[line[q + 1]];
            /* A line joins two stars you can click, so both ends have to be
               drawn. Now that every star carries a position this has to be
               asked in magnitudes; a null alt no longer means "not drawn". */
            if (a.mag > limit || b.mag > limit) continue;
            if (a.alt < -2 && b.alt < -2) continue;
            figures.push({ a: a, b: b, con: key,
                           highlight: state.selection && state.selection.con === key });
            anyUp = true;
          }
          for (var r = 0; r < line.length; r++) {
            var st = stars[line[r]];
            if (st.mag > limit) continue;
            var av = st.alt * RAD, azv = st.az * RAD, ca = Math.cos(av);
            sumX += ca * Math.cos(azv); sumY += ca * Math.sin(azv); sumZ += Math.sin(av);
            count++;
          }
        }
        if (anyUp && count) {
          var cen = altAz([sumX / count, sumY / count, sumZ / count]);
          if (cen.alt > 0) {
            conLabels.push({ alt: cen.alt, az: cen.az, con: key,
                             label: conName(key).name });
          }
        }
      }
    }

    /* Placed whether or not the switch draws them, for the same reason the
       faint stars are: the finder has to be able to answer "where is M31" on
       a chart with deep sky turned off. */
    var deep = [];
    for (var d = 0; d < cat.dso.length; d++) {
      var o = cat.dso[d];
      var hv = apply(fromJ2000, o.v);
      var da = altAz(hv);
      o.alt = da.alt; o.az = da.az; o._x = null;
      if (ui.optDeep.checked && da.alt > -2) deep.push(o);
    }

    var all = Ephem.all(jdTt);
    {
      for (var b = 0; b < all.length; b++) {
        var body = all[b];
        var ra = body.ra, dec = body.dec;
        /* The Moon is close enough that where you stand moves it by up to a
           degree -- two of its own widths. Everything else is far enough away
           that the same correction is under an arcsecond. */
        if (body.name === 'Moon') {
          var topo = Astro.topocentric(ra, dec, body.distance, lst,
                                       state.place.lat, state.place.elevation);
          ra = topo.ra; dec = topo.dec;
        }
        var vd = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
        var ha = apply(obs, vd);
        var ba = altAz(ha);
        body.alt = ba.alt; body.az = ba.az; body._x = null;
        body.topoRa = ra; body.topoDec = dec;
      }
      /* Brightest first. Labels are placed in list order and the first one
         to claim a patch of canvas keeps it, so the Sun must be offered a
         place before Mercury sitting two degrees away from it. */
      all.sort(function (x, y) { return x.magnitude - y.magnitude; });
    }

    var bodies = [];
    if (ui.optBodies.checked) {
      for (var k = 0; k < all.length; k++) {
        var bd = all[k];
        /* The faintest-magnitude control has to mean one thing across the
           whole chart. A sky set to what the naked eye can see should not
           carry Neptune at magnitude 7.8 just because it is a planet. The Sun
           and Moon are exempt: they are not points and nobody sets a limit
           meaning to hide them. */
        var alwaysDrawn = bd.name === 'Sun' || bd.name === 'Moon';
        if (bd.alt > -6 && (alwaysDrawn || bd.magnitude <= limit)) bodies.push(bd);
      }
    }

    scene = { stars: drawn, figures: figures, constellations: conLabels,
              deep: deep, bodies: bodies, allBodies: all, lst: lst,
              jdTt: jdTt, jdUt: jdUt, years: years, fromJ2000: fromJ2000 };
    var sunPos = sunAltAz(jdTt, obs);
    scene.sunAlt = sunPos.alt;
    scene.sunAz = sunPos.az;

    ui.countOut.textContent = drawn.length.toLocaleString() + ' drawn';
    needsScene = false;
    updateStatus();
    buildUpList();
    /* The panel is a reading of the sky at a moment, and the moment moves. It
       is rebuilt with the scene so a selected planet's altitude counts down
       while you watch instead of going quietly stale. */
    if (state.selection) showDetail(state.selection);
  }

  /* The Sun's place is wanted twice over: for the twilight readout, and to
     aim the Moon's lit edge. It is below the horizon most of the time this
     tool is useful, which is exactly when it still has to be right. */
  function sunAltAz(jdTt, obs) {
    var s = Ephem.sun(jdTt);
    var v = [Math.cos(s.dec) * Math.cos(s.ra), Math.cos(s.dec) * Math.sin(s.ra), Math.sin(s.dec)];
    return altAz(apply(obs, v));
  }

  function conName(ab) {
    if (!cat._conIndex) {
      cat._conIndex = {};
      cat.cons.forEach(function (c) { cat._conIndex[c.ab] = c; });
    }
    return cat._conIndex[ab] || { ab: ab, name: ab, gen: ab, en: ab };
  }

  /* ---- drawing ------------------------------------------------------- */

  /* Measure the canvas, not its holder. The holder carries a two-pixel border
     and getBoundingClientRect reports the border box, so sizing the canvas off
     it made the canvas four pixels wider than the box it sits in -- enough to
     push the drawing off-centre against the frame and to put every click two
     pixels out. The canvas is already stretched to the content box by CSS; all
     this has to do is match the backing store to it. */
  function canvasBox() { return ui.sky.getBoundingClientRect(); }

  function resize() {
    var rect = canvasBox();
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    ui.sky.width = Math.round(rect.width * dpr);
    ui.sky.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsDraw = true;
  }

  function draw() {
    if (!scene) return;
    if (!palette) palette = Sky.palette(ui.sky);
    var rect = canvasBox();
    var g = Sky.draw(ctx, state.view, scene, {
      width: rect.width, height: rect.height,
      palette: palette, limit: state.limit,
      figures: ui.optFigures.checked, names: ui.optNames.checked,
      bodies: ui.optBodies.checked, deep: ui.optDeep.checked,
      colour: ui.optColour.checked
    });
    drawMarker(g);
    placeCompass(g);
    ui.fovOut.textContent = Math.round(state.view.fov) + '°';
    needsDraw = false;
  }

  function drawMarker(g) {
    var sel = state.selection;
    if (!sel || !sel.object || sel.object.alt == null) return;
    /* The object, not the position it had when it was picked: the sky turns
       while the panel is open and the mark has to turn with it. */
    var p = Sky.project(state.view, g, sel.object.alt, sel.object.az);
    if (!p || p.cos < 0) return;
    ctx.save();
    var r = 13;
    var ticks = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    /* Four ticks rather than a ring: a ring around a star reads as another
       object, and the gap is what says "this one". The ticks are laid down
       twice, once heavy in the ground colour, so they stay legible where they
       cross a dense part of the field. Shape carries this, not colour --
       the section's one breach is already spent on the full bleed. */
    [[palette.ground, 3.5], [palette.mark, 1.5]].forEach(function (pass) {
      ctx.strokeStyle = pass[0];
      ctx.lineWidth = pass[1];
      ctx.beginPath();
      ticks.forEach(function (d) {
        ctx.moveTo(p.x + d[0] * r, p.y + d[1] * r);
        ctx.lineTo(p.x + d[0] * (r - 5), p.y + d[1] * (r - 5));
      });
      ctx.stroke();
    });
    ctx.restore();
  }

  function placeCompass(g) {
    if (!ui.compass) return;
    var marks = { n: 0, e: 90, s: 180, w: 270 };
    Object.keys(marks).forEach(function (k) {
      var el = ui.compass.querySelector('.compass-' + k);
      if (!el) return;
      var p = Sky.project(state.view, g, 0, marks[k]);
      /* Zero, not a small positive number. On the whole-sky view the eye
         points at the zenith and every horizon point is at exactly ninety
         degrees from it, so the cosine is zero -- give or take the 6e-17 that
         cos(90 degrees) actually is. A guard of 0.02 rejected all four, which
         is why the default view of this chart has never carried a compass.
         Behind the observer is what wants rejecting, and that is negative. */
      if (!p || p.cos < -0.02) { el.style.display = 'none'; return; }
      var pull = 0.93;
      var x = g.cx + (p.x - g.cx) * pull;
      var y = g.cy + (p.y - g.cy) * pull;
      /* A compass point seen almost edge-on projects hundreds of pixels
         outside the chart, and the letter went with it -- an "S" adrift in the
         margin of the page, because nothing here clips. Facing one direction
         puts the two beside it in exactly that position, so this is the
         ordinary case rather than a corner one. */
      if (x < 0 || y < 0 || x > g.width || y > g.height) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    });
  }

  function frame() {
    if (glide) stepGlide();
    if (needsScene) buildScene();
    if (needsDraw) draw();
    requestAnimationFrame(frame);
  }

  /* Turning to a named thing. A jump lands you somewhere with no idea which
     way you turned, so the view is carried there over four-tenths of a second
     -- long enough to read the movement, short enough not to wait for it.
     Azimuth goes the short way round, and the field is interpolated
     geometrically because zooming is a ratio, not a difference. */
  var glide = null;

  function glideTo(to) {
    var from = { alt: state.view.alt, az: state.view.az, fov: state.view.fov };
    glide = { from: from, to: to, t0: performance.now(), ms: 420,
              dAz: ((to.az - from.az + 540) % 360) - 180 };
  }

  function stepGlide() {
    var u = Math.min(1, (performance.now() - glide.t0) / glide.ms);
    var e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    var v = state.view;
    v.alt = glide.from.alt + (glide.to.alt - glide.from.alt) * e;
    v.az = (glide.from.az + glide.dAz * e + 360) % 360;
    v.fov = glide.from.fov * Math.pow(glide.to.fov / glide.from.fov, e);
    needsDraw = true;
    if (u >= 1) glide = null;
  }

  /* Point the chart at something. A whole-sky view is narrowed on the way,
     because "show me Saturn" on a 180-degree fisheye shows you a dot in a
     field of dots. An already-narrowed field is left alone: the reader set
     it. */
  function pointAt(alt, az) {
    glideTo({
      alt: Math.max(-10, Math.min(88, alt)),
      az: (az + 360) % 360,
      fov: state.view.fov > 110 ? 55 : state.view.fov
    });
  }

  /* ---- catalogue ----------------------------------------------------- */

  function loadCatalogue() {
    return fetch('data/catalogue.json').then(function (r) {
      if (!r.ok) throw new Error('catalogue ' + r.status);
      return r.json();
    }).then(function (data) {
      cat = data;
      var ix = {};
      cat.meta.fields.forEach(function (n, i) { ix[n] = i; });
      cat.ix = ix;
      stars = cat.stars.map(function (row) {
        var ra = row[ix.ra] * RAD, dec = row[ix.dec] * RAD;
        var cd = Math.cos(dec), sd = Math.sin(dec);
        var ca = Math.cos(ra), sa = Math.sin(ra);
        var v = [cd * ca, cd * sa, sd];
        /* Proper motion resolved onto the sphere once, so the per-frame path
           is addition instead of trigonometry. pmra is the projected motion,
           so it rides the east-pointing unit vector directly. */
        var mra = row[ix.pmra] * Astro.ARCSEC;
        var mdec = row[ix.pmdec] * Astro.ARCSEC;
        var eA = [-sa, ca, 0];
        var eD = [-sd * ca, -sd * sa, cd];
        return {
          row: row, mag: row[ix.mag], bv: row[ix.bv], hr: row[ix.hr],
          name: row[ix.name], con: cat.cons[row[ix.con]] ? cat.cons[row[ix.con]].ab : null,
          v: v,
          pm: [mra * eA[0] + mdec * eD[0], mra * eA[1] + mdec * eD[1], mra * eA[2] + mdec * eD[2]],
          alt: null, az: null
        };
      });
      stars.forEach(function (st) { starByHr[st.hr] = st; });
      cat.dso.forEach(function (o) {
        var ra = o.ra * RAD, dec = o.dec * RAD, cd = Math.cos(dec);
        o.v = [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec)];
      });
      ui.loading.hidden = true;
      needsScene = true;
      needsDraw = true;
    });
  }

  /* ---- readouts ------------------------------------------------------ */

  function updateStatus() {
    var p = state.place;
    ui.statusPlace.textContent = p.label + '  ' +
      Math.abs(p.lat).toFixed(2) + (p.lat >= 0 ? '°N ' : '°S ') +
      Math.abs(p.lon).toFixed(2) + (p.lon >= 0 ? '°E' : '°W');
    ui.statusTime.textContent = Places.toLocalInput(state.time, p.timezone).replace('T', ' ') +
      ' ' + Places.zoneLabel(state.time, p.timezone) +
      (state.following ? ' (now)' : '');
    var alt = scene ? scene.sunAlt : null;
    ui.statusSky.textContent = alt == null ? '—' : twilight(alt);
  }

  /* The names are the surveyor's, not the poet's: the Sun's depth below the
     horizon is what decides whether a magnitude-5 star is actually there to
     be seen. */
  function twilight(sunAlt) {
    if (sunAlt > 0) return 'daylight — the stars are drawn, but you cannot see them';
    if (sunAlt > -6) return 'civil twilight';
    if (sunAlt > -12) return 'nautical twilight';
    if (sunAlt > -18) return 'astronomical twilight';
    return 'night';
  }

  function hoursMinutes(deg) {
    var h = deg / 15;
    var hh = Math.floor(h), mm = (h - hh) * 60;
    return hh + 'h ' + Math.floor(mm) + 'm ' + Math.round((mm - Math.floor(mm)) * 60) + 's';
  }

  function dms(deg) {
    var sign = deg < 0 ? '−' : '+';
    var a = Math.abs(deg);
    var d = Math.floor(a), m = (a - d) * 60;
    return sign + d + '° ' + Math.floor(m) + '′ ' + Math.round((m - Math.floor(m)) * 60) + '″';
  }

  function row(label, value) {
    return '<dt>' + label + '</dt><dd>' + value + '</dd>';
  }

  function showDetail(hit) {
    if (!hit) { hideDetail(); return; }
    var o = hit.object;
    state.selection = { alt: o.alt, az: o.az, con: hit.kind === 'star' ? o.con : null,
                        object: o, kind: hit.kind };
    var rows = '';
    ui.detail.hidden = false;

    if (hit.kind === 'star') {
      var ix = cat.ix, r = o.row;
      var con = o.con ? conName(o.con) : null;
      var bay = r[ix.bayer] >= 0 ? cat.greek[r[ix.bayer]] : null;
      var glyph = r[ix.bayer] >= 0 ? cat.glyph[r[ix.bayer]] : '';
      var sup = r[ix.sup] ? String(r[ix.sup]) : '';
      var designation = bay && con ? bay + sup + ' ' + con.gen : null;
      if (!designation && r[ix.flam] && con) designation = r[ix.flam] + ' ' + con.gen;

      ui.detailKind.textContent = 'star';
      ui.detailName.textContent = o.name || designation || ('HR ' + o.hr);
      ui.detailSub.textContent = [o.name ? designation : null,
                                  con ? con.name + ' · ' + con.en : null]
                                  .filter(Boolean).join('  ·  ');

      /* The exact reduction, for the one object being read. */
      var exact = Astro.starOfDate(r[ix.ra], r[ix.dec], r[ix.pmra], r[ix.pmdec], scene.jdTt);
      rows += row('magnitude', o.mag.toFixed(2));
      if (r[ix.ly]) rows += row('distance', r[ix.ly].toLocaleString() + ' light years');
      if (r[ix.sp] >= 0) rows += row('spectrum', cat.sp[r[ix.sp]]);
      if (glyph) rows += row('Bayer', glyph + sup + ' ' + (con ? con.ab : ''));
      if (r[ix.flam]) rows += row('Flamsteed', r[ix.flam] + ' ' + (con ? con.ab : ''));
      rows += row('catalogue', 'HR ' + o.hr + (r[ix.hip] ? ' · HIP ' + r[ix.hip] : ''));
      rows += row('right ascension', hoursMinutes(exact.ra * DEG));
      rows += row('declination', dms(exact.dec * DEG));
      rows += row('altitude', o.alt.toFixed(2) + '°' + (o.alt < 0 ? ' (below the horizon)' : ''));
      rows += row('azimuth', o.az.toFixed(2) + '° ' + compassWord(o.az));
    } else if (hit.kind === 'body') {
      ui.detailKind.textContent = o.name === 'Sun' || o.name === 'Moon' ? '' : 'planet';
      ui.detailName.textContent = o.name;
      ui.detailSub.textContent = constellationOf(o.topoRa || o.ra, o.topoDec || o.dec);
      rows += row('magnitude', o.magnitude.toFixed(2));
      rows += row('distance', o.name === 'Moon'
        ? Math.round(o.km).toLocaleString() + ' km'
        : o.distance.toFixed(4) + ' AU  (' + Math.round(o.distance * 499.005) + ' light seconds)');
      if (o.semidiameter) rows += row('apparent size', (o.semidiameter * DEG * 7200).toFixed(1) + '″ across');
      if (o.illuminated != null && o.name !== 'Sun') {
        rows += row('lit', (o.illuminated * 100).toFixed(1) + '%' +
          (o.name === 'Moon' ? ' · ' + moonPhaseName(o) : ''));
      }
      if (o.elongation != null && o.name !== 'Sun') {
        rows += row('from the Sun', (o.elongation * DEG).toFixed(1) + '°');
      }
      rows += row('right ascension', hoursMinutes((o.topoRa || o.ra) * DEG));
      rows += row('declination', dms((o.topoDec || o.dec) * DEG));
      rows += row('altitude', o.alt.toFixed(2) + '°' + (o.alt < 0 ? ' (below the horizon)' : ''));
      rows += row('azimuth', o.az.toFixed(2) + '° ' + compassWord(o.az));
    } else {
      ui.detailKind.textContent = o.kind;
      ui.detailName.textContent = o.name || ('Messier ' + o.m);
      ui.detailSub.textContent = 'M' + o.m + (o.ngc && o.ngc !== ('M' + o.m) ? ' · ' + o.ngc : '') +
        '  ·  ' + conName(o.con).name;
      if (o.mag != null) rows += row('magnitude', o.mag.toFixed(1));
      if (o.size) rows += row('apparent size', o.size + '′ across');
      rows += row('right ascension', hoursMinutes(o.ra));
      rows += row('declination', dms(o.dec));
      rows += row('altitude', o.alt.toFixed(2) + '°' + (o.alt < 0 ? ' (below the horizon)' : ''));
      rows += row('azimuth', o.az.toFixed(2) + '° ' + compassWord(o.az));
    }
    ui.detailRows.innerHTML = rows;
    needsDraw = true;
    markSelectedRows();
  }

  function moonPhaseName(m) {
    var a = m.age;
    if (a < 0.02 || a > 0.98) return 'new';
    if (a < 0.23) return 'waxing crescent';
    if (a < 0.27) return 'first quarter';
    if (a < 0.48) return 'waxing gibbous';
    if (a < 0.52) return 'full';
    if (a < 0.73) return 'waning gibbous';
    if (a < 0.77) return 'last quarter';
    return 'waning crescent';
  }

  function compassWord(az) {
    var names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S',
                 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return names[Math.round(az / 22.5) % 16];
  }

  /* Which figure a point falls in, by nearest drawn star. Constellation
     BOUNDARIES are a separate catalogue this tool does not carry, so this is
     honest about being an approximation rather than pretending to the IAU
     borders. */
  function constellationOf(ra, dec) {
    var best = null, bestD = 1e9;
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      if (s.mag > 5 || !s.con) continue;
      var d = Astro.angularSeparation(ra, dec, s.row[cat.ix.ra] * RAD, s.row[cat.ix.dec] * RAD);
      if (d < bestD) { bestD = d; best = s.con; }
    }
    return best ? 'in ' + conName(best).name : '';
  }

  function hideDetail() {
    state.selection = null;
    ui.detail.hidden = true;
    needsDraw = true;
    markSelectedRows();
  }

  /* ---- naming things ------------------------------------------------- */

  function esc(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* The best short name a star has: the one people use, then the Bayer
     letter, then the Flamsteed number, then the catalogue entry. */
  function starLabel(s) {
    if (s.name) return s.name;
    var ix = cat.ix, r = s.row;
    var con = s.con ? conName(s.con) : null;
    var sup = r[ix.sup] ? String(r[ix.sup]) : '';
    if (r[ix.bayer] >= 0 && con) return cat.glyph[r[ix.bayer]] + sup + ' ' + con.ab;
    if (r[ix.flam] && con) return r[ix.flam] + ' ' + con.ab;
    return 'HR ' + s.hr;
  }

  /* A name, the quiet half-line beside it that says what kind of thing it is,
     and how bright. Between them they are what identifies an object, so the
     list, the hover readout and the search results all ask here rather than
     each writing their own version of the same three fields. */
  function describe(o, kind) {
    if (kind === 'body') {
      var note = o.name === 'Sun' ? '' : o.name === 'Moon' ? moonPhaseName(o) : 'planet';
      return { name: o.name, note: note, mag: o.magnitude };
    }
    if (kind === 'deep') return { name: o.name || ('M' + o.m), note: o.kind, mag: o.mag };
    if (kind === 'con') {
      var c = conName(o.ab);
      /* Orion's English name is Orion. Printing it twice says nothing. */
      return { name: c.name, note: c.en === c.name ? 'figure' : c.en, mag: null };
    }
    return { name: starLabel(o), note: o.con ? conName(o.con).name : '', mag: o.mag };
  }

  function keyOf(o, kind) {
    if (kind === 'body') return 'b:' + o.name;
    if (kind === 'deep') return 'd:' + o.m;
    if (kind === 'con') return 'c:' + o.ab;
    return 's:' + o.hr;
  }

  /* A key back to the thing it names. Everything it can return already has a
     current altitude and azimuth, because the scene places every star, every
     Messier object and every planet whether or not the switches draw it. */
  function byKey(key) {
    var tag = key.charAt(0), id = key.slice(2), i;
    if (tag === 'b') {
      for (i = 0; i < scene.allBodies.length; i++) {
        if (scene.allBodies[i].name === id) return { object: scene.allBodies[i], kind: 'body' };
      }
      return null;
    }
    if (tag === 'd') {
      for (i = 0; i < cat.dso.length; i++) {
        if (String(cat.dso[i].m) === id) return { object: cat.dso[i], kind: 'deep' };
      }
      return null;
    }
    if (tag === 'c') {
      var c = figureCentre(id);
      return c ? { object: { ab: id, alt: c.alt, az: c.az }, kind: 'con' } : null;
    }
    return starByHr[id] ? { object: starByHr[id], kind: 'star' } : null;
  }

  /* Where a figure sits, as the mean direction of its own stars. The same
     sum the labels use, asked for one constellation at a time. */
  function figureCentre(ab) {
    var polys = cat.figures[ab];
    if (!polys) return null;
    var x = 0, y = 0, z = 0, count = 0;
    for (var p = 0; p < polys.length; p++) {
      for (var q = 0; q < polys[p].length; q++) {
        var st = stars[polys[p][q]];
        if (st.alt == null) continue;
        var a = st.alt * RAD, A = st.az * RAD, ca = Math.cos(a);
        x += ca * Math.cos(A); y += ca * Math.sin(A); z += Math.sin(a);
        count++;
      }
    }
    return count ? altAz([x / count, y / count, z / count]) : null;
  }

  /* ---- what is up ---------------------------------------------------- */

  function rowHtml(o, kind) {
    var d = describe(o, kind);
    var key = keyOf(o, kind);
    var sel = state.selection;
    var on = sel && sel.object && keyOf(sel.object, sel.kind) === key;
    return '<button class="sky-row' + (on ? ' is-on' : '') + '" type="button" data-key="' +
      esc(key) + '">' +
      '<span class="sky-row-name">' + esc(d.name) +
      (d.note ? ' <em>' + esc(d.note) + '</em>' : '') + '</span>' +
      '<span class="sky-row-where">' +
      (o.alt > 0 ? compassWord(o.az) + ' ' + Math.round(o.alt) + '\u00b0' : 'below') +
      '</span>' +
      '<span class="sky-row-mag">' + magnitude(d.mag) + '</span>' +
      '</button>';
  }

  /* One decimal, a real minus sign, and no "-0.0" -- Arcturus at -0.04 is
     brighter than zero and must not be printed as if it were dimmer. */
  function magnitude(mag) {
    if (mag == null) return '';
    var v = mag.toFixed(1);
    return (v === '-0.0' ? '0.0' : v).replace('-', '\u2212');
  }

  /* "What can I see right now" is the question the page is opened with, and
     until now the only way to answer it was to hunt the chart. This is the
     answer written out: everything above the horizon worth stepping outside
     for, brightest first, each row turning the chart to what it names. */
  function buildUpList() {
    if (!scene) return;
    var html = '';

    var up = scene.allBodies.filter(function (b) { return b.alt > 0; });
    if (up.length) {
      /* Named for what is actually in it. A heading that promises the Sun at
         midnight is a heading a reader stops trusting. */
      var parts = [];
      if (up.some(function (b) { return b.name === 'Sun'; })) parts.push('the Sun');
      if (up.some(function (b) { return b.name === 'Moon'; })) parts.push('the Moon');
      if (up.some(function (b) { return b.name !== 'Sun' && b.name !== 'Moon'; })) parts.push('the planets');
      html += '<p class="up-head">' + parts.join(', ').replace(/,([^,]*)$/, ' and$1') + '</p>';
      up.forEach(function (b) { html += rowHtml(b, 'body'); });
    }

    /* Magnitude two rather than the chart's own limit: this list says what is
       up, and that does not change because you turned the drawing down. Two
       is roughly what survives a lit street. Five degrees, because anything
       lower is behind a building. */
    var bright = [];
    for (var i = 0; i < stars.length; i++) {
      if (stars[i].mag <= 2.0 && stars[i].alt > 5) bright.push(stars[i]);
    }
    bright.sort(function (a, b) { return a.mag - b.mag; });
    if (bright.length) {
      html += '<p class="up-head">the brightest stars</p>';
      bright.slice(0, 12).forEach(function (st) { html += rowHtml(st, 'star'); });
    }

    if (ui.optDeep.checked) {
      var dso = scene.deep.filter(function (o) { return o.alt > 10 && o.mag != null; });
      dso.sort(function (a, b) { return a.mag - b.mag; });
      if (dso.length) {
        html += '<p class="up-head">the deep sky</p>';
        dso.slice(0, 8).forEach(function (o) { html += rowHtml(o, 'deep'); });
      }
    }

    ui.upList.innerHTML = html || '<p class="up-empty">nothing is above the horizon</p>';
  }

  /* The lists are rewritten wholesale as the sky turns, so the selected row
     is marked in place instead: a click on the chart must not cost a rebuild
     of two lists. */
  function markSelectedRows() {
    var sel = state.selection;
    var key = sel && sel.object ? keyOf(sel.object, sel.kind) : null;
    [ui.upList, ui.findResults].forEach(function (box) {
      box.querySelectorAll('.sky-row').forEach(function (b) {
        b.classList.toggle('is-on', b.getAttribute('data-key') === key);
      });
    });
  }

  function chooseKey(key) {
    var hit = byKey(key);
    if (!hit) return;
    /* A figure is a region, not an object, so it gets turned to and nothing
       is selected -- there is no reading to put in the panel. */
    if (hit.kind !== 'con') showDetail(hit);
    pointAt(hit.object.alt, hit.object.az);
  }

  ui.upList.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.sky-row');
    if (btn) chooseKey(btn.getAttribute('data-key'));
  });

  /* ---- the finder ---------------------------------------------------- */

  /* One flat index of everything nameable, built once and searched by
     substring. Twelve thousand short strings is nothing to scan, and one
     index means a proper name, a Bayer letter, a Messier number and a
     planet all arrive through the same path instead of four. */
  var index = null;
  var starByHr = {};

  function buildIndex() {
    index = [];
    var ix = cat.ix, i;

    for (i = 0; i < scene.allBodies.length; i++) {
      var b = scene.allBodies[i];
      index.push({ key: 'b:' + b.name, hay: b.name.toLowerCase(), rank: -30 });
    }

    for (i = 0; i < stars.length; i++) {
      var st = stars[i], r = st.row, con = st.con ? conName(st.con) : null;
      var sup = r[ix.sup] ? String(r[ix.sup]) : '';
      var terms = [];
      if (st.name) terms.push(st.name);
      if (con && r[ix.bayer] >= 0) {
        terms.push(cat.greek[r[ix.bayer]] + sup + ' ' + con.ab);
        terms.push(cat.greek[r[ix.bayer]] + sup + ' ' + con.gen);
        terms.push(cat.glyph[r[ix.bayer]] + sup + ' ' + con.ab);
      }
      if (con && r[ix.flam]) terms.push(r[ix.flam] + ' ' + con.ab);
      terms.push('hr ' + st.hr);
      index.push({ key: 's:' + st.hr, hay: terms.join('|').toLowerCase(), rank: st.mag });
    }

    cat.dso.forEach(function (o) {
      var t = ['m' + o.m, 'messier ' + o.m];
      if (o.name) t.push(o.name);
      if (o.ngc) t.push(o.ngc);
      index.push({ key: 'd:' + o.m, hay: t.join('|').toLowerCase(),
                   rank: o.mag == null ? 9 : o.mag });
    });

    cat.cons.forEach(function (c) {
      index.push({ key: 'c:' + c.ab,
                   hay: [c.name, c.gen, c.en, c.ab].join('|').toLowerCase(), rank: -20 });
    });
  }

  function lookup(query) {
    if (!scene) return [];
    if (!index) buildIndex();
    var needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    var found = [];
    for (var i = 0; i < index.length; i++) {
      var at = index[i].hay.indexOf(needle);
      if (at < 0) continue;
      /* A match at the head of one of an entry's terms beats one buried in
         the middle, so "mar" offers Mars before Markab. */
      found.push({ key: index[i].key, rank: index[i].rank,
                   head: at === 0 || index[i].hay.charAt(at - 1) === '|' });
    }
    found.sort(function (a, b) {
      if (a.head !== b.head) return a.head ? -1 : 1;
      return a.rank - b.rank;
    });
    return found.slice(0, 8).map(function (f) { return byKey(f.key); }).filter(Boolean);
  }

  function renderFind() {
    var q = ui.find.value;
    if (q.trim().length < 2) { ui.findResults.innerHTML = ''; return; }
    var hits = lookup(q);
    ui.findResults.innerHTML = hits.length
      ? hits.map(function (h) { return rowHtml(h.object, h.kind); }).join('')
      : '<p class="up-empty">nothing by that name in the catalogue</p>';
  }

  ui.find.addEventListener('input', renderFind);

  ui.find.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      var first = ui.findResults.querySelector('.sky-row');
      if (!first) return;
      ev.preventDefault();
      chooseKey(first.getAttribute('data-key'));
      ui.findResults.innerHTML = '';
    } else if (ev.key === 'Escape') {
      ui.findResults.innerHTML = '';
      ui.find.blur();
    }
  });

  ui.findResults.addEventListener('click', function (ev) {
    var btn = ev.target.closest('.sky-row');
    if (!btn) return;
    chooseKey(btn.getAttribute('data-key'));
    ui.findResults.innerHTML = '';
  });

  /* ---- interaction --------------------------------------------------- */

  var drag = null;

  function localPoint(ev) {
    var rect = ui.sky.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function currentGeometry() {
    var rect = canvasBox();
    return Sky.geometry(state.view, rect.width, rect.height);
  }

  ui.sky.addEventListener('pointerdown', function (ev) {
    glide = null;
    ui.skyHover.hidden = true;
    state.hover = null;
    ui.sky.setPointerCapture(ev.pointerId);
    var p = localPoint(ev);
    drag = { x: p.x, y: p.y, startX: p.x, startY: p.y, moved: false,
             alt: state.view.alt, az: state.view.az };
  });

  ui.sky.addEventListener('pointermove', function (ev) {
    var p = localPoint(ev);
    if (drag) {
      var dx = p.x - drag.startX, dy = p.y - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) {
        var g = currentGeometry();
        var perPx = state.view.fov / (2 * g.radius);
        /* The cursor over the chart is a grab cursor, so the sky has to come
           with the hand. A point at a larger azimuth projects further to the
           right, so pulling the pointer right has to LOWER the view's
           azimuth for that point to travel with it. The sign was the other
           way round: dragging left moved the sky right, while the vertical
           axis followed the hand correctly. Two axes disagreeing is what
           made the chart feel unsteerable, and it reads as a broken
           projection rather than a wrong sign. */
        state.view.az = (drag.az - dx * perPx / Math.max(0.25, Math.cos(state.view.alt * RAD)) + 360) % 360;
        state.view.alt = Math.max(-20, Math.min(90, drag.alt + dy * perPx));
        needsDraw = true;
      }
      return;
    }
    if (ev.pointerType === 'mouse') hoverAt(p);
  });

  ui.sky.addEventListener('pointerleave', function () {
    ui.skyHover.hidden = true;
    state.hover = null;
  });

  /* Sweeping the pointer over the chart names what is under it. Clicking for
     the full reading is still there; this is what turns nine thousand
     identical dots into a thing you can read without committing to one. */
  function hoverAt(p) {
    if (!scene) return;
    var hit = Sky.pick(scene, p.x, p.y, {
      bodies: ui.optBodies.checked, deep: ui.optDeep.checked, radius: 14
    });
    ui.sky.style.cursor = hit ? 'pointer' : '';
    if (!hit) {
      ui.skyHover.hidden = true;
      state.hover = null;
      return;
    }
    var key = keyOf(hit.object, hit.kind);
    if (key !== state.hover) {
      state.hover = key;
      var d = describe(hit.object, hit.kind);
      ui.skyHover.innerHTML = esc(d.name) +
        (d.note ? ' <em>' + esc(d.note) + '</em>' : '') +
        (d.mag == null ? '' : ' <em>' + d.mag.toFixed(1) + '</em>');
      ui.skyHover.hidden = false;
    }
    /* Anchored to the object rather than to the cursor. The pick radius is
       wider than a star, so a label following the pointer jitters beside a
       mark that is not moving. */
    ui.skyHover.classList.toggle('is-left', hit.object._x > canvasBox().width - 170);
    ui.skyHover.style.left = hit.object._x + 'px';
    ui.skyHover.style.top = hit.object._y + 'px';
  }

  ui.sky.addEventListener('pointerup', function (ev) {
    var wasDrag = drag && drag.moved;
    drag = null;
    if (wasDrag) return;
    var p = localPoint(ev);
    var hit = Sky.pick(scene, p.x, p.y, {
      bodies: ui.optBodies.checked, deep: ui.optDeep.checked,
      radius: ev.pointerType === 'mouse' ? 16 : 26
    });
    showDetail(hit);
  });

  ui.sky.addEventListener('pointercancel', function () { drag = null; });

  ui.sky.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    zoomBy(Math.exp(ev.deltaY * 0.0015));
  }, { passive: false });

  function zoomBy(factor) {
    glide = null;
    state.view.fov = Math.max(2, Math.min(180, state.view.fov * factor));
    if (state.view.fov >= 179.5) { state.view.alt = 90; state.view.az = 180; }
    needsDraw = true;
  }

  /* Pinch. Two pointers, and the distance between them is the whole gesture. */
  var pinch = null;
  var active = {};
  ui.sky.addEventListener('pointerdown', function (ev) { active[ev.pointerId] = localPoint(ev); trackPinch(); });
  ui.sky.addEventListener('pointermove', function (ev) {
    if (active[ev.pointerId]) { active[ev.pointerId] = localPoint(ev); trackPinch(); }
  });
  ['pointerup', 'pointercancel'].forEach(function (t) {
    ui.sky.addEventListener(t, function (ev) { delete active[ev.pointerId]; pinch = null; });
  });

  function trackPinch() {
    var ids = Object.keys(active);
    if (ids.length !== 2) { pinch = null; return; }
    var a = active[ids[0]], b = active[ids[1]];
    var d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch == null) { pinch = d; drag = null; return; }
    if (d > 0 && pinch > 0) zoomBy(pinch / d);
    pinch = d;
  }

  /* ---- controls ------------------------------------------------------ */

  function setTime(date, following) {
    state.time = date;
    state.following = !!following;
    ui.when.value = Places.toLocalInput(date, state.place.timezone);
    needsScene = true; needsDraw = true;
  }

  function setPlace(p) {
    state.place = {
      label: p.label || p.name, lat: p.lat, lon: p.lon,
      elevation: p.elevation || 0, timezone: p.timezone || Places.deviceZone()
    };
    ui.place.value = state.place.label;
    ui.when.value = Places.toLocalInput(state.time, state.place.timezone);
    needsScene = true; needsDraw = true;
    remember();
  }

  ui.now.addEventListener('click', function () { setTime(new Date(), true); });

  ui.when.addEventListener('change', function () {
    var d = Places.fromLocalInput(ui.when.value, state.place.timezone);
    if (d) setTime(d, false);
  });

  ui.play.addEventListener('click', function () {
    state.playing = !state.playing;
    ui.play.textContent = state.playing ? 'stop' : 'play';
    if (state.playing) state.following = false;
  });

  ui.limit.addEventListener('input', function () {
    var v = parseFloat(ui.limit.value);
    if (isFinite(v)) { state.limit = Math.max(1, Math.min(6.5, v)); needsScene = true; }
  });

  ['optFigures', 'optNames', 'optBodies', 'optDeep', 'optColour'].forEach(function (k) {
    ui[k].addEventListener('change', function () { needsScene = true; needsDraw = true; });
  });

  ui.reset.addEventListener('click', function () { glideTo(Sky.initialView()); });

  /* Standing outside and turning to face a direction. Thirty degrees up is
     where the eye rests when you look at a horizon, and a hundred and ten
     degrees across is about what you take in without moving your head. */
  document.querySelectorAll('[data-look]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var to = btn.getAttribute('data-look');
      if (to === 'up') glideTo({ alt: 85, az: state.view.az, fov: 100 });
      else glideTo({ alt: 30, az: parseFloat(to), fov: 110 });
    });
  });

  ui.zoomIn.addEventListener('click', function () { zoomBy(1 / 1.4); });
  ui.zoomOut.addEventListener('click', function () { zoomBy(1.4); });

  function turn(dAz, dAlt) {
    glide = null;
    state.view.az = (state.view.az + dAz + 360) % 360;
    state.view.alt = Math.max(-20, Math.min(90, state.view.alt + dAlt));
    needsDraw = true;
  }

  /* The keys are on the window rather than on the canvas. A canvas that has
     to be focused before it answers is a canvas that looks broken, and giving
     it a tab stop buys a focus ring around the chart for nothing. */
  window.addEventListener('keydown', function (ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var t = ev.target;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    var step = Math.max(2, state.view.fov / 6);
    if (ev.key === 'ArrowLeft') turn(-step, 0);
    else if (ev.key === 'ArrowRight') turn(step, 0);
    else if (ev.key === 'ArrowUp') turn(0, step);
    else if (ev.key === 'ArrowDown') turn(0, -step);
    else if (ev.key === '+' || ev.key === '=') zoomBy(1 / 1.4);
    else if (ev.key === '-' || ev.key === '_') zoomBy(1.4);
    else if (ev.key === 'Escape') hideDetail();
    else return;
    ev.preventDefault();
  });

  ui.detailClose.addEventListener('click', hideDetail);

  function useHere() {
    ui.here.textContent = 'asking…';
    return Places.here().then(function (p) {
      note('');
      setPlace(p);
      ui.here.textContent = 'here';
    }).catch(function (err) {
      ui.here.textContent = 'here';
      note(err && err.code === 1 ? 'permission refused' : 'could not get a position');
    });
  }

  ui.here.addEventListener('click', useHere);

  /* The page is opened to ask what is over ME, now. The clock answers the
     second half by itself. The first half cannot be taken without asking,
     and a permission box thrown at a page you have only just opened is bad
     manners -- so it is taken silently only where the browser says the
     permission has already been given, and otherwise the page says plainly
     that it is showing somewhere else and where the button is. */
  function offerHere() {
    if (!navigator.permissions || !navigator.permissions.query) return;
    navigator.permissions.query({ name: 'geolocation' }).then(function (st) {
      if (st.state === 'granted') useHere();
      else note('This is ' + state.place.label + '. Press “here” for the sky over your own place.');
    }).catch(function () { /* older Safari has no geolocation permission to query */ });
  }

  var searchTimer = null, searchAbort = null;
  ui.place.addEventListener('input', function () {
    var q = ui.place.value.trim();
    var coords = Places.parseCoords(q);
    if (coords) {
      note('');
      setPlace({ label: coords.lat.toFixed(4) + ', ' + coords.lon.toFixed(4),
                 lat: coords.lat, lon: coords.lon, timezone: Places.deviceZone() });
      return;
    }
    clearTimeout(searchTimer);
    if (q.length < 3) return;
    searchTimer = setTimeout(function () { runSearch(q); }, 400);
  });

  function runSearch(q) {
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    note('looking up “' + q + '”…');
    Places.search(q, searchAbort.signal).then(function (list) {
      if (!list.length) { note('no place by that name'); return; }
      note('');
      setPlace(list[0]);
      if (list.length > 1) offer(list);
    }).catch(function (e) {
      if (e.name !== 'AbortError') note('the geocoder did not answer');
    });
  }

  function offer(list) {
    var wrap = document.getElementById('alternatives');
    if (!wrap) return;
    wrap.innerHTML = '';
    list.slice(0, 6).forEach(function (p, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-ghost' + (i === 0 ? ' is-on' : '');
      b.textContent = p.label;
      b.addEventListener('click', function () {
        setPlace(p);
        wrap.querySelectorAll('button').forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
      });
      wrap.appendChild(b);
    });
  }

  function note(text) {
    var el = document.getElementById('placeNote');
    if (el) el.textContent = text || '';
  }

  /* ---- persistence --------------------------------------------------- */

  function remember() {
    try {
      localStorage.setItem('star-chart-place', JSON.stringify(state.place));
    } catch (e) { /* private mode, and nothing here is worth an error */ }
  }

  function recall() {
    try {
      var raw = localStorage.getItem('star-chart-place');
      if (raw) {
        var p = JSON.parse(raw);
        if (p && isFinite(p.lat) && isFinite(p.lon)) return p;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ---- start --------------------------------------------------------- */

  var lastTick = performance.now();
  function tick() {
    var now = performance.now();
    var dt = (now - lastTick) / 1000;
    lastTick = now;
    if (state.playing) {
      setTime(new Date(state.time.getTime() + dt * 1000 * parseFloat(ui.rate.value)), false);
    } else if (state.following) {
      var real = new Date();
      if (Math.abs(real - state.time) > 20000) setTime(real, true);
    }
    setTimeout(tick, 200);
  }

  window.addEventListener('resize', function () { resize(); palette = null; });
  var modeObserver = new MutationObserver(function () { palette = null; needsDraw = true; });
  modeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });

  var saved = recall();
  if (saved) state.place = saved;
  ui.place.value = state.place.label;
  ui.limit.value = state.limit;
  setTime(new Date(), true);
  resize();
  requestAnimationFrame(frame);
  tick();

  if (!saved) offerHere();

  loadCatalogue().catch(function (err) {
    ui.loading.hidden = false;
    ui.loading.textContent = 'the catalogue did not load: ' + err.message;
  });
})();
