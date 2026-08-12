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
   'note', 'later', 'laterList'].forEach(function (id) {
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
        ? { word: 'below the horizon', note: 'the Sun is down, and whole' }
        : { word: 'the Sun, whole', note: 'the Moon has not reached it' };
    }
    var pc = f.cover * 100;
    var covered = (pc < 1 ? pc.toFixed(1) : Math.round(pc)) + '% covered';
    if (f.alt < UNDER) {
      return { word: 'below the horizon',
               note: 'it is ' + covered + ' where it is, which is under your feet' };
    }
    if (f.central && f.annular) return { word: 'ANNULAR', note: 'a ring of Sun around the Moon' };
    if (f.central) return { word: 'TOTALITY', note: 'the corona is out, and so are the stars' };
    var note = pc > 90 ? 'deep, and the light has gone strange'
      : pc > 40 ? 'a clear bite, but the day looks normal'
      : 'a nick out of the edge — you would not notice without a filter';
    return { word: covered, note: note };
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
    if (circ.c1) out.push({ at: circ.c1.date, label: 'until the Moon touches the Sun' });
    if (circ.c2) out.push({ at: circ.c2.date, label: ring ? 'until the ring closes' : 'until totality' });
    else out.push({ at: circ.dateMax, label: 'until the deepest moment' });
    if (circ.c3) out.push({ at: circ.c3.date, label: ring ? 'of the ring left' : 'of totality left' });
    if (circ.c4) out.push({ at: circ.c4.date, label: 'until the Moon lets go' });
    return out;
  }

  function phasesFor(circ) {
    var ring = circ.type === 'annular';
    var out = [];
    if (circ.c1) out.push({ name: 'First contact', say: 'the bite begins', c: circ.c1 });
    if (circ.c2) out.push({ name: ring ? 'Ring closes' : 'Totality begins', say: 'second contact', c: circ.c2 });
    out.push({ name: 'Maximum', say: 'the deepest moment', c: { date: circ.dateMax, alt: circ.sunAlt } });
    if (circ.c3) out.push({ name: ring ? 'Ring opens' : 'Totality ends', say: 'third contact', c: circ.c3 });
    if (circ.c4) out.push({ name: 'Last contact', say: 'the Sun is whole again', c: circ.c4 });
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
      ['Here it is', TYPE_WORD[circ.type]],
      ['At its deepest', Math.round(circ.obscuration * 100) + '% of the Sun'],
      [ring ? 'Ring lasts' : 'Totality lasts', circ.duration ? lasting(circ.duration) : '—'],
      ['Sun then', sunWord(circ.sunAltApparent, circ.sunAz)],
      ['The date', dayOf(circ.dateMax, state.at.tz)]
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
      notes.push('The shadow’s full cone misses this spot, so the Sun never goes ' +
        'out here: it is a bite, at most ' + Math.round(circ.obscuration * 100) + '% deep.');
    }
    if (circ.sunAltApparent < 8 && circ.sunAltApparent > UNDER) {
      notes.push('The Sun is ' + (circ.sunAltApparent < 0.5 ? 'on the horizon'
        : 'only ' + Math.round(circ.sunAltApparent) + '° up') + ' at maximum, about ' +
        compass(circ.sunAz) + ' — a low ridge or a tall building is enough to hide the ' +
        'whole thing, so the horizon that way is worth checking first.');
    }
    if (circ.c4 && circ.c4.alt + Bessel.refraction(circ.c4.alt) < UNDER) {
      notes.push('The Sun sets before the eclipse is over, so the last phases happen ' +
        'below your horizon.');
    }
    if (circ.c1 && circ.c1.alt + Bessel.refraction(circ.c1.alt) < UNDER) {
      notes.push('The Sun rises with the eclipse already under way — the first phases ' +
        'happen below your horizon.');
    }
    notes.push(circ.type === 'total'
      ? 'Totality itself is the one part safe to look at without a filter, and only ' +
        'for exactly as long as it lasts; every other second of this needs one.'
      : 'None of this is safe to look at without a proper solar filter. A Sun with a ' +
        'bite out of it is as bright as any other Sun.');
    ui.note.innerHTML = notes.join(' ');

    var later = rows.filter(function (r, i) { return i !== pickIndex; });
    ui.later.hidden = !later.length;
    ui.laterList.innerHTML = later.map(function (r) {
      var when = dayOf(new Date(Date.UTC(r.ecl.date[0], r.ecl.date[1] - 1, r.ecl.date[2])), 'UTC');
      var what;
      if (!r.circ) what = 'does not reach there';
      else if (!r.circ.visible) what = TYPE_WORD[r.circ.type].toLowerCase() + ', but below the horizon there';
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
    ui.empty.innerHTML = 'None of the eclipses on file reach ' +
      '<strong>' + escapeHtml(state.at.name) + '</strong> with the Sun above the horizon. ' +
      'The catalogue holds ' + rows.length + ' still to come — ' +
      rows.map(function (r) { return '<code>' + r.ecl.id + '</code>'; }).join(', ') +
      ' — and any other eclipse can be added by pasting its Besselian elements ' +
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
      ui.clockAt.textContent = 'the whole eclipse in fifteen seconds, slowed through the middle';
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
      ui.clockLabel.textContent = 'and that was that';
      ui.clockTime.textContent = 'over';
      ui.clockAt.textContent = 'looking for the next one…';
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
    ui.disc.setAttribute('aria-label', 'The Sun as it appears from there: ' + s.word);
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
    if (pick < 0) { renderNothing(rows); return; }
    renderReport(pick, rows);
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
        say('No place called “' + query + '”. Try a bigger town nearby, or ' +
            'type coordinates as latitude, longitude.', true);
        ui.alts.hidden = true;
        return;
      }
      say('');
      offerAlternatives(list);
      setPlace({ lat: list[0].latitude, lon: list[0].longitude,
                 name: nameOf(list[0]), tz: list[0].timezone || null });
    }).catch(function (err) {
      say('The place lookup did not come back (' + err.message + '). Coordinates ' +
          'typed as latitude, longitude still work, and need no network.', true);
    }).then(function () {
      ui.find.disabled = false;
    });
  }

  function askTheBrowser() {
    if (!navigator.geolocation) {
      say('This browser will not say where it is. Type a place or coordinates instead.', true);
      return;
    }
    say('Waiting for the browser to place you…');
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
        ? 'The browser was told not to share your position. Type a place instead.'
        : 'The browser could not work out where you are. Type a place instead.', true);
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
    if (!q) { say('Type a place, or a pair of coordinates.', true); return; }
    lookUp(q);
  });
  ui.here.addEventListener('click', askTheBrowser);
  ui.play.addEventListener('click', function () {
    if (state.preview) stopPreview(); else startPreview();
  });

  restore();
  window.requestAnimationFrame(loop);
})();
