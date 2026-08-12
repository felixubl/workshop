/* Eclipse Countdown.

   One question, asked properly: from where I am standing, when does the Moon
   next cross the Sun, and what will it look like when it does?

   Everything on the page comes from two files borrowed from Eclipse Recon
   next door — the catalogue of Besselian elements (js/eclipses.js) and the
   reduction of them (js/bessel.js). Nothing about an eclipse is stored here,
   and nothing is fetched to compute one: a date, a set of coefficients and a
   pair of coordinates are enough for every number on this page. The one
   thing this tool cannot know on its own is where "Reykjavík" is, and that is
   the only request it ever makes.

   The drawing is the geometry, not an illustration of it. The Moon's centre
   is placed at the true separation and the true position angle for the
   instant on the clock, rotated so the zenith is up, which is how a sky looks
   to someone standing in it. */
(function () {
  'use strict';

  var RAD = Math.PI / 180;
  var DEG = 180 / Math.PI;

  var SUN_PX = 52;          // the Sun's radius in the drawing
  var SUN_DEG = 0.2666;     // and in the sky — the mean apparent radius, which
                            // varies by under 2% over the year and is only
                            // used to place the horizon against the disc
  var UNDER = -SUN_DEG;     // an altitude at which no part of the Sun is up:
                            // its centre one radius below the horizon
  var FRAME = 150;          // half the drawing's side, so it holds ±2.9 radii
  var PREVIEW_MS = 15000;   // how long the whole eclipse takes when played
  var STORE = 'eclipse-countdown-at';
  var RECON_STORE = 'recon-eclipses';   // eclipses pasted into Eclipse Recon

  var ui = {};
  ['place', 'find', 'here', 'whereForm', 'hint', 'alts', 'altsRow', 'empty',
   'report', 'whereCap', 'disc', 'discState', 'discNote', 'play', 'playLabel',
   'clockLabel', 'clockTime', 'clockAt', 'stats', 'phaseRows', 'phaseZone',
   'note', 'later', 'laterList',
   'horizon', 'hzStatus', 'hzBody', 'hzAsk', 'hzGo'].forEach(function (id) {
    ui[id] = document.getElementById(id);
  });

  var state = {
    at: null,        // {lat, lon, name, tz}
    geo: null,       // the observer in geocentric form, cached per position
    ecl: null,       // the eclipse being counted down to
    circ: null,      // its local circumstances there
    targets: [],     // the moments the clock counts to
    stateWord: '',   // last word the disc said, so aria only changes with it
    preview: null    // {started, segs} while the eclipse is being played
  };
  var scene = {};    // the drawing's parts, made once and then moved

  /* ================= the catalogue ================= */

  /* Recon's shipped records, plus anything a reader pasted into Recon from a
     NASA page. Reading its store rather than keeping one of our own means an
     eclipse added over there is simply here too. */
  function catalogue() {
    var all = ECLIPSES.slice();
    try {
      JSON.parse(localStorage.getItem(RECON_STORE) || '[]').forEach(function (e) {
        if (e && e.id && !all.some(function (x) { return x.id === e.id; })) all.push(e);
      });
    } catch (err) { /* a broken store is no extra eclipses, not a broken page */ }
    return all.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
  }

  /* Every eclipse on file, as it stands at this position: its local
     circumstances (null when the eclipse never reaches there), and the moment
     it is done with, so an eclipse already over drops out. */
  function survey(lat, lon) {
    return catalogue().map(function (ecl) {
      var circ = Bessel.localCircumstances(ecl, lat, lon, 0);
      var over = circ
        ? (circ.c4 ? circ.c4.date : circ.dateMax).getTime()
        : Date.UTC(ecl.date[0], ecl.date[1] - 1, ecl.date[2]) + 86400000;
      return { ecl: ecl, circ: circ, over: over };
    }).sort(function (a, b) { return a.over - b.over; });
  }

  /* ================= the geometry of one instant ================= */

  /* What the Sun looks like at a given moment: how far the Moon's centre is
     from it (in Sun radii), how big the Moon is against it, which way it lies
     with the zenith up, and how high the Sun itself is. Null outside the
     window the elements were fitted over, where the polynomials are fiction. */
  function frameAt(ecl, at) {
    var day = Date.UTC(ecl.date[0], ecl.date[1] - 1, ecl.date[2]);
    var t = (at - day) / 3600000 + ecl.deltaT / 3600;   // TT hours on the day
    if (!isFinite(t) || Math.abs(t - ecl.t0) > 5) return null;

    var s = Bessel.situation(ecl, t, state.geo, state.at.lon);
    var sunR = (s.L1 + s.L2) / 2;      // the two cone radii carry both discs:
    var moonR = (s.L1 - s.L2) / 2;     // their half-sum and half-difference
    var mag = (s.L1 - s.m) / (s.L1 + s.L2);
    var alt = Bessel.sunAltAz(ecl, t, state.at.lat, state.at.lon);

    return {
      sep: s.m / sunR,
      ratio: moonR / sunR,
      mag: mag,
      cover: Math.max(0, Math.min(1, Bessel.obscuration(mag, s.L1, s.L2))),
      // position angle of the Moon from the Sun's centre, measured on the sky
      // from north through east, then turned so that the zenith is up
      theta: (Math.atan2(s.u, s.v) * DEG - Bessel.parallactic(ecl, t, state.at.lat, state.at.lon)) * RAD,
      alt: alt.alt + Bessel.refraction(alt.alt),
      central: s.m < Math.abs(s.L2),
      annular: s.L2 > 0
    };
  }

  /* ================= the drawing ================= */

  function buildScene() {
    var rays = '';
    for (var i = 0; i < 56; i++) {
      // a corona is not a circle. The rays are a fixed pattern rather than a
      // random one: the same eclipse should look the same on every visit.
      var a = i * (360 / 56);
      var len = 13 + 30 * Math.abs(Math.sin(i * 1.7)) * (0.55 + 0.45 * Math.abs(Math.cos(i * 0.6)));
      var x1 = Math.sin(a * RAD) * (SUN_PX + 1), y1 = -Math.cos(a * RAD) * (SUN_PX + 1);
      var x2 = Math.sin(a * RAD) * (SUN_PX + len), y2 = -Math.cos(a * RAD) * (SUN_PX + len);
      rays += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) +
              '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '"/>';
    }

    /* The Moon is drawn in black and cut to the Sun's face, so it is only ever
       there where it is actually taking light away: a bite during the partial
       phases, a disc inside the ring during an annular one. Totality is the
       one case where the cut comes off — then the silhouette is the Moon's
       own, a little larger than the Sun, standing in front of the corona. */
    ui.disc.innerHTML = [
      '<defs>',
        '<clipPath id="ec-face"><circle cx="0" cy="0" r="' + SUN_PX + '"/></clipPath>',
        '<pattern id="ec-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">',
          '<line class="hatch" x1="0" y1="0" x2="0" y2="7"/>',
        '</pattern>',
      '</defs>',
      '<rect class="sky" x="-150" y="-150" width="300" height="300"/>',
      '<g class="corona is-off" id="ec-corona"><circle class="cor-glow" cx="0" cy="0" r="' +
        (SUN_PX + 16) + '"/>' + rays + '</g>',
      '<circle class="sun" cx="0" cy="0" r="' + SUN_PX + '"/>',
      '<g class="moon-cut" id="ec-cut"><circle class="moon-body" id="ec-body" cx="0" cy="0" r="0"/></g>',
      '<g class="ground is-off" id="ec-ground">',
        '<rect class="erase" id="ec-erase" x="-150" y="0" width="300" height="300"/>',
        '<rect id="ec-hatchband" x="-150" y="0" width="300" height="300" fill="url(#ec-hatch)"/>',
        '<line id="ec-rule" class="horizon" x1="-150" y1="0" x2="150" y2="0"/>',
      '</g>',
      // Both drawn over the ground, because they are notes about where things
      // are rather than things you could see: the Sun once it has set, and the
      // Moon while it is still off the Sun's face.
      '<circle class="ghost is-off" id="ec-ghost" cx="0" cy="0" r="' + SUN_PX + '"/>',
      '<circle class="moon-edge is-off" id="ec-edge" cx="0" cy="0" r="0"/>',
      '<g class="up-mark" aria-hidden="true">',
        '<path d="M-133 -120 v-15 m0 0 -4 5 m4 -5 4 5"/>',
        '<text x="-126" y="-121">zenith</text>',
      '</g>'
    ].join('');

    ['ec-corona', 'ec-cut', 'ec-body', 'ec-edge', 'ec-ghost', 'ec-ground',
     'ec-erase', 'ec-hatchband', 'ec-rule'].forEach(function (id) {
      scene[id] = ui.disc.querySelector('#' + id);
    });
  }

  function show(node, on) { node.classList.toggle('is-off', !on); }

  function paint(f) {
    if (!f) {                       // nowhere near the day: the Sun, plain
      scene['ec-body'].setAttribute('r', 0);
      show(scene['ec-corona'], false);
      show(scene['ec-edge'], false);
      show(scene['ec-ghost'], false);
      show(scene['ec-ground'], false);
      ui.disc.classList.remove('is-night');
      return;
    }

    var r = f.sep * SUN_PX;
    var mx = -r * Math.sin(f.theta);       // east is to the left, as in the sky
    var my = -r * Math.cos(f.theta);
    var mr = f.ratio * SUN_PX;
    var totality = f.central && !f.annular;

    ['ec-body', 'ec-edge'].forEach(function (id) {
      scene[id].setAttribute('cx', mx.toFixed(2));
      scene[id].setAttribute('cy', my.toFixed(2));
      scene[id].setAttribute('r', mr.toFixed(2));
    });
    scene['ec-cut'].classList.toggle('is-free', totality);
    show(scene['ec-corona'], totality);
    show(scene['ec-edge'], r - mr < FRAME * 1.42);
    // Totality is the one moment the sky itself changes, so the drawing's own
    // ground goes out with it.
    ui.disc.classList.toggle('is-night', totality);

    // The horizon, at true scale, which is why it only turns up when the Sun
    // is within about a degree of it — and that is exactly when it matters.
    var y = f.alt / SUN_DEG * SUN_PX;
    show(scene['ec-ground'], y < FRAME);
    show(scene['ec-ghost'], f.alt < UNDER);  // set: the disc is a note now
    if (y < FRAME) {
      var top = Math.max(-FRAME, y);
      scene['ec-erase'].setAttribute('y', top);
      scene['ec-hatchband'].setAttribute('y', top);
      scene['ec-rule'].setAttribute('y1', y);
      scene['ec-rule'].setAttribute('y2', y);
      show(scene['ec-rule'], y > -FRAME);
    }
  }

  /* ================= words for a state ================= */

  function stateOf(f) {
    if (!f || f.mag <= 0) {
      return f && f.alt < UNDER
        ? { word: 'below the horizon', note: 'the Sun is down' }
        : { word: 'not started', note: 'the Sun is whole' };
    }
    var pc = f.cover * 100;
    var covered = (pc < 1 ? pc.toFixed(1) : Math.round(pc)) + '% covered';
    var mag = 'magnitude ' + f.mag.toFixed(2);
    if (f.alt < UNDER) {
      return { word: 'below the horizon', note: covered + ', out of sight' };
    }
    if (f.central && f.annular) return { word: 'ANNULAR', note: mag };
    if (f.central) return { word: 'TOTALITY', note: mag };
    return { word: covered, note: mag };
  }

  /* ================= formatting ================= */

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* A stretch of time, said the way a countdown says it. */
  function span(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    if (d) return d + (d === 1 ? ' day ' : ' days ') + pad(h) + ':' + pad(m) + ':' + pad(s);
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  }

  /* A duration in prose, for the length of totality. */
  function lasting(sec) {
    var m = Math.floor(sec / 60), s = Math.round(sec - m * 60);
    if (s === 60) { m += 1; s = 0; }
    return m ? m + 'm ' + pad(s) + 's' : s + 's';
  }

  function fmt(date, tz, opts) {
    var o = { hour12: false };
    Object.keys(opts).forEach(function (k) { o[k] = opts[k]; });
    if (tz) o.timeZone = tz;
    try {
      return new Intl.DateTimeFormat('en-GB', o).format(date);
    } catch (err) {                 // a zone the browser will not accept
      delete o.timeZone;
      return new Intl.DateTimeFormat('en-GB', o).format(date);
    }
  }

  function clockOf(date, tz) {
    return fmt(date, tz, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function dayOf(date, tz) {
    return fmt(date, tz, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function utOf(date) {
    return fmt(date, 'UTC', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function zoneName() {
    if (state.at.tz) return state.at.tz;
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'your device'; }
    catch (err) { return 'your device'; }
  }

  var POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW',
                'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function compass(az) { return POINTS[Math.round(((az % 360) + 360) % 360 / 22.5) % 16]; }

  function altWord(alt) {
    if (alt < UNDER) return 'below';
    return Math.abs(Math.round(alt)) + '°';
  }

  /* The same fact said in a line rather than a column: how high the Sun is,
     and which way to face for it. */
  function sunWord(alt, az) {
    if (alt < UNDER) return 'below the horizon';
    if (alt < 0.5) return 'on the horizon, ' + compass(az);
    return Math.round(alt) + '° up, ' + compass(az);
  }

  function coordWord(lat, lon) {
    return Math.abs(lat).toFixed(3) + '°' + (lat < 0 ? 'S' : 'N') + ' ' +
           Math.abs(lon).toFixed(3) + '°' + (lon < 0 ? 'W' : 'E');
  }

  /* ================= the report ================= */

  var TYPE_WORD = { total: 'TOTAL', annular: 'ANNULAR', partial: 'PARTIAL' };

  /* The moments the clock counts down to, in order. On a central eclipse the
     deepest moment is not one of them: it falls inside totality, where what a
     reader wants on the clock is how much of it is left. */
  function targetsFor(circ) {
    var out = [];
    var ring = circ.type === 'annular';
    if (circ.c1) out.push({ at: circ.c1.date, label: 'until first contact' });
    if (circ.c2) out.push({ at: circ.c2.date, label: ring ? 'until annularity' : 'until totality' });
    else out.push({ at: circ.dateMax, label: 'until maximum' });
    if (circ.c3) out.push({ at: circ.c3.date, label: ring ? 'of annularity left' : 'of totality left' });
    if (circ.c4) out.push({ at: circ.c4.date, label: 'until last contact' });
    return out;
  }

  function phasesFor(circ) {
    var ring = circ.type === 'annular';
    var out = [];
    if (circ.c1) out.push({ name: 'First contact', say: 'C1', c: circ.c1 });
    if (circ.c2) out.push({ name: ring ? 'Annularity begins' : 'Totality begins', say: 'C2', c: circ.c2 });
    out.push({ name: 'Maximum', say: 'greatest phase', c: { date: circ.dateMax, alt: circ.sunAlt } });
    if (circ.c3) out.push({ name: ring ? 'Annularity ends' : 'Totality ends', say: 'C3', c: circ.c3 });
    if (circ.c4) out.push({ name: 'Last contact', say: 'C4', c: circ.c4 });
    return out;
  }

  function renderReport(pickIndex, rows) {
    var row = rows[pickIndex];
    var ecl = row.ecl, circ = row.circ;
    state.ecl = ecl; state.circ = circ; state.targets = targetsFor(circ);

    ui.report.hidden = false;
    ui.empty.hidden = true;
    ui.whereCap.textContent = coordWord(state.at.lat, state.at.lon);

    var ring = circ.type === 'annular';
    var stats = [
      ['Type', TYPE_WORD[circ.type]],
      ['Maximum obscuration', Math.round(circ.obscuration * 100) + '%'],
      [ring ? 'Annularity lasts' : 'Totality lasts', circ.duration ? lasting(circ.duration) : '—'],
      ['Sun at maximum', sunWord(circ.sunAltApparent, circ.sunAz)],
      ['Date', dayOf(circ.dateMax, state.at.tz)]
    ];
    if (!circ.duration) stats.splice(2, 1);
    ui.stats.innerHTML = stats.map(function (s) {
      return '<div><dt>' + s[0] + '</dt><dd>' + s[1] + '</dd></div>';
    }).join('');

    ui.phaseZone.textContent = 'times at ' + zoneName();
    ui.phaseRows.innerHTML = phasesFor(circ).map(function (p, i) {
      var alt = p.c.alt + Bessel.refraction(p.c.alt);
      return '<tr data-at="' + p.c.date.getTime() + '">' +
        '<th scope="row">' + p.name + '<small>' + p.say + '</small></th>' +
        '<td class="t">' + clockOf(p.c.date, state.at.tz) + '</td>' +
        '<td class="t meta">' + utOf(p.c.date) + '</td>' +
        '<td class="t' + (alt < UNDER ? ' is-under' : '') + '">' + altWord(alt) + '</td>' +
        '</tr>';
    }).join('');

    var notes = [];
    if (circ.type === 'partial') {
      notes.push('The Moon’s full shadow misses this spot: the Sun is never completely ' +
        'covered here, at most ' + Math.round(circ.obscuration * 100) + '%.');
    }
    if (circ.sunAltApparent < 8 && circ.sunAltApparent > UNDER) {
      notes.push('The Sun is ' + (circ.sunAltApparent < 0.5 ? 'on the horizon'
        : 'only ' + Math.round(circ.sunAltApparent) + '° up') + ' at maximum, towards ' +
        compass(circ.sunAz) + '. Check that horizon for buildings or terrain.');
    }
    if (circ.c4 && circ.c4.alt + Bessel.refraction(circ.c4.alt) < UNDER) {
      notes.push('The Sun sets before the eclipse ends: the last phases are below the horizon.');
    }
    if (circ.c1 && circ.c1.alt + Bessel.refraction(circ.c1.alt) < UNDER) {
      notes.push('The Sun rises with the eclipse already under way: the first phases are ' +
        'below the horizon.');
    }
    notes.push(circ.type === 'total'
      ? 'Only totality is safe to view without a solar filter, and only while it lasts.'
      : 'A partially eclipsed Sun needs a solar filter at all times.');
    ui.note.innerHTML = notes.join(' ');

    var later = rows.filter(function (r, i) { return i !== pickIndex; });
    ui.later.hidden = !later.length;
    ui.laterList.innerHTML = later.map(function (r) {
      var when = dayOf(new Date(Date.UTC(r.ecl.date[0], r.ecl.date[1] - 1, r.ecl.date[2])), 'UTC');
      var what;
      if (!r.circ) what = 'not visible here';
      else if (!r.circ.visible) what = TYPE_WORD[r.circ.type].toLowerCase() + ', below the horizon here';
      else what = TYPE_WORD[r.circ.type].toLowerCase() + ', ' +
        Math.round(r.circ.obscuration * 100) + '% covered' +
        (r.circ.duration ? ' for ' + lasting(r.circ.duration) : '');
      return '<li><code>' + when + '</code><span>' + what + '</span></li>';
    }).join('');
  }

  function renderNothing(rows) {
    state.ecl = null; state.circ = null; state.targets = [];
    ui.report.hidden = true;
    ui.empty.hidden = false;
    ui.empty.innerHTML = 'No eclipse on file is visible from ' +
      '<strong>' + escapeHtml(state.at.name) + '</strong>. The catalogue holds ' +
      rows.length + ' still to come (' +
      rows.map(function (r) { return '<code>' + r.ecl.id + '</code>'; }).join(', ') +
      '). More can be added by pasting the Besselian elements from a NASA page ' +
      'into <a href="../eclipse-recon/">Eclipse Recon</a>, which this tool reads.';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ================= the clock ================= */

  function tick(now) {
    if (!state.circ) return;

    if (state.preview) {
      var through = (now - state.preview.started) / PREVIEW_MS;
      if (through >= 1) { stopPreview(); return; }
      var step = previewAt(state.preview, through);
      var pf = frameAt(state.ecl, step.at);
      paint(pf);
      sayState(pf);
      ui.clockLabel.textContent = 'preview, running at ×' + step.rate;
      ui.clockTime.textContent = clockOf(new Date(step.at), state.at.tz);
      ui.clockAt.textContent = 'the whole eclipse in 15 seconds, slowed through the middle';
      markRow(step.at);
      return;
    }

    var t = Date.now();
    var f = frameAt(state.ecl, t);
    paint(f);
    sayState(f);
    markRow(t);

    var next = null;
    for (var i = 0; i < state.targets.length; i++) {
      if (state.targets[i].at.getTime() > t) { next = state.targets[i]; break; }
    }
    if (!next) {                    // done here — the next one is somebody else's
      ui.clockLabel.textContent = 'this eclipse is over';
      ui.clockTime.textContent = '—';
      ui.clockAt.textContent = 'checking for the next one…';
      window.setTimeout(locate, 4000);
      state.circ = null;
      return;
    }
    ui.clockLabel.textContent = next.label;
    ui.clockTime.textContent = span(next.at.getTime() - t);
    ui.clockAt.textContent = clockOf(next.at, state.at.tz) + ' · ' +
      dayOf(next.at, state.at.tz);
  }

  function sayState(f) {
    var s = stateOf(f);
    if (s.word === state.stateWord) return;
    state.stateWord = s.word;
    ui.discState.textContent = s.word;
    ui.discNote.textContent = s.note;
    ui.disc.setAttribute('aria-label', 'The Sun seen from this location: ' + s.word);
  }

  /* Which line of the running order is happening, or is about to. */
  function markRow(at) {
    var rows = ui.phaseRows.children;
    var mark = -1;
    for (var i = 0; i < rows.length; i++) {
      if (Number(rows[i].dataset.at) > at) { mark = i; break; }
    }
    for (var j = 0; j < rows.length; j++) rows[j].classList.toggle('is-next', j === mark);
  }

  var lastSecond = -1;
  function loop(now) {
    window.requestAnimationFrame(loop);
    if (!state.circ) return;
    // live, the page has nothing to say between seconds; in preview it has
    // something to say on every frame.
    var second = Math.floor(Date.now() / 1000);
    if (!state.preview && second === lastSecond) return;
    lastSecond = second;
    tick(now);
  }

  /* ================= preview ================= */

  /* The eclipse, played through in fifteen seconds — but not at one speed.
     An hour of partial phases either side of a minute of totality, run
     linearly, would spend a tenth of a second on the only part anybody came
     for. So the preview runs in three stretches, and gives the middle of the
     thing a third of the time to itself. The rate is printed as it goes,
     which is what makes the slowdown a stated fact rather than a trick. */
  function startPreview() {
    if (!state.circ) return;
    var c = state.circ;
    var start = (c.c1 ? c.c1.date : c.dateMax).getTime() - 45000;
    var end = (c.c4 ? c.c4.date : c.dateMax).getTime() + 45000;
    var midFrom = (c.c2 ? c.c2.date.getTime() - 20000 : c.dateMax.getTime() - 90000);
    var midTo = (c.c3 ? c.c3.date.getTime() + 20000 : c.dateMax.getTime() + 90000);
    midFrom = Math.max(start, Math.min(midFrom, end));
    midTo = Math.min(end, Math.max(midTo, midFrom));
    state.preview = {
      started: window.performance.now(),
      segs: [[start, midFrom, 0.38], [midFrom, midTo, 0.30], [midTo, end, 0.32]]
    };
    ui.play.classList.add('is-on');
    ui.playLabel.textContent = 'Stop';
  }

  /* Where the preview has got to: the simulated moment, and how fast it is
     running there. */
  function previewAt(pv, through) {
    var acc = 0;
    for (var i = 0; i < pv.segs.length; i++) {
      var seg = pv.segs[i];
      if (through <= acc + seg[2] || i === pv.segs.length - 1) {
        var p = Math.min(1, (through - acc) / seg[2]);
        return {
          at: seg[0] + p * (seg[1] - seg[0]),
          rate: Math.round((seg[1] - seg[0]) / (seg[2] * PREVIEW_MS))
        };
      }
      acc += seg[2];
    }
  }

  function stopPreview(quiet) {
    state.preview = null;
    ui.play.classList.remove('is-on');
    ui.playLabel.textContent = 'Preview it';
    lastSecond = -1;
    if (!quiet) tick(window.performance.now());
  }

  /* ================= the horizon ================= */

  /* Recon asks the terrain a wide question and draws a wide picture of it.
     Here the question is narrower and so is the frame: only the strip of sky
     this eclipse crosses, printed upright, because a Sun near setting moves
     mostly downward and a tall frame is where that reads. The axes are
     therefore NOT at the same scale — degrees are marked on both so the
     stretch is stated rather than implied. */

  var hz = { scan: null, key: null, busy: false };

  function hzKey() {
    return state.at && state.ecl
      ? state.at.lat.toFixed(4) + ',' + state.at.lon.toFixed(4) + '|' + state.ecl.id
      : null;
  }

  /* The window the figure is about. Not the whole eclipse: two and a half
     hours of partial phases drawn end to end put the minute of totality
     inside a single pixel, and that minute is the entire question. So the
     frame is the quarter hour either side of the central phase — the
     approach, the event, the exit — or, when there is no central phase,
     the half hour either side of maximum. */
  function hzWindow() {
    var c = state.circ;
    var pad = 12 / 60;                          // hours
    var lo, hi, tight;
    if (c.c2 && c.c3) {
      lo = c.c2.tTT - pad; hi = c.c3.tTT + pad; tight = true;
    } else {
      lo = c.tMax - 0.5; hi = c.tMax + 0.5; tight = false;
    }
    if (c.c1) lo = Math.max(lo, c.c1.tTT);
    if (c.c4) hi = Math.min(hi, c.c4.tTT);
    if (hi <= lo) { lo = c.tMax - 0.25; hi = c.tMax + 0.25; }
    return { lo: lo, hi: hi, tight: tight };
  }

  /* The Sun through that window, evenly, plus a dense pass across the
     central phase so totality is drawn as a run and not as a dot. */
  function hzTrack() {
    var c = state.circ, ecl = state.ecl;
    var w = hzWindow();
    var ts = [];
    for (var i = 0; i <= 72; i++) ts.push(w.lo + (w.hi - w.lo) * i / 72);
    if (c.c2 && c.c3) {
      for (var j = 0; j <= 36; j++) {
        ts.push(c.c2.tTT + (c.c3.tTT - c.c2.tTT) * j / 36);
      }
    }
    ts.sort(function (a, b) { return a - b; });
    return ts.map(function (tt) {
      var sun = Bessel.sunAltAz(ecl, tt, state.at.lat, state.at.lon);
      return {
        tt: tt,
        az: sun.az,
        alt: sun.alt + Bessel.refraction(sun.alt),
        total: !!(c.c2 && c.c3 && tt >= c.c2.tTT && tt <= c.c3.tTT)
      };
    });
  }

  /* What the profile is made of at an azimuth — how far away the thing that
     sets the skyline is, and how high. A block from 40 km out is a mountain
     range; a block from 150 m out is the DEM reading the roof across the
     street, and the reader deserves to know which one they are looking at. */
  function hzFeatureAt(prof, az) {
    var best = null, bd = Infinity;
    prof.forEach(function (p) {
      var d = Math.abs(((p.az - az + 540) % 360) - 180);
      if (d < bd) { bd = d; best = p; }
    });
    return best;
  }

  // the profile's own angle at an azimuth, linear between samples
  function hzAngleAt(prof, az) {
    var n = prof.length;
    if (!n) return -0.6;
    var a0 = prof[0].az;
    var rel = ((az - a0) % 360 + 360) % 360;
    var step = ((prof[n - 1].az - a0) % 360 + 360) % 360 / (n - 1 || 1);
    var idx = step > 0 ? rel / step : 0;
    if (idx <= 0) return prof[0].ang;
    if (idx >= n - 1) return prof[n - 1].ang;
    var i0 = Math.floor(idx), f = idx - i0;
    return prof[i0].ang * (1 - f) + prof[i0 + 1].ang * f;
  }

  function scanHorizon() {
    if (hz.busy || !state.circ || !state.at) return;
    var key = hzKey();
    var track = hzTrack();
    var azs = track.map(function (p) { return p.az; });
    var lo = Math.min.apply(null, azs), hi = Math.max.apply(null, azs);
    if (hi - lo > 180) { lo = state.circ.sunAz - 20; hi = state.circ.sunAz + 20; }
    var lowest = Math.min.apply(null, track.map(function (p) { return p.alt; }));
    // a low Sun needs a long look: a ridge 60 km out still reaches 5° when the
    // Sun is at 5°, and nothing beyond 120 km survives the Earth's curve
    var maxKm = Math.min(120, Math.max(10,
      5 / Math.tan(Math.max(1, lowest) * RAD)));

    hz.busy = true;
    ui.hzGo.disabled = true;
    ui.hzStatus.textContent = 'reading the ground…';
    Terrain.horizonScan(state.at.lat, state.at.lon, {
      azCenter: (lo + hi) / 2,
      azSpan: Math.max(20, Math.min(90, hi - lo + 8)),
      azStep: 1,
      maxKm: maxKm,
      onProgress: function (f) {
        ui.hzStatus.textContent = 'reading the ground ' + Math.round(f * 100) + '%';
      }
    }).then(function (scan) {
      if (hzKey() !== key) return;              // the reader moved meanwhile
      hz.scan = scan; hz.key = key;
      drawHorizon();
    }).catch(function () {
      ui.hzStatus.textContent = 'no elevation data';
      ui.hzBody.innerHTML = '<p class="sheet-note">The elevation tiles could ' +
        'not be reached, so the skyline is unknown here.</p>';
    }).then(function () {
      hz.busy = false;
      ui.hzGo.disabled = false;
    });
  }

  function drawHorizon() {
    if (!hz.scan || hz.key !== hzKey()) return;
    var prof = hz.scan.profile;
    var track = hzTrack();
    var c = state.circ;

    /* The window: the track, padded by three degrees, and no wider than it
       has to be. This is the whole difference from Recon's chart — there the
       frame is the scan, here it is the eclipse. */
    var azMin = prof[0].az;
    function rel(az) {
      var r = ((az - azMin) % 360 + 360) % 360;
      return r > 270 ? r - 360 : r;             // keep the window signed and small
    }
    var rels = track.map(function (p) { return rel(p.az); });
    var azLo = Math.min.apply(null, rels) - 3;
    var azHi = Math.max.apply(null, rels) + 3;
    if (azHi - azLo < 10) {                     // a stationary Sun still gets air
      var mid = (azLo + azHi) / 2;
      azLo = mid - 5; azHi = mid + 5;
    }
    var alts = track.map(function (p) { return p.alt; });
    var altHi = Math.max.apply(null, alts) + 2;
    var altLo = Math.min(-1.2, Math.min.apply(null, alts) - 1.2);
    // the terrain inside the window sets the ceiling too: a ridge that towers
    // over the Sun is the answer, so it must be in the picture
    prof.forEach(function (p) {
      var r = rel(p.az);
      if (r >= azLo && r <= azHi && p.ang > altHi - 2) {
        altHi = Math.min(p.ang + 2, altHi + 14);
      }
    });

    var W = 232, H = 340, mL = 32, mR = 12, mT = 14, mB = 30;
    var plotW = W - mL - mR, plotH = H - mT - mB;
    function X(az) {
      var r = Math.max(azLo, Math.min(azHi, rel(az)));
      return mL + (r - azLo) / (azHi - azLo) * plotW;
    }
    function Y(a) {
      var v = Math.max(altLo, Math.min(altHi, a));
      return mT + (altHi - v) / (altHi - altLo) * plotH;
    }

    var svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" class="hz-fig" role="img" ' +
      'aria-label="The Sun’s path through the eclipse against the skyline in that direction">'];

    // altitude gridlines, stepped to whatever the window turned out to be
    var span = altHi - altLo;
    var gStep = span > 40 ? 10 : span > 18 ? 5 : span > 8 ? 2 : 1;
    for (var g = Math.ceil(altLo / gStep) * gStep; g <= altHi; g += gStep) {
      var yg = Y(g);
      svg.push('<line class="hz-grid" x1="' + mL + '" x2="' + (W - mR) +
        '" y1="' + yg.toFixed(1) + '" y2="' + yg.toFixed(1) + '"/>');
      svg.push('<text class="hz-tick" x="' + (mL - 5) + '" y="' + (yg + 3.4).toFixed(1) +
        '" text-anchor="end">' + g + '°</text>');
    }
    // the horizon itself, where the ground would be if it were flat and far
    svg.push('<line class="hz-zero" x1="' + mL + '" x2="' + (W - mR) +
      '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '"/>');

    // the skyline, filled down to the frame's floor
    var d = '', started = false;
    prof.forEach(function (p) {
      var r = rel(p.az);
      if (r < azLo - 2 || r > azHi + 2) return;
      d += (started ? 'L' : 'M') + X(p.az).toFixed(1) + ',' + Y(p.ang).toFixed(1);
      started = true;
    });
    if (started) {
      d += 'L' + (W - mR) + ',' + (H - mB) + 'L' + mL + ',' + (H - mB) + 'Z';
      svg.push('<path class="hz-ground" d="' + d + '"/>');
    }

    // the Sun's path: thin while partial, thick through totality, dashed and
    // in plate 2 wherever the ground is in the way
    for (var i = 1; i < track.length; i++) {
      var a = track[i - 1], b = track[i];
      var blocked = b.alt < hzAngleAt(prof, b.az);
      svg.push('<line class="hz-run' + (b.total ? ' is-total' : '') +
        (blocked ? ' is-blocked' : '') + '" x1="' + X(a.az).toFixed(1) +
        '" y1="' + Y(a.alt).toFixed(1) + '" x2="' + X(b.az).toFixed(1) +
        '" y2="' + Y(b.alt).toFixed(1) + '"/>');
    }

    // the Sun at maximum, at its true angular size on both axes — which is
    // why it is an ellipse: the frame stretches height against width
    var rx = SUN_DEG / (azHi - azLo) * plotW;
    var ry = SUN_DEG / (altHi - altLo) * plotH;
    svg.push('<ellipse class="hz-sun" cx="' + X(c.sunAz).toFixed(1) + '" cy="' +
      Y(c.sunAltApparent).toFixed(1) + '" rx="' + Math.max(2, rx).toFixed(1) +
      '" ry="' + Math.max(2, ry).toFixed(1) + '"/>');

    /* Contact marks, dropped to the axis so they cannot sit on the track —
       and only the ones the crop actually contains: a C1 an hour outside the
       frame, clamped to its edge, would be a label pointing at nothing. */
    var w = hzWindow();
    var marks = [['C1', c.c1], ['C2', c.c2], ['C3', c.c3], ['C4', c.c4]]
      .filter(function (m) {
        return m[1] && m[1].tTT >= w.lo - 1e-9 && m[1].tTT <= w.hi + 1e-9;
      });
    var lastX = -99;
    marks.forEach(function (m) {
      var x = X(m[1].az);
      if (x - lastX < 16) x = lastX + 16;       // C2 and C3 crowd on a short totality
      if (x > W - mR) return;
      lastX = x;
      svg.push('<line class="hz-ctick" x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) +
        '" y1="' + (H - mB) + '" y2="' + (H - mB + 4) + '"/>');
      svg.push('<text class="hz-clabel" x="' + x.toFixed(1) + '" y="' + (H - mB + 14) +
        '" text-anchor="middle">' + m[0] + '</text>');
    });
    // the compass reading under the frame, so the strip is locatable in the sky
    svg.push('<text class="hz-axis" x="' + (mL + plotW / 2).toFixed(1) + '" y="' +
      (H - 2) + '" text-anchor="middle">' +
      Math.round(c.sunAz) + '° ' + compass(c.sunAz) + ' at maximum</text>');
    // and the stretch of time the frame covers, so the crop is stated
    svg.push('<text class="hz-axis" x="' + (W - mR) + '" y="' + (mT - 4) +
      '" text-anchor="end">' +
      clockOf(Bessel.toDate(state.ecl, track[0].tt), state.at.tz) + '–' +
      clockOf(Bessel.toDate(state.ecl, track[track.length - 1].tt), state.at.tz) +
      '</text>');
    svg.push('</svg>');

    /* The verdict in one line: what the ground does to the part that counts —
       totality if there is any, otherwise the stretch the frame holds. */
    var care = track.filter(function (p) { return p.total; });
    if (!care.length) care = track;
    var seen = care.filter(function (p) { return p.alt >= hzAngleAt(prof, p.az); });
    var frac = care.length ? seen.length / care.length : 0;
    var what = care[0].total ? (state.circ.type === 'annular' ? 'annularity' : 'totality')
                             : 'the hour around maximum';
    // the tightest moment, and what the ground is made of there
    var tightest = care[0], margin = Infinity;
    care.forEach(function (p) {
      var m = p.alt - hzAngleAt(prof, p.az);
      if (m < margin) { margin = m; tightest = p; }
    });
    var feat = hzFeatureAt(prof, tightest.az);
    var featWord = feat ? (feat.distKm < 1
      ? 'The skyline there is only ' + Math.round(feat.distKm * 1000) +
        ' m away and ' + Math.round(feat.elevM - hz.scan.siteElev) +
        ' m higher — at that range one tile pixel is worth about a degree, ' +
        'so treat it as “something is close by”, not as a measurement.'
      : 'The skyline there is ' + (feat.distKm < 10 ? feat.distKm.toFixed(1)
        : Math.round(feat.distKm)) + ' km away, ' + Math.round(feat.elevM) +
        ' m above sea level.') : '';

    var word;
    if (frac >= 0.999) {
      word = 'The skyline is clear: ' + what + ' happens ' + margin.toFixed(1) +
        '° above the ground at its closest. ';
    } else if (frac <= 0.001) {
      word = 'The ground hides ' + what + ' entirely from this exact spot — ' +
        'higher ground, or a few streets over, may not. ';
    } else {
      word = 'The ground hides ' + Math.round((1 - frac) * 100) + '% of ' + what +
        ' from this exact spot. ';
    }

    ui.hzStatus.textContent = Terrain.cacheSize() + ' tiles read';
    ui.hzBody.innerHTML = '<figure class="hz-wrap">' + svg.join('') +
      '<figcaption class="sheet-note">' + word + featWord + ' Elevation from ' +
      '<a href="https://registry.opendata.aws/terrain-tiles/">AWS terrain tiles</a>, ' +
      'about 30–90 m across on the ground and read as a surface, so a dense ' +
      'city reads its own rooftops. Height is stretched against width — read ' +
      'the degrees on both edges.</figcaption></figure>';
  }

  /* A new place or a new eclipse retires the old skyline rather than showing
     it against the wrong sky. */
  function resetHorizon() {
    hz.scan = null; hz.key = null;
    if (!ui.horizon) return;
    ui.hzStatus.textContent = '';
    ui.hzBody.innerHTML = '';
    ui.hzBody.appendChild(ui.hzAsk);
    ui.hzBody.appendChild(ui.hzGo);
    ui.hzGo.disabled = false;
  }

  /* ================= where the reader is ================= */

  /* A pair of coordinates, if that is what was typed. Degrees only, either
     order of sign, comma or space between them. */
  function asCoords(text) {
    var m = String(text).trim()
      .match(/^([+-]?\d{1,2}(?:\.\d+)?)\s*[°]?\s*[,;\s]\s*([+-]?\d{1,3}(?:\.\d+)?)\s*[°]?$/);
    if (!m) return null;
    var lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat: lat, lon: lon };
  }

  function deviceZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; }
    catch (err) { return null; }
  }

  function setPlace(at, keepField) {
    state.at = at;
    state.geo = Bessel.geocentric(at.lat, 0);
    state.stateWord = '';
    if (!keepField) ui.place.value = at.name;
    try { localStorage.setItem(STORE, JSON.stringify(at)); } catch (err) { /* private mode */ }
    var q = '?at=' + at.lat.toFixed(4) + ',' + at.lon.toFixed(4) +
            '&name=' + encodeURIComponent(at.name) + (at.tz ? '&tz=' + encodeURIComponent(at.tz) : '');
    try { history.replaceState(null, '', q); } catch (err) { /* file:// */ }
    locate();
  }

  /* Pick the eclipse to count down to: the first one still to come that is
     actually visible from there, rather than merely dated in the future. */
  function locate() {
    var rows = survey(state.at.lat, state.at.lon).filter(function (r) {
      return r.over > Date.now();
    });
    var pick = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].circ && rows[i].circ.visible) { pick = i; break; }
    }
    ui.whereCap.textContent = coordWord(state.at.lat, state.at.lon);
    stopPreview(true);
    if (pick < 0) { resetHorizon(); renderNothing(rows); return; }
    renderReport(pick, rows);
    // the skyline belongs to a place and an eclipse; either changing voids it,
    // and a scan already in hand for this pair is simply redrawn
    if (hz.scan && hz.key === hzKey()) drawHorizon(); else resetHorizon();
    tick(window.performance.now());
  }

  function say(message, bad) {
    ui.hint.hidden = !message;
    ui.hint.textContent = message || '';
    ui.hint.classList.toggle('is-quiet', !bad);   // .hint is a plate-2 line by
                                                  // default, and "looking it
                                                  // up" is not a problem
  }

  function offerAlternatives(list) {
    ui.alts.hidden = list.length < 2;
    ui.altsRow.innerHTML = '';
    if (list.length < 2) return;
    list.slice(1, 6).forEach(function (r) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-ghost alt';
      b.textContent = nameOf(r);
      b.addEventListener('click', function () {
        ui.alts.hidden = true;
        setPlace({ lat: r.latitude, lon: r.longitude, name: nameOf(r), tz: r.timezone || null });
      });
      ui.altsRow.appendChild(b);
    });
  }

  function nameOf(r) {
    return [r.name, r.admin1, r.country].filter(Boolean).join(', ');
  }

  function lookUp(query) {
    var coords = asCoords(query);
    if (coords) {
      ui.alts.hidden = true;
      say('');
      setPlace({ lat: coords.lat, lon: coords.lon,
                 name: coordWord(coords.lat, coords.lon), tz: deviceZone() }, true);
      return;
    }
    say('Looking up “' + query + '”…');
    ui.find.disabled = true;
    var url = 'https://geocoding-api.open-meteo.com/v1/search?name=' +
              encodeURIComponent(query) + '&count=6&language=en&format=json';
    window.fetch(url).then(function (res) {
      if (!res.ok) throw new Error('the geocoder answered ' + res.status);
      return res.json();
    }).then(function (data) {
      var list = (data && data.results) || [];
      if (!list.length) {
        say('No match for “' + query + '”. Try a larger town nearby, or type ' +
            'coordinates as latitude, longitude.', true);
        ui.alts.hidden = true;
        return;
      }
      say('');
      offerAlternatives(list);
      setPlace({ lat: list[0].latitude, lon: list[0].longitude,
                 name: nameOf(list[0]), tz: list[0].timezone || null });
    }).catch(function (err) {
      say('Place lookup failed (' + err.message + '). Coordinates typed as ' +
          'latitude, longitude work without a network.', true);
    }).then(function () {
      ui.find.disabled = false;
    });
  }

  function askTheBrowser() {
    if (!navigator.geolocation) {
      say('This browser cannot report a position. Type a place or coordinates instead.', true);
      return;
    }
    say('Asking the browser for your position…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      say('');
      ui.alts.hidden = true;
      setPlace({
        lat: pos.coords.latitude, lon: pos.coords.longitude,
        name: coordWord(pos.coords.latitude, pos.coords.longitude),
        tz: deviceZone()
      });
    }, function (err) {
      say(err.code === 1
        ? 'Location permission was denied. Type a place instead.'
        : 'The browser could not determine your position. Type a place instead.', true);
    }, { timeout: 15000, maximumAge: 600000 });
  }

  /* ================= start ================= */

  function restore() {
    var params = new URLSearchParams(location.search);
    var at = null;
    var coords = asCoords(params.get('at') || '');
    if (coords) {
      at = { lat: coords.lat, lon: coords.lon,
             name: params.get('name') || coordWord(coords.lat, coords.lon),
             tz: params.get('tz') || deviceZone() };
    } else {
      try {
        var saved = JSON.parse(localStorage.getItem(STORE) || 'null');
        if (saved && isFinite(saved.lat) && isFinite(saved.lon)) at = saved;
      } catch (err) { /* nothing worth keeping */ }
    }
    if (at) setPlace(at);
  }

  buildScene();
  paint(null);

  ui.whereForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = ui.place.value.trim();
    if (!q) { say('Type a place name or a pair of coordinates.', true); return; }
    lookUp(q);
  });
  ui.here.addEventListener('click', askTheBrowser);
  ui.play.addEventListener('click', function () {
    if (state.preview) stopPreview(); else startPreview();
  });
  ui.hzGo.addEventListener('click', scanHorizon);

  restore();
  window.requestAnimationFrame(loop);
})();
