/* Abecedarian Distance: the figure at the foot of the page. Draws the four
   dictionary surveys in data/dictionaries.js as one grouped column chart, and
   marks where the word currently in the field falls.

   The counting is not done here. It was done once, offline, by
   tools/abecedarian-corpus.mjs, running the same engine this page runs; what
   ships is sixty numbers rather than four megabytes of word lists, and the tool
   still opens no socket. This file only draws them.

   Redrawn at the container's pixel width rather than scaled from a fixed
   viewBox, because a viewBox that stretches takes the type with it: a 10px
   axis label becomes 6px on a phone and 14px on a desktop, and neither is the
   size it was chosen at. */

var CORPUS = (function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var LANGS = ABC_CORPUS.languages;
  var MAXD = ABC_CORPUS.maxDistance;

  var pick = document.getElementById('corpusPick');
  var meta = document.getElementById('corpusMeta');
  var wrap = document.getElementById('chartWrap');
  var chart = document.getElementById('chart');
  var tip = document.getElementById('chartTip');
  var live = document.getElementById('chartLive');
  var note = document.getElementById('chartNote');
  var tableBtn = document.getElementById('tableBtn');
  var tableBox = document.getElementById('corpusTable');

  /* Which dictionaries are drawn, and where the reader's word sits. Both are
     state the chart reads on every redraw. */
  var on = {};
  LANGS.forEach(function (l) { on[l.id] = true; });
  var atDistance = null;                 // the field's answer, or null
  var atWord = '';
  var hover = null;                      // the band under the pointer or caret

  /* Thin spaces every three digits, as the seed and the fact list use. Its own
     copy rather than a shared one: this file loads before script.js and should
     not reach forward into it for a one-line helper. */
  function grouped(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  /* One decimal down to a tenth of a percent, two below that. The four
     dictionaries sit within a couple of points of each other at the peak, and a
     rounded whole number would print three of them as the same figure. */
  function pct(n) {
    return n >= 1 ? n.toFixed(1) : n.toFixed(2);
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

  var shown = function () { return LANGS.filter(function (l) { return on[l.id]; }); };
  /* Every share on this figure is a share of the words that HAVE a distance.
     The ones no alphabet sorts are counted too — they are most of every
     dictionary — but they are not a distance and cannot stand on this axis, so
     they are printed as a number per language instead. */
  var share = function (l, d) { return l.sortable ? (l.counts[d] / l.sortable) * 100 : 0; };

  /* ── The picker, which is also the legend ────────────────────────────────
     One control doing both jobs. A legend that cannot be switched off would sit
     beside four switches carrying the same four names and the same four inks,
     which is the same information printed twice; and a set of switches with no
     ink on them would leave the figure identified by colour alone. So the ink
     is on the switch. */
  function drawPick() {
    pick.textContent = '';
    LANGS.forEach(function (l) {
      var b = el('button', 'pick');
      b.type = 'button';
      b.dataset.lang = l.id;
      b.appendChild(el('i', 'pick-ink ink-' + l.id));
      b.appendChild(el('span', 'pick-name', l.name));
      b.appendChild(el('code', 'pick-n', grouped(l.sortable)));
      /* data-tip rather than title: the page draws its own tooltips, and the
         count on the switch is the half of the dictionary the figure can draw,
         which is worth saying somewhere other than the table. */
      b.dataset.tip = grouped(l.sortable) + ' of ' + grouped(l.words) + ' ' +
        l.name + ' words have a distance; ' + grouped(l.unsortable) + ' have none. ' +
        l.dict + '.';
      b.addEventListener('click', function () {
        /* The last one on stays on. An empty figure is not a view of the data,
           it is a broken page, and the reader who switched everything off has
           no way of knowing which it was. */
        if (on[l.id] && shown().length === 1) return;
        on[l.id] = !on[l.id];
        /* The switch is restyled, not rebuilt. Rebuilding the row would destroy
           the element the reader is standing on, and a keyboard would be thrown
           back to the top of the page by its own click. */
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
      var state = on[all[i].dataset.lang];
      all[i].classList.toggle('is-on', state);
      all[i].setAttribute('aria-pressed', state ? 'true' : 'false');
    }
  }

  /* ── The figure ──────────────────────────────────────────────────────────
     Grouped columns: one band per distance, one column per dictionary that is
     switched on. Grouped rather than overlaid, because four translucent
     histograms laid over each other produce a fifth, sixth and seventh colour
     that mean nothing, and the eye reads those before it reads the data. */

  var PAD = { top: 14, right: 6, bottom: 42, left: 44 };
  var PLOT_H = 232;
  var BAR_MAX = 24;                       // a column never fills its slot
  var GAP = 2;                            // the surface gap between columns

  /* The axis stops just above the tallest column rather than at the next ten,
     which would leave a third of the sheet empty above the data; the ruled
     lines stay on tens, so the reader still counts in tens. */
  function ticks(maxShare) {
    var top = Math.max(10, Math.ceil(maxShare / 5) * 5);
    var out = [];
    for (var v = 0; v <= top; v += 10) out.push(v);
    return { top: top, values: out };
  }

  function draw() {
    if (!wrap) return;
    var W = Math.max(280, Math.round(wrap.clientWidth));
    var H = PAD.top + PLOT_H + PAD.bottom;
    var plotW = W - PAD.left - PAD.right;
    var y0 = PAD.top + PLOT_H;

    var live4 = shown();
    var high = 0;
    live4.forEach(function (l) {
      for (var d = 0; d <= MAXD; d++) high = Math.max(high, share(l, d));
    });
    var scale = ticks(high);
    var yOf = function (v) { return y0 - (v / scale.top) * PLOT_H; };

    var bands = MAXD + 1;
    var bandW = plotW / bands;
    var n = live4.length;
    var barW = Math.min(BAR_MAX, Math.max(1.5, (bandW * 0.74 - GAP * (n - 1)) / n));
    var groupW = barW * n + GAP * (n - 1);

    chart.textContent = '';
    chart.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    chart.setAttribute('width', W);
    chart.setAttribute('height', H);
    chart.setAttribute('aria-label',
      'The distances needed by the words of ' + live4.map(function (l) { return l.name; }).join(', ') +
      '. Most words need two or three swaps; the full figures are in the table below.');

    /* Grid first, so every mark lands on top of it. Solid hairlines one step
       off the sheet: a dashed grid reads as a threshold, and this one is only
       a ruler. */
    scale.values.forEach(function (v) {
      chart.appendChild(node('line', {
        class: v === 0 ? 'ax-base' : 'ax-grid',
        x1: PAD.left, x2: W - PAD.right, y1: yOf(v), y2: yOf(v)
      }));
      var t = node('text', { class: 'ax-tick ax-tick-y', x: PAD.left - 8, y: yOf(v) + 3.5 });
      t.textContent = v + '%';
      chart.appendChild(t);
    });

    /* The reader's own word, as a hand annotation rather than as a series: a
       hairline down the band it belongs in, with the word at the top of it.
       Drawn under the columns, so it never hides one. */
    if (atDistance !== null && atDistance <= MAXD) {
      var mx = PAD.left + bandW * (atDistance + 0.5);
      chart.appendChild(node('line', { class: 'ax-mark', x1: mx, x2: mx, y1: PAD.top - 2, y2: y0 }));
      var mt = node('text', { class: 'ax-mark-label', x: mx, y: PAD.top - 5 });
      mt.textContent = atWord;
      chart.appendChild(mt);
    }

    for (var d = 0; d <= MAXD; d++) {
      var x0 = PAD.left + bandW * d + (bandW - groupW) / 2;

      live4.forEach(function (l, i) {
        if (l.counts[d] === 0) return;
        var h = (share(l, d) / scale.top) * PLOT_H;
        /* A hairline floor for the tail. Seven German words need nine swaps,
           which is 0.07% and a fifth of a pixel; drawn to scale it is not a
           short column, it is no column, and the reader would take the tail to
           end two bands earlier than it does. So a non-zero count gets at least
           a hairline, and the note says the floor is there. Exact counts are in
           the table, where nothing is rounded up to be visible. */
        h = Math.max(h, 1);
        var x = x0 + i * (barW + GAP);
        /* A 4px rounded data-end, square where it meets the baseline — and no
           rounding at all on a column shorter than the radius, which would
           otherwise turn a hairline value into a lozenge. */
        var r = Math.min(4, barW / 2, h);
        chart.appendChild(node('path', {
          class: 'bar ink-' + l.id,
          d: 'M' + x + ',' + y0 +
             'V' + (y0 - h + r) +
             'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + -r +
             'h' + (barW - 2 * r) +
             'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
             'V' + y0 + 'Z'
        }));
      });

      var xt = node('text', {
        class: 'ax-tick ax-tick-x' + (d === atDistance ? ' is-at' : ''),
        x: PAD.left + bandW * (d + 0.5), y: y0 + 16
      });
      xt.textContent = String(d);
      chart.appendChild(xt);

      /* The hit target is the whole band, floor to ceiling, so the reader aims
         at a distance rather than at a 3px column — and the readout then names
         every dictionary at that distance, which is the answer to the question
         they were actually asking. */
      var hit = node('rect', {
        class: 'band' + (d === hover ? ' is-on' : ''),
        x: PAD.left + bandW * d, y: PAD.top, width: bandW, height: PLOT_H
      });
      hit.dataset.d = d;
      chart.appendChild(hit);
    }

    var xl = node('text', { class: 'ax-title', x: PAD.left + plotW / 2, y: y0 + 36 });
    xl.textContent = 'swaps of the alphabet';
    chart.appendChild(xl);

    if (hover !== null) place(hover);
  }

  /* ── The readout ─────────────────────────────────────────────────────────
     Everything it shows is also in the table below, which is the rule: a
     tooltip may add convenience and may never be the only way to a number. */
  function place(d) {
    var live4 = shown();
    tip.textContent = '';
    var head = el('p', 'tip-head', d + (d === 1 ? ' swap' : ' swaps'));
    tip.appendChild(head);
    var dl = el('dl', 'tip-rows');
    live4.forEach(function (l) {
      var dt = el('dt', null);
      /* A stroke of the ink rather than the switch's filled square: at this
         size a box is a data-weight mark doing a label's job, and the switch's
         square also carries an on/off state that means nothing in here. */
      dt.appendChild(el('i', 'tip-key ink-' + l.id));
      dt.appendChild(document.createTextNode(l.name));
      dl.appendChild(dt);
      var dd = el('dd', null);
      dd.appendChild(el('b', null, pct(share(l, d)) + '%'));
      dd.appendChild(el('span', 'tip-n', grouped(l.counts[d]) + (l.counts[d] === 1 ? ' word' : ' words')));
      dl.appendChild(dd);
    });
    tip.appendChild(dl);
    tip.hidden = false;

    /* Beside the band rather than over it, and on whichever side has the room:
       a readout that covers the columns it is describing is answering a
       question by hiding the answer. Then pulled back inside the sheet if it
       would still hang off an edge. */
    var W = wrap.clientWidth;
    var bandW = (W - PAD.left - PAD.right) / (MAXD + 1);
    var centre = PAD.left + bandW * (d + 0.5);
    var w = tip.offsetWidth;
    var clear = bandW / 2 + 8;
    var left = d * 2 < MAXD ? centre + clear : centre - clear - w;
    tip.style.left = Math.max(0, Math.min(W - w, left)) + 'px';

    live.textContent = d + (d === 1 ? ' swap: ' : ' swaps: ') +
      live4.map(function (l) { return l.name + ' ' + pct(share(l, d)) + '%'; }).join(', ');
  }

  function bandAt(ev) {
    var box = chart.getBoundingClientRect();
    var x = ev.clientX - box.left - PAD.left;
    var bandW = (box.width - PAD.left - PAD.right) / (MAXD + 1);
    var d = Math.floor(x / bandW);
    return d >= 0 && d <= MAXD ? d : null;
  }

  function setHover(d) {
    if (d === hover) return;
    hover = d;
    var bands = chart.querySelectorAll('.band');
    for (var i = 0; i < bands.length; i++)
      bands[i].classList.toggle('is-on', Number(bands[i].dataset.d) === hover);
    if (hover === null) { tip.hidden = true; live.textContent = ''; }
    else place(hover);
  }

  /* ── The numbers ─────────────────────────────────────────────────────────
     The figure's twin, and the reason the tooltip is allowed to be a
     convenience. Every count in the survey is here, including the words no
     alphabet sorts, which have no place on the axis above. */
  function drawTable() {
    var table = el('table');
    var thead = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', null, 'swaps'));
    LANGS.forEach(function (l) { hr.appendChild(el('th', null, l.name)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tb = el('tbody');
    for (var d = 0; d <= MAXD; d++) {
      var tr = el('tr');
      tr.appendChild(el('td', 'num-key', String(d)));
      LANGS.forEach(function (l) {
        var td = el('td', null, grouped(l.counts[d]));
        td.title = pct(share(l, d)) + '% of ' + l.name + ' words that have a distance';
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    }

    var totals = el('tr', 'num-sum');
    totals.appendChild(el('td', 'num-key', 'with a distance'));
    LANGS.forEach(function (l) { totals.appendChild(el('td', null, grouped(l.sortable))); });
    tb.appendChild(totals);

    var none = el('tr', 'num-sum');
    none.appendChild(el('td', 'num-key', 'no distance'));
    LANGS.forEach(function (l) {
      none.appendChild(el('td', null,
        grouped(l.unsortable) + '  (' + pct((l.unsortable / l.words) * 100) + '%)'));
    });
    tb.appendChild(none);

    var all = el('tr', 'num-sum');
    all.appendChild(el('td', 'num-key', 'words'));
    LANGS.forEach(function (l) { all.appendChild(el('td', null, grouped(l.words))); });
    tb.appendChild(all);

    table.appendChild(tb);
    var scroll = el('div', 'sheet-scroll');
    scroll.appendChild(table);
    tableBox.textContent = '';
    tableBox.appendChild(scroll);
  }

  /* ── Wiring ──────────────────────────────────────────────────────────────
     Pointer and caret get the same readout, which is the whole of the
     keyboard story here: the arrows walk the bands, Escape puts the readout
     away, and anything the readout would have said is in the table anyway. */
  chart.addEventListener('pointermove', function (ev) { setHover(bandAt(ev)); });
  chart.addEventListener('pointerleave', function () { setHover(null); });
  chart.addEventListener('blur', function () { setHover(null); });
  chart.addEventListener('keydown', function (ev) {
    var k = ev.key, d = hover === null ? (atDistance === null ? 0 : atDistance) : hover;
    if (k === 'ArrowLeft') d = Math.max(0, d - 1);
    else if (k === 'ArrowRight') d = Math.min(MAXD, d + 1);
    else if (k === 'Home') d = 0;
    else if (k === 'End') d = MAXD;
    else if (k === 'Escape') { setHover(null); return; }
    else return;
    ev.preventDefault();
    setHover(d);
  });

  tableBtn.addEventListener('click', function () {
    var open = tableBox.hidden;
    tableBox.hidden = !open;
    tableBtn.classList.toggle('is-active', open);
    tableBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  if (window.ResizeObserver) new ResizeObserver(function () { draw(); }).observe(wrap);
  else window.addEventListener('resize', draw);

  var words = LANGS.reduce(function (a, l) { return a + l.words; }, 0);
  meta.textContent = grouped(words) + ' words · four spelling dictionaries';
  note.textContent =
    'Every headword of four Hunspell spelling dictionaries, folded to A–Z and run ' +
    'through the engine above. The columns are shares of the words that have a ' +
    'distance at all; most words have none — a letter that leaves and comes back ' +
    'defeats every ordering — and how many is in the table. Anything the tail ' +
    'counts is drawn at least a hairline high, so a handful of words in a ' +
    'dictionary of thousands does not vanish; the table rounds nothing. ' +
    'Sources: SCOWL (English), ' +
    'RLA (Spanish), Dicollecte (French) and igerman98 (German), as packaged by ' +
    'wooorm/dictionaries @ ' + ABC_CORPUS.pin + '.';

  drawPick();
  drawTable();
  draw();

  return {
    /* Called by script.js when the field is answered, so the figure can say
       where that word stands among the four dictionaries. */
    mark: function (distance, word) {
      atDistance = (distance === null || distance === undefined) ? null : distance;
      atWord = word || '';
      draw();
    }
  };
})();
