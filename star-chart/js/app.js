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
   'detailSub', 'detailRows', 'statusPlace', 'statusTime', 'statusSky', 'stage'
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
      if (s.mag > limit) { s._x = null; continue; }
      /* Proper motion as a straight-line nudge on the unit sphere. Over a
         century the largest of these is a fifth of a degree and the geometry
         of the shortcut costs far less than that. */
      var v = [s.v[0] + s.pm[0] * years, s.v[1] + s.pm[1] * years, s.v[2] + s.pm[2] * years];
      var h = apply(fromJ2000, v);
      var n = Math.sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]);
      h[0] /= n; h[1] /= n; h[2] /= n;
      var aa = altAz(h);
      s.alt = aa.alt; s.az = aa.az; s._x = null;
      if (aa.alt > -2) drawn.push(s);
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
            if (a.alt == null || b.alt == null) continue;
            if (a.alt < -2 && b.alt < -2) continue;
            figures.push({ a: a, b: b, con: key,
                           highlight: state.selection && state.selection.con === key });
            anyUp = true;
          }
          for (var r = 0; r < line.length; r++) {
            var st = stars[line[r]];
            if (st.alt == null) continue;
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

    var deep = [];
    if (ui.optDeep.checked) {
      for (var d = 0; d < cat.dso.length; d++) {
        var o = cat.dso[d];
        var hv = apply(fromJ2000, o.v);
        var da = altAz(hv);
        o.alt = da.alt; o.az = da.az; o._x = null;
        if (da.alt > -2) deep.push(o);
      }
    }

    var bodies = [];
    if (ui.optBodies.checked) {
      var list = Ephem.all(jdTt);
      for (var b = 0; b < list.length; b++) {
        var body = list[b];
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
        /* The faintest-magnitude control has to mean one thing across the
           whole chart. A sky set to what the naked eye can see should not
           carry Neptune at magnitude 7.8 just because it is a planet. The Sun
           and Moon are exempt: they are not points and nobody sets a limit
           meaning to hide them. */
        var alwaysDrawn = body.name === 'Sun' || body.name === 'Moon';
        if (ba.alt > -6 && (alwaysDrawn || body.magnitude <= limit)) bodies.push(body);
      }
      /* Brightest first. Labels are placed in list order and the first one
         to claim a patch of canvas keeps it, so the Sun must be offered a
         place before Mercury sitting two degrees away from it. */
      bodies.sort(function (x, y) { return x.magnitude - y.magnitude; });
    }

    scene = { stars: drawn, figures: figures, constellations: conLabels,
              deep: deep, bodies: bodies, lst: lst, jdTt: jdTt, jdUt: jdUt,
              sun: ui.optBodies.checked ? null : null };
    var sunPos = sunAltAz(jdTt, obs);
    scene.sunAlt = sunPos.alt;
    scene.sunAz = sunPos.az;

    ui.countOut.textContent = drawn.length.toLocaleString() + ' up';
    needsScene = false;
    updateStatus();
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
    needsDraw = false;
  }

  function drawMarker(g) {
    var sel = state.selection;
    if (!sel || sel.alt == null) return;
    var p = Sky.project(state.view, g, sel.alt, sel.az);
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
      if (!p || p.cos < 0.02) { el.style.display = 'none'; return; }
      el.style.display = '';
      var pull = 0.93;
      el.style.left = (g.cx + (p.x - g.cx) * pull) + 'px';
      el.style.top = (g.cy + (p.y - g.cy) * pull) + 'px';
    });
  }

  function frame() {
    if (needsScene) buildScene();
    if (needsDraw) draw();
    requestAnimationFrame(frame);
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
  }

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
        state.view.az = (drag.az + dx * perPx / Math.max(0.25, Math.cos(state.view.alt * RAD)) + 360) % 360;
        state.view.alt = Math.max(-20, Math.min(90, drag.alt + dy * perPx));
        needsDraw = true;
      }
      return;
    }
    if (ev.pointerType === 'mouse') hoverAt(p);
  });

  function hoverAt(p) {
    if (!scene) return;
    var hit = Sky.pick(scene, p.x, p.y, {
      bodies: ui.optBodies.checked, deep: ui.optDeep.checked, radius: 14
    });
    var key = hit ? (hit.kind + (hit.object.hr || hit.object.m || hit.object.name)) : null;
    if (key !== state.hover) {
      state.hover = key;
      ui.sky.style.cursor = hit ? 'pointer' : '';
    }
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

  ui.reset.addEventListener('click', function () {
    state.view = Sky.initialView();
    needsDraw = true;
  });

  ui.detailClose.addEventListener('click', hideDetail);

  ui.here.addEventListener('click', function () {
    ui.here.textContent = 'asking…';
    Places.here().then(function (p) {
      setPlace(p);
      ui.here.textContent = 'here';
    }).catch(function (err) {
      ui.here.textContent = 'here';
      note(err && err.code === 1 ? 'permission refused' : 'could not get a position');
    });
  });

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

  loadCatalogue().catch(function (err) {
    ui.loading.hidden = false;
    ui.loading.textContent = 'the catalogue did not load: ' + err.message;
  });
})();
