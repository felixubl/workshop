/* Abecedarian Distance: the two figures and the record rows at the foot of the
   page. All three draw the dictionary surveys in data/dictionaries.js.

   Two figures, one form, one ramp, and the only thing that changes between
   them is what a bar is a hundred per cent OF.

   The first is a hundred per cent of the words that HAVE a distance, for the
   dictionaries the switches are on, so the distribution fills the bar and its
   shape can be read: two or three swaps, and the languages closer together
   than one expects. The second is a hundred per cent of every word every
   dictionary holds, all thirteen of them, so the words no ordering sorts are
   in the bar too and what a reader sees is how little of a dictionary the
   question even reaches.

   What used to sit between them was a logarithmic figure carrying the far tail
   distance by distance. It is gone. The tail now lives in the ramp's last step,
   in the record rows below, and in the table, which is where the exact numbers
   always were.

   Colour does two different jobs here, one per figure, and this paragraph used
   to describe a third arrangement that no longer exists — the file said the
   switches carried no ink and that any number could be drawn at once, which
   has not been true since the first figure went back to stacking languages.

   In the first figure a segment is a DICTIONARY, so colour is an identity:
   four inks, which is how many clear the colour-vision gates pairwise, and
   therefore also the cap on how many can be drawn together. In the second a
   segment is a DISTANCE, where the order is the meaning, so colour is an
   ordinal ramp and names no language at all. Nothing in either is identified
   by colour alone: a language is named on its switch and on its row.

   The counting is not done here. It was done once, offline, by
   tools/abecedarian-corpus.mjs, running the same engine this page runs; what
   ships is a couple of hundred numbers rather than forty megabytes of word
   lists, and the tool still opens no socket. This file only draws them.

   Both figures are redrawn at the container's pixel width rather than scaled
   from a fixed viewBox, because a viewBox that stretches takes the type with
   it: a 10px axis label becomes 6px on a phone and 14px on a desktop, and
   neither is the size it was chosen at. */

var CORPUS = (function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var LANGS = ABC_CORPUS.languages;
  var MAXD = ABC_CORPUS.maxDistance;

  var pick = document.getElementById('corpusPick');
  var meta = document.getElementById('corpusMeta');
  var note = document.getElementById('chartNote');
  var live = document.getElementById('chartLive');
  var tableBtn = document.getElementById('tableBtn');
  var tableBox = document.getElementById('corpusTable');

  var wrapA = document.getElementById('chartWrap');
  var svgA = document.getElementById('chart');
  var tipA = document.getElementById('chartTip');
  var keyA = document.getElementById('rampKeyA');

  var wrapB = document.getElementById('stackWrap');
  var svgB = document.getElementById('stack');
  var tipB = document.getElementById('stackTip');
  var keyB = document.getElementById('rampKeyB');
  var stackMeta = document.getElementById('stackMeta');
  var stackNote = document.getElementById('stackNote');

  var peaks = document.getElementById('peaks');
  var peakMeta = document.getElementById('peakMeta');
  var peakNote = document.getElementById('peakNote');
  var mets = document.getElementById('mets');
  var metMeta = document.getElementById('metMeta');
  var metNote = document.getElementById('metNote');
  var field = document.getElementById('word');

  var byId = {};
  LANGS.forEach(function (l) { byId[l.id] = l; });

  /* ── Which dictionaries the first figure draws, and in what ink ──────────
     The two figures cut the same numbers the other way up, and that decides
     their colour.

     In the second, a bar is a dictionary and a segment is a distance, so
     colour says how many swaps: an ordinal ramp, one hue in steps.

     In the first, a bar is a distance and a segment is a DICTIONARY, so colour
     has to say which language — an identity, where nothing follows from the
     order and a ramp would be inventing a sequence that does not exist. That
     is a different job and it takes a different vocabulary. The two figures
     are not inconsistent with each other; they are each right about their own
     segments.

     Identity means four, because four is how many inks clear the
     colour-vision gates pairwise and there is no fifth. A language holds its
     ink for as long as it is drawn, and picking a fifth evicts whichever has
     been drawn longest and hands the newcomer that one freed slot, so the
     three that stay are never repainted. */
  var slots = ['en', 'es', 'fr', 'de'].map(function (id) { return byId[id] ? id : null; });
  var order = [0, 1, 2, 3];              // slot indices, longest-drawn first
  if (!slots.filter(Boolean).length) { slots[0] = LANGS[0].id; }

  function slotOf(id) { return slots.indexOf(id); }
  function isOn(id) { return slotOf(id) >= 0; }
  function drawn() {
    return slots.map(function (id) { return id ? byId[id] : null; }).filter(Boolean);
  }
  function inkClass(l) {
    var i = slotOf(l.id);
    return i < 0 ? 'ghost' : 'ink-' + i;
  }
  function toggle(id) {
    var at = slotOf(id);
    if (at >= 0) {
      /* The last one drawn stays drawn: an empty figure is not a view. */
      if (drawn().length === 1) return;
      slots[at] = null;
      order = order.filter(function (i) { return i !== at; });
      return;
    }
    var free = slots.indexOf(null);
    if (free < 0) { free = order.shift(); slots[free] = null; }
    else order = order.filter(function (i) { return i !== free; });
    slots[free] = id;
    order.push(free);
  }

  var atDistance = null;                 // the field's answer, or null
  var atWord = '';

  /* Thin spaces every three digits, as the seed and the fact list use. Its own
     copy rather than a shared one: this file loads before script.js and should
     not reach forward into it for a one-line helper. */
  function grouped(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  /* Shares here run from 94 down to 0.004, so a fixed number of decimals is
     either noise at the top or nothing at the bottom. Three significant
     figures throughout, which is as much as counts of this size support. */
  function pct(n) {
    if (n === 0) return '0';
    if (n >= 10) return n.toFixed(1);
    if (n >= 1) return n.toFixed(2);
    if (n >= 0.1) return n.toFixed(3);
    return n.toPrecision(2);
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function node(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    return e;
  }

  /* ── The ramp ────────────────────────────────────────────────────────────
     Eight steps, ending at "7 or more". Distance is ordinal — 3 comes after 2
     and the order is the meaning — so it takes one hue in lightness steps, and
     eight is what the ramp gates allow while the pale end stays off the paper.
     "None" is not a distance and takes a neutral off the ramp entirely. */
  var RAMP = 8;
  function stepOf(d) { return d < RAMP - 1 ? d : RAMP - 1; }
  function stepName(i) {
    return (i < RAMP - 1 ? String(i) : (RAMP - 1) + ' or more') +
      (i === 1 ? ' swap' : ' swaps');
  }
  function stepClass(c) { return c.none ? 'seg-none' : 'step-' + c.step; }

  /* The classes of one dictionary in bar order, folded at the ramp's last
     step. withNone decides whether the words no ordering sorts are part of the
     hundred per cent — which is the whole difference between the two figures. */
  function classesOf(l, withNone) {
    var out = [];
    for (var i = 0; i < RAMP; i++) {
      var n = 0;
      for (var d = 0; d <= MAXD; d++) if (stepOf(d) === i) n += l.counts[d];
      if (n > 0) out.push({ step: i, count: n, none: false });
    }
    if (withNone) out.push({ step: -1, count: l.unsortable, none: true });
    return out;
  }

  /* Most-sortable first, computed once. Both figures use it, so a reader
     moving between them is not relearning an order, and it does not move under
     the switches — a reader who turned a language on would otherwise watch the
     figure reshuffle around it. */
  var ORDER = LANGS.slice().sort(function (a, b) {
    return (b.sortable / b.words) - (a.sortable / a.words);
  });

  /* ── The switches, which are not a legend any more ───────────────────────
     They were the legend while colour named languages. Nothing on this page is
     identified by colour now, so they carry a state and a name and no ink: a
     coloured square here would be a vocabulary pointing at nothing. */
  function drawPick() {
    pick.textContent = '';
    LANGS.forEach(function (l) {
      var b = el('button', 'pick');
      b.type = 'button';
      b.dataset.lang = l.id;
      b.appendChild(el('i', 'pick-ink ' + inkClass(l)));
      b.appendChild(el('span', 'pick-name', l.name));
      b.dataset.tip = grouped(l.sortable) + ' of ' + grouped(l.words) + ' ' +
        l.name + ' words have a distance; ' + grouped(l.unsortable) + ' have none. ' +
        l.dict + '.';
      b.addEventListener('click', function () {
        toggle(l.id);
        /* Restyled, not rebuilt: rebuilding the row would destroy the element
           the reader is standing on, and a keyboard would be thrown back to
           the top of the page by its own click. */
        syncPick();
        draw();
      });
      pick.appendChild(b);
    });
    syncPick();
  }

  function syncPick() {
    var all = pick.querySelectorAll('.pick');
    for (var i = 0; i < all.length; i++) {
      var l = byId[all[i].dataset.lang];
      var state = isOn(l.id);
      all[i].classList.toggle('is-on', state);
      all[i].setAttribute('aria-pressed', state ? 'true' : 'false');
      all[i].querySelector('.pick-ink').className = 'pick-ink ' + inkClass(l);
    }
    syncPeaks();
  }

  /* One continuous strip with its ends named, because eight steps of one hue
     are a scale and eight separate swatches would invite the reader to look
     each one up instead of reading the direction. The second figure's key
     carries the neutral as well, past a gap, because only that figure has it. */
  function drawRampKey(host, withNone) {
    host.textContent = '';
    var scale = el('span', 'ramp-scale');
    scale.appendChild(el('span', 'ramp-end', '0 swaps'));
    var strip = el('span', 'ramp-strip');
    for (var i = 0; i < RAMP; i++) strip.appendChild(el('i', 'step-' + i));
    scale.appendChild(strip);
    scale.appendChild(el('span', 'ramp-end', (RAMP - 1) + ' or more'));
    host.appendChild(scale);
    if (!withNone) return;
    var off = el('span', 'ramp-off');
    off.appendChild(el('i', 'seg-none'));
    off.appendChild(el('span', 'ramp-end', 'no distance'));
    host.appendChild(off);
  }

  /* ── One figure, built twice ─────────────────────────────────────────────
     A stack per dictionary. Everything about the spacing is a fraction of how
     much room there is, because the minimum segment width is a promise made in
     pixels and a phone has far fewer of them: left at four pixels on a 380px
     screen the floor cost a fifth of the bar and every language looked the
     same. So the floor, the gap between segments, the right margin and the
     tick spacing all come down together. The name column does not — clipping
     "Portuguese" to win eight pixels of bar is the wrong trade. */
  var ROW_H = 16, ROW_GAP = 9;

  function metrics(W) {
    var tight = W < 560;
    var left = 94, right = tight ? 34 : 52;
    var barW = W - left - right;
    return {
      left: left, right: right, top: 20, bottom: 34, barW: barW,
      minSeg: Math.max(1.5, Math.min(4, barW / 170)),
      segGap: barW < 320 ? 1 : 2,
      tick: tight ? 50 : 20
    };
  }

  function figure(cfg) {
    var hover = null;

    function rows() { return cfg.rows(); }

    function draw() {
      if (!cfg.wrap) return;
      var W = Math.max(280, Math.round(cfg.wrap.clientWidth));
      var M = metrics(W);
      var list = rows();
      var n = list.length;
      var H = M.top + n * ROW_H + (n - 1) * ROW_GAP + M.bottom;
      var y0 = M.top;
      var svg = cfg.svg;

      if (hover !== null && hover >= n) hover = null;

      svg.textContent = '';
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('width', W);
      svg.setAttribute('height', H);
      svg.setAttribute('aria-label', cfg.label(list));

      for (var v = 0; v <= 100; v += M.tick) {
        var gx = M.left + (v / 100) * M.barW;
        svg.appendChild(node('line', {
          class: v === 0 ? 'ax-base' : 'ax-grid',
          x1: gx, x2: gx, y1: y0 - 4, y2: y0 + n * ROW_H + (n - 1) * ROW_GAP + 4
        }));
        var vt = node('text', { class: 'ax-tick ax-tick-x', x: gx, y: H - M.bottom + 20 });
        vt.textContent = v + '%';
        svg.appendChild(vt);
      }

      list.forEach(function (l, r) {
        var top = y0 + r * (ROW_H + ROW_GAP);
        var cls = classesOf(l, cfg.withNone);
        var total = cfg.total(l);

        /* Lay the row out in pixels, then buy every thin segment up to the
           floor out of the widest one — the only segment with room to give,
           and in the second figure that is always "none", which runs from 61%
           to 94%. Without a floor, most of these classes are under a pixel and
           the bar would say a dictionary has four classes in it. */
        var px = cls.map(function (c) { return (c.count / total) * M.barW; });
        var owed = 0, big = 0, i;
        for (i = 0; i < px.length; i++) if (px[i] > px[big]) big = i;
        for (i = 0; i < px.length; i++)
          if (px[i] < M.minSeg) { owed += M.minSeg - px[i]; px[i] = M.minSeg; }
        px[big] = Math.max(M.minSeg, px[big] - owed);

        var nm = node('text', { class: 'stack-name', x: M.left - 10, y: top + ROW_H - 4 });
        nm.textContent = l.name;
        svg.appendChild(nm);

        var x = M.left, band = 0, markX = null, markW = 0;
        cls.forEach(function (c, k) {
          var w = Math.max(1, px[k] - M.segGap);
          svg.appendChild(node('rect', {
            class: 'seg ' + stepClass(c) + (hover === r ? ' is-on' : ''),
            x: x, y: top, width: w, height: ROW_H
          }));
          /* The reader's own word, outlined in the class it falls in. It used
             to be a hairline on a distance axis; there is no distance axis
             left, so it marks the band instead — the same claim in the form
             this figure can carry. */
          if (atDistance !== null && !c.none && c.step === stepOf(atDistance)) {
            svg.appendChild(node('rect', {
              class: 'seg-at', x: x - 1, y: top - 1, width: w + 2, height: ROW_H + 2
            }));
            if (markX === null) { markX = x; markW = w; }
          }
          if (!c.none) band += px[k];
          x += px[k];
        });

        if (r === 0 && markX !== null) {
          var mt = node('text', { class: 'ax-mark-label', x: markX + markW / 2, y: top - 7 });
          mt.textContent = atWord;
          svg.appendChild(mt);
        }

        if (cfg.rowLabel) {
          var lb = node('text', { class: 'stack-share', x: M.left + band + 6, y: top + ROW_H - 4 });
          lb.textContent = cfg.rowLabel(l);
          svg.appendChild(lb);
        }

        /* One hit target per row: a reader aims at a language, and the readout
           gives the whole of it. Segments are far too thin to aim at. */
        var hit = node('rect', {
          class: 'band' + (hover === r ? ' is-on' : ''),
          x: M.left, y: top - ROW_GAP / 2, width: M.barW, height: ROW_H + ROW_GAP
        });
        hit.dataset.row = r;
        svg.appendChild(hit);
      });

      if (hover !== null) place(hover);
    }

    /* The readout is the whole row: a reader hovering a language wants its
       composition and not one segment of it. Everything it shows is in the
       table below, which is the rule — a tooltip may add convenience and may
       never be the only way to a number. */
    function place(r) {
      var l = rows()[r];
      if (!l) return;
      var cls = classesOf(l, cfg.withNone);
      var total = cfg.total(l);
      cfg.tip.textContent = '';
      cfg.tip.appendChild(el('p', 'tip-head', l.name));
      var dl = el('dl', 'tip-rows');
      cls.forEach(function (c) {
        var dt = el('dt', null);
        dt.appendChild(el('i', 'tip-key ' + stepClass(c)));
        dt.appendChild(document.createTextNode(c.none ? 'no distance' : stepName(c.step)));
        dl.appendChild(dt);
        var dd = el('dd', null);
        dd.appendChild(el('b', null, pct((c.count / total) * 100) + '%'));
        dd.appendChild(el('span', 'tip-n', grouped(c.count)));
        dl.appendChild(dd);
      });
      cfg.tip.appendChild(dl);
      cfg.tip.hidden = false;

      /* Out past the middle of the bar. No coloured band reaches 39% of a
         second-figure bar, and in the first the rows are few enough that a
         readout parked there covers less than one sitting beside the row and
         hiding the rows either side of it. */
      var W = cfg.wrap.clientWidth;
      var M = metrics(W);
      var w = cfg.tip.offsetWidth;
      cfg.tip.style.left = Math.max(0, Math.min(W - w, M.left + M.barW * 0.46)) + 'px';
      var top = M.top + r * (ROW_H + ROW_GAP);
      var h = cfg.tip.offsetHeight;
      cfg.tip.style.top = Math.max(0, Math.min(cfg.wrap.clientHeight - h, top - h / 2)) + 'px';

      live.textContent = l.name + ', ' + cfg.of + ': ' + cls.map(function (c) {
        return (c.none ? 'no distance' : stepName(c.step)) + ' ' +
          pct((c.count / total) * 100) + '%';
      }).join(', ');
    }

    function rowAt(ev) {
      var box = cfg.svg.getBoundingClientRect();
      var y = ev.clientY - box.top - metrics(box.width).top + ROW_GAP / 2;
      var r = Math.floor(y / (ROW_H + ROW_GAP));
      return r >= 0 && r < rows().length ? r : null;
    }

    function setHover(r) {
      if (r === hover) return;
      hover = r;
      draw();
      if (hover === null) { cfg.tip.hidden = true; live.textContent = ''; }
    }

    /* Pointer and caret get the same readout. Up and down are the natural
       arrows for a stack of rows; Escape puts the readout away. */
    cfg.svg.addEventListener('pointermove', function (ev) { setHover(rowAt(ev)); });
    cfg.svg.addEventListener('pointerleave', function () { setHover(null); });
    cfg.svg.addEventListener('blur', function () { setHover(null); });
    cfg.svg.addEventListener('keydown', function (ev) {
      var last = rows().length - 1;
      var r = hover === null ? 0 : hover;
      var k = ev.key;
      if (k === 'ArrowUp' || k === 'ArrowLeft') r = Math.max(0, r - 1);
      else if (k === 'ArrowDown' || k === 'ArrowRight') r = Math.min(last, r + 1);
      else if (k === 'Home') r = 0;
      else if (k === 'End') r = last;
      else if (k === 'Escape') { setHover(null); return; }
      else return;
      ev.preventDefault();
      setHover(r);
    });

    return { draw: draw };
  }

  /* ── Figure one: one stacked bar per distance ────────────────────────────
     x is the distance, and the bar standing on it is made of the dictionaries
     that are switched on — each one contributing the share of ITS OWN words
     that need exactly that many swaps.

     Which means the bar's total is a sum of percentages and is not itself a
     percentage of anything. Four dictionaries near 30% at three swaps make a
     bar 120 tall, and that number is not a share of any set of words. The
     figure is honest about it: the axis counts in points rather than per cent,
     the note says what the total is, and what a reader is meant to read is a
     SEGMENT — which is one language's share, exactly as it was when these
     stood side by side, and can be read straight off the bar.

     What the stacking buys is the shape. Side by side, four bars per band made
     the eye compare four things at every one of eleven bands; stacked, the
     outline of the whole run is the distribution and the segments are the
     languages inside it. */

  var DPAD = { top: 22, right: 8, bottom: 40, left: 46 };
  var DPLOT_H = 236;
  var DMIN = 3;                          // the floor under a thin segment
  var DGAP = 2;                          // the surface gap between segments

  function distanceFigure(cfg) {
    var hover = null;

    function draw() {
      if (!cfg.wrap) return;
      var W = Math.max(280, Math.round(cfg.wrap.clientWidth));
      var plotW = W - DPAD.left - DPAD.right;
      var H = DPAD.top + DPLOT_H + DPAD.bottom;
      var y0 = DPAD.top + DPLOT_H;
      var list = drawn();
      var svg = cfg.svg;

      /* The tallest stack sets the scale, and the scale counts in points
         because that is what a sum of percentages is measured in. */
      var high = 0;
      for (var d = 0; d <= MAXD; d++) {
        var t = 0;
        list.forEach(function (l) { t += shareOf(l, d); });
        if (t > high) high = t;
      }
      var top = Math.max(20, Math.ceil(high / 20) * 20);
      var step = top > 140 ? 40 : 20;
      var yOf = function (v) { return y0 - (v / top) * DPLOT_H; };

      svg.textContent = '';
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('width', W);
      svg.setAttribute('height', H);
      svg.setAttribute('aria-label',
        'One bar per number of swaps, each made of ' +
        list.map(function (l) { return l.name; }).join(', ') +
        ', every one contributing the share of its own words that need that ' +
        'many. Most need two or three. The full figures are in the table below.');

      for (var v = 0; v <= top; v += step) {
        svg.appendChild(node('line', {
          class: v === 0 ? 'ax-base' : 'ax-grid',
          x1: DPAD.left, x2: W - DPAD.right, y1: yOf(v), y2: yOf(v)
        }));
        var yt = node('text', { class: 'ax-tick ax-tick-y', x: DPAD.left - 8, y: yOf(v) + 3.5 });
        yt.textContent = String(v);
        svg.appendChild(yt);
      }

      var bandW = plotW / (MAXD + 1);
      var barW = Math.min(46, bandW * 0.62);

      /* The reader's own word, back on an axis that can carry it: a hairline
         down the band it belongs in, drawn under the bars so it never hides
         one. */
      if (atDistance !== null && atDistance <= MAXD) {
        var mx = DPAD.left + bandW * (atDistance + 0.5);
        svg.appendChild(node('line', { class: 'ax-mark', x1: mx, x2: mx, y1: DPAD.top - 4, y2: y0 }));
        var mt = node('text', { class: 'ax-mark-label', x: mx, y: DPAD.top - 8 });
        mt.textContent = atWord;
        svg.appendChild(mt);
      }

      for (d = 0; d <= MAXD; d++) {
        var cx = DPAD.left + bandW * (d + 0.5);
        var x = cx - barW / 2;

        /* Lay the stack out in pixels, floor the thin ones, and take what that
           costs off the tallest segment — the same bargain the second figure
           makes, for the same reason: at eight swaps a share of 0.02% is a
           fifth of a pixel, and a segment that is not drawn reads as a
           language that has no words there at all. */
        var px = list.map(function (l) { return (shareOf(l, d) / top) * DPLOT_H; });
        var owed = 0, big = 0, i;
        for (i = 0; i < px.length; i++) if (px[i] > px[big]) big = i;
        for (i = 0; i < px.length; i++)
          if (px[i] > 0 && px[i] < DMIN) { owed += DMIN - px[i]; px[i] = DMIN; }
        if (px[big] > DMIN) px[big] = Math.max(DMIN, px[big] - owed);

        var yTop = y0;
        list.forEach(function (l, k) {
          if (l.counts[d] === 0) return;
          var h = Math.max(1, px[k] - DGAP);
          yTop -= px[k];
          svg.appendChild(node('rect', {
            class: 'seg ' + inkClass(l) + (hover === d ? ' is-on' : ''),
            x: x, y: yTop, width: barW, height: h
          }));
        });

        var xt = node('text', {
          class: 'ax-tick ax-tick-x' + (d === atDistance ? ' is-at' : ''),
          x: cx, y: y0 + 16
        });
        xt.textContent = String(d);
        svg.appendChild(xt);

        var hit = node('rect', {
          class: 'band' + (hover === d ? ' is-on' : ''),
          x: DPAD.left + bandW * d, y: DPAD.top, width: bandW, height: DPLOT_H
        });
        hit.dataset.d = d;
        svg.appendChild(hit);
      }

      var xl = node('text', { class: 'ax-title', x: DPAD.left + plotW / 2, y: y0 + 36 });
      xl.textContent = 'swaps of the alphabet';
      svg.appendChild(xl);

      if (hover !== null) place(hover);
    }

    function place(d) {
      var list = drawn();
      cfg.tip.textContent = '';
      cfg.tip.appendChild(el('p', 'tip-head', d + (d === 1 ? ' swap' : ' swaps')));
      var dl = el('dl', 'tip-rows');
      list.forEach(function (l) {
        var dt = el('dt', null);
        dt.appendChild(el('i', 'tip-key ' + inkClass(l)));
        dt.appendChild(document.createTextNode(l.name));
        dl.appendChild(dt);
        var dd = el('dd', null);
        dd.appendChild(el('b', null, pct(shareOf(l, d)) + '%'));
        dd.appendChild(el('span', 'tip-n', grouped(l.counts[d])));
        dl.appendChild(dd);
      });
      cfg.tip.appendChild(dl);
      cfg.tip.hidden = false;

      var W = cfg.wrap.clientWidth;
      var bandW = (W - DPAD.left - DPAD.right) / (MAXD + 1);
      var centre = DPAD.left + bandW * (d + 0.5);
      var w = cfg.tip.offsetWidth;
      var left = centre < W / 2 ? centre + bandW / 2 + 8 : centre - bandW / 2 - 8 - w;
      cfg.tip.style.left = Math.max(0, Math.min(W - w, left)) + 'px';
      cfg.tip.style.top = '0px';

      live.textContent = d + (d === 1 ? ' swap: ' : ' swaps: ') +
        list.map(function (l) { return l.name + ' ' + pct(shareOf(l, d)) + '%'; }).join(', ');
    }

    function bandAt(ev) {
      var box = cfg.svg.getBoundingClientRect();
      var bandW = (box.width - DPAD.left - DPAD.right) / (MAXD + 1);
      var d = Math.floor((ev.clientX - box.left - DPAD.left) / bandW);
      return d >= 0 && d <= MAXD ? d : null;
    }

    function setHover(d) {
      if (d === hover) return;
      hover = d;
      draw();
      if (hover === null) { cfg.tip.hidden = true; live.textContent = ''; }
    }

    cfg.svg.addEventListener('pointermove', function (ev) { setHover(bandAt(ev)); });
    cfg.svg.addEventListener('pointerleave', function () { setHover(null); });
    cfg.svg.addEventListener('blur', function () { setHover(null); });
    cfg.svg.addEventListener('keydown', function (ev) {
      var d = hover === null ? (atDistance === null ? 0 : atDistance) : hover;
      var k = ev.key;
      if (k === 'ArrowLeft') d = Math.max(0, d - 1);
      else if (k === 'ArrowRight') d = Math.min(MAXD, d + 1);
      else if (k === 'Home') d = 0;
      else if (k === 'End') d = MAXD;
      else if (k === 'Escape') { setHover(null); return; }
      else return;
      ev.preventDefault();
      setHover(d);
    });

    return { draw: draw };
  }

  /* One language's share of its OWN words that have a distance. The same
     number the side-by-side figure printed; only the arrangement changed. */
  function shareOf(l, d) { return l.sortable ? (l.counts[d] / l.sortable) * 100 : 0; }

  var figA = distanceFigure({ wrap: wrapA, svg: svgA, tip: tipA });

  var figB = figure({
    wrap: wrapB, svg: svgB, tip: tipB,
    withNone: true,
    of: 'of every word',
    total: function (l) { return l.words; },
    rows: function () { return ORDER; },
    rowLabel: function (l) { return pct((l.sortable / l.words) * 100) + '%'; },
    label: function (list) {
      return 'One bar per dictionary, the whole of it, split by how many swaps ' +
        'its words need and by the words that need no alphabet at all. Sorted ' +
        'by how much of each has a distance, from ' + list[0].name + ' down to ' +
        list[list.length - 1].name + '. The full figures are in the table below.';
    }
  });

  /* ── The far end, named ──────────────────────────────────────────────────
     One row per dictionary: its record, and the words holding it.

     Clicking a word answers it. The page's whole interface is the field at the
     top, so the click writes there and hands the page back its own event — the
     same path a keystroke takes, rather than a second way in that could drift
     from the first — then brings the field into view, because a click at the
     foot of a long page that changes something off-screen has not visibly done
     anything. */
  function runWord(word) {
    if (!field) return;
    field.value = word;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    var top = document.querySelector('.toolbar');
    if (top && top.scrollIntoView) {
      var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      top.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    }
    /* Same test script.js uses before focusing on load: a phone will not open
       its keyboard for a script, so focusing there leaves a caret and no way
       to type into it. */
    if (!window.matchMedia || !window.matchMedia('(hover: none)').matches)
      field.focus({ preventScroll: true });
  }

  function drawPeaks() {
    peaks.textContent = '';
    ORDER.forEach(function (l) {
      var li = el('li', 'peak');
      li.dataset.lang = l.id;

      var who = el('span', 'peak-who');
      who.appendChild(el('span', 'peak-lang', l.name));
      li.appendChild(who);

      li.appendChild(el('code', 'peak-d', l.peak + (l.peak === 1 ? ' swap' : ' swaps')));

      var list = el('span', 'peak-words');
      l.peakWords.forEach(function (w) {
        var b = el('button', 'peak-word', w);
        b.type = 'button';
        b.dataset.tip = 'Put ' + w + ' in the field and work it out';
        b.addEventListener('click', function () { runWord(w); });
        list.appendChild(b);
      });
      /* Where more words tie than are carried, the count says so rather than
         the list trailing off. Naming four of seventeen without saying
         seventeen would read as the whole answer. */
      if (l.peakCount > l.peakWords.length)
        list.appendChild(el('span', 'peak-more',
          'and ' + (l.peakCount - l.peakWords.length) + ' more'));
      li.appendChild(list);

      peaks.appendChild(li);
    });
  }

  /* Every dictionary keeps its row. The switches scope the first figure, and
     hiding nine records because their languages are not drawn there would make
     the reader hunt for a fact through a control about something else. Only
     the weight follows. */
  function syncPeaks() {
    var rows = peaks.querySelectorAll('.peak');
    for (var i = 0; i < rows.length; i++)
      rows[i].classList.toggle('is-lit', isOn(rows[i].dataset.lang));
  }

  /* ── Where words meet ────────────────────────────────────────────────────
     One row per dictionary, in the same order and the same shape as the
     records above: the biggest family of words sharing a root, printed whole
     because it is nine words at the outside, and beside it the core the most
     words come down to, as a count only.

     The words of a root family are clickable and the core is not, and that is
     not an oversight — a root family's words ARE the finding and pressing one
     shows the working, where the core's four-out-of-185 would be a sample
     pretending to be a list. The core string itself is not pressable either:
     it is already what the word reduces to, so there is nothing further to
     see, and an underline promising otherwise would be a lie. */
  function drawMets() {
    mets.textContent = '';
    ORDER.forEach(function (l) {
      var li = el('li', 'met');
      li.dataset.lang = l.id;

      var who = el('span', 'peak-who');
      who.appendChild(el('span', 'peak-lang', l.name));
      li.appendChild(who);

      var top = l.rootTop[0];
      var rootBox = el('span', 'met-key');
      rootBox.appendChild(el('code', 'met-word', top.root.toLowerCase()));
      rootBox.appendChild(el('span', 'met-n', '·' + top.n));
      top.words.forEach(function (w) {
        var b = el('button', 'peak-word', w);
        b.type = 'button';
        b.dataset.tip = 'Put ' + w + ' in the field and work it out';
        b.addEventListener('click', function () { runWord(w); });
        rootBox.appendChild(b);
      });
      /* The family can run past what is printed, and where it does the count
         beside the root has already said so — these are the ones named. */
      li.appendChild(rootBox);

      var core = l.coreTop[0];
      var coreBox = el('span', 'met-key met-core');
      coreBox.appendChild(el('code', 'met-word', core.core.toLowerCase()));
      coreBox.appendChild(el('span', 'met-n', '·' + grouped(core.n)));
      li.appendChild(coreBox);

      mets.appendChild(li);
    });
  }

  /* Same rule as the records: every dictionary keeps its row whatever the
     switches are set to, and only the weight follows them. */
  function syncMets() {
    var rows = mets.querySelectorAll('.met');
    for (var i = 0; i < rows.length; i++)
      rows[i].classList.toggle('is-lit', isOn(rows[i].dataset.lang));
  }

  /* ── The numbers ─────────────────────────────────────────────────────────
     The figures' twin, and the reason a tooltip is allowed to be a
     convenience. Counts only, one number to a cell: the two figures work in
     two different denominators, and a table that printed a percentage would
     have to pick one of them and then explain which. Counts need no
     denominator, and every share either figure draws can be got from them.

     A row per dictionary, not a column. Thirteen columns ran the header off
     the side and left a reader scrolling sideways to find a language and then
     reading a number a screen away from its name. A row keeps the name against
     its own figures, and the row IS the distribution. */
  function drawTable() {
    var table = el('table');
    var thead = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', 'num-key', 'dictionary'));
    for (var h = 0; h <= MAXD; h++) hr.appendChild(el('th', 'num', String(h)));
    ['with a distance', 'no distance', 'every word', 'roots', 'cores'].forEach(function (t) {
      hr.appendChild(el('th', 'num num-wide', t));
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tb = el('tbody');
    ORDER.forEach(function (l) {
      var tr = el('tr');
      tr.appendChild(el('td', 'num-key', l.name));
      for (var d = 0; d <= MAXD; d++)
        tr.appendChild(el('td', 'num', grouped(l.counts[d])));
      tr.appendChild(el('td', 'num num-sum', grouped(l.sortable)));
      tr.appendChild(el('td', 'num num-sum', grouped(l.unsortable)));
      tr.appendChild(el('td', 'num num-sum', grouped(l.words)));
      tr.appendChild(el('td', 'num num-sum', grouped(l.roots)));
      tr.appendChild(el('td', 'num num-sum', grouped(l.cores)));
      tb.appendChild(tr);
    });

    table.appendChild(tb);
    var scroll = el('div', 'sheet-scroll');
    scroll.appendChild(table);
    tableBox.textContent = '';
    tableBox.appendChild(scroll);
    tableBox.appendChild(el('p', 'sheet-note table-note',
      'Counts, one number to a cell, in the order the figures use. The columns ' +
      '0 to ' + MAXD + ' are how many of that dictionary’s words need exactly ' +
      'that many swaps — the figures fold seven and up into one step, and this ' +
      'is where they are separate. Then the three totals the figures divide by, ' +
      'and the two collapses: how many distinct roots those words have, and how ' +
      'many distinct cores the costing ones come down to. Cores outnumber roots ' +
      'in every one of them, which is the point of the section above.'));
  }

  tableBtn.addEventListener('click', function () {
    var open = tableBox.hidden;
    tableBox.hidden = !open;
    tableBtn.classList.toggle('is-active', open);
    tableBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  function draw() { figA.draw(); figB.draw(); syncPeaks(); syncMets(); }

  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { draw(); });
    ro.observe(wrapA);
    ro.observe(wrapB);
  } else {
    window.addEventListener('resize', draw);
  }

  var words = LANGS.reduce(function (a, l) { return a + l.words; }, 0);
  var sortable = LANGS.reduce(function (a, l) { return a + l.sortable; }, 0);
  var zero = LANGS.reduce(function (a, l) { return a + l.counts[0]; }, 0);
  var worst = LANGS.reduce(function (a, l) { return l.peak > a.peak ? l : a; }, LANGS[0]);
  var first = ORDER[0], last = ORDER[ORDER.length - 1];
  var noneShare = function (l) { return (l.unsortable / l.words) * 100; };

  meta.textContent = grouped(words) + ' words · ' + LANGS.length + ' spelling dictionaries';
  note.textContent =
    'Every headword of ' + LANGS.length + ' Hunspell spelling dictionaries, folded ' +
    'to A–Z and run through the engine above. One bar per number of swaps, and ' +
    'each bar is made of the dictionaries the switches are on — every one ' +
    'contributing the share of its OWN words that need exactly that many. So a ' +
    'segment is a percentage and can be read straight off the bar; the bar’s ' +
    'total is those percentages added together and is not a share of anything, ' +
    'which is why the axis counts in points. Four inks, because four is how ' +
    'many a red-green reader can still tell apart, and picking a fifth ' +
    'dictionary hands it the ink of whichever has been drawn longest. The ' +
    'figure below takes all ' + LANGS.length + ' the other way up. Sources are ' +
    'pinned to wooorm/dictionaries @ ' + ABC_CORPUS.pin + '; each switch names its own.';

  stackMeta.textContent = grouped(zero) + ' already abecedarian · ' +
    pct((zero / words) * 100) + '% of every word';
  stackNote.textContent =
    'The same form, and the only change is what the bar is a hundred per cent ' +
    'of: every word the dictionary holds, so the ones no ordering sorts are in ' +
    'it too. They are the loosest figure in the survey, running from ' +
    pct(noneShare(first)) + '% of ' + first.name + ' to ' + pct(noneShare(last)) +
    '% of ' + last.name + ' — a language that builds long words by stacking ' +
    'endings on them puts nearly all of them out of reach. Sorted by the ' +
    'coloured band, ' + first.name + ' at the top down to ' + last.name + ' at the ' +
    'foot. The ramp runs light to dark with the distance and ends at “' +
    (RAMP - 1) + ' or more”, because past about eight shades of one hue a reader ' +
    'cannot tell them apart; “none” is not a distance and takes a neutral off ' +
    'the ramp. Every class present is drawn wide enough to see and those pixels ' +
    'come off the widest segment, which can afford them; the table rounds nothing.';

  /* The two collapses, totalled across the survey. `lone` is how many roots
     stand for exactly one word — spread[0], the first bucket — and the gap
     between allCores and allRoots is the finding the section is about. */
  var allRoots = LANGS.reduce(function (a, l) { return a + l.roots; }, 0);
  var allCores = LANGS.reduce(function (a, l) { return a + l.cores; }, 0);
  var allCosting = LANGS.reduce(function (a, l) { return a + l.costing; }, 0);
  var costingRoots = LANGS.reduce(function (a, l) { return a + l.costingRoots; }, 0);
  var lone = LANGS.reduce(function (a, l) { return a + l.spread[0]; }, 0);
  var plural = LANGS.reduce(function (a, l) { return a + l.plural; }, 0);
  /* The biggest of each kind anywhere in the survey, for the note to name. */
  var bigRoot = LANGS.reduce(function (a, l) {
    return l.rootTop[0].n > a.top.n ? { l: l, top: l.rootTop[0] } : a;
  }, { l: LANGS[0], top: LANGS[0].rootTop[0] });
  var bigCore = LANGS.reduce(function (a, l) {
    return l.coreTop[0].n > a.top.n ? { l: l, top: l.coreTop[0] } : a;
  }, { l: LANGS[0], top: LANGS[0].coreTop[0] });

  metMeta.textContent = pct((lone / allRoots) * 100) + '% of roots are one word';
  metNote.textContent =
    'Two ways for words to land on the same thing, and they behave nothing ' +
    'alike. Taking the repeats out merges almost nothing: ' + grouped(lone) +
    ' of the survey’s ' + grouped(allRoots) + ' roots stand for a single word, ' +
    'because collapsing repeats only ever joins spellings that differ in a ' +
    'doubled letter and a dictionary rarely carries both. What turns up instead ' +
    'is Roman numerals and name variants — the biggest family anywhere is ' +
    bigRoot.top.root.toLowerCase() + ', ' + bigRoot.top.n + ' words of ' +
    bigRoot.l.name + '. Going on to the core merges by the hundred: ' +
    bigCore.top.core.toLowerCase() + ' is a core of ' + grouped(bigCore.top.n) + ' ' +
    bigCore.l.name + ' words. And it still does not shrink the vocabulary — ' +
    grouped(costingRoots) + ' roots come down to ' + grouped(allCores) + ' ' +
    'different cores, MORE than there were roots, because ' + grouped(plural) +
    ' of those roots have more than one shortest core and each is a word in its ' +
    'own right. A core’s count is how many words hold it among their shortest, ' +
    'so these families overlap on purpose: zebra is counted under ebra, zeba ' +
    'and zebr alike, and they do not sum to the ' + grouped(allCosting) +
    ' words that cost anything. Roots are of every sortable word; cores only of ' +
    'the ones that cost something, since an already-sorted word comes down to ' +
    'no letters at all.';

  peakMeta.textContent = 'the record is ' + worst.peak + ', in ' + worst.name;
  peakNote.textContent =
    'The words inside the ramp’s last step, one row per dictionary, all ' +
    LANGS.length + ' of them whatever the switches are set to. Ties are the rule ' +
    'rather than the exception, so every word holding a record is listed, up to ' +
    'six of them, in the order the dictionary prints them; where more tie than ' +
    'fit, the count says how many. Click one to put it in the field at the top ' +
    'and see the alphabet it needs.';

  drawPick();
  drawRampKey(keyB, true);
  drawPeaks();
  drawMets();
  drawTable();
  draw();

  return {
    /* Putting a word in the field and letting the ordinary input path answer
       it. Shared with script.js rather than written twice: the record words
       here and the cores up in the results are the same affordance, and the
       fiddly parts — not focusing a field on a touch screen, not animating a
       scroll for a reader who asked for no motion — should not have two
       copies that can drift. */
    runWord: runWord,

    /* Called by script.js when the field is answered, so both figures can
       outline the band that word falls in. */
    mark: function (distance, word) {
      atDistance = (distance === null || distance === undefined) ? null : distance;
      atWord = word || '';
      draw();
    }
  };
})();
