/* Abecedarian Distance: the two figures and the record rows at the foot of the
   page. All three draw the dictionary surveys in data/dictionaries.js, and the
   first figure marks where the word currently in the field falls.

   Two figures on one set of numbers, because one axis cannot answer both
   questions. The first is a shape — grouped columns, linear, shares of the
   words that have a distance — and it says "two or three swaps" at a glance.
   The second is the ends — one point per distance, logarithmic, shares of
   every word — and it says how few words are abecedarian to begin with and how
   far the tail runs. Neither is a summary of the other.

   The first draws the four dictionaries the switches are on. The second draws
   all of them, those four in ink and the rest in grey, because "how far does
   this vary between languages" is a question about the whole set and the first
   figure has no room to ask it: thirteen dictionaries is a hundred and forty
   columns.

   The counting is not done here. It was done once, offline, by
   tools/abecedarian-corpus.mjs, running the same engine this page runs; what
   ships is a couple of hundred numbers rather than forty megabytes of word
   lists, and the tool still opens no socket. This file only draws them.

   Both are redrawn at the container's pixel width rather than scaled from a
   fixed viewBox, because a viewBox that stretches takes the type with it: a
   10px axis label becomes 6px on a phone and 14px on a desktop, and neither is
   the size it was chosen at. */

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

  var wrap = document.getElementById('chartWrap');
  var chart = document.getElementById('chart');
  var tip = document.getElementById('chartTip');

  var tailWrap = document.getElementById('tailWrap');
  var tailSvg = document.getElementById('tail');
  var tailTip = document.getElementById('tailTip');
  var tailMeta = document.getElementById('tailMeta');
  var tailNote = document.getElementById('tailNote');

  var peaks = document.getElementById('peaks');
  var peakMeta = document.getElementById('peakMeta');
  var peakNote = document.getElementById('peakNote');
  var field = document.getElementById('word');

  /* ── Four inks, thirteen dictionaries ────────────────────────────────────
     There are four inks and there is no fifth. They were searched for under
     five constraints at once and they are the only four that clear all of them
     pairwise; a fifth hue that a red-green reader could still tell from the
     other four does not exist inside the lightness and contrast the sheet
     needs. Thirteen languages therefore cannot each own a colour.

     So colour is a spotlight rather than a name. Every dictionary is always
     drawn; four of them at a time are struck in ink and the rest are grey. The
     switches move the spotlight.

     The one rule that survives from having a colour per series is that ink
     must not shuffle underneath the reader. A language holds its ink for as
     long as it is lit, and picking a fifth evicts the language that has been
     lit longest and hands the newcomer that one freed slot — so the three that
     stay keep the colour they had. Nothing is ever repainted except the thing
     that just changed. */
  var slots = ['en', 'es', 'fr', 'de'];  // index is the ink; null is a free slot
  var order = [0, 1, 2, 3];              // slot indices, longest-lit first

  var byId = {};
  LANGS.forEach(function (l) { byId[l.id] = l; });
  /* The four the page opens on have to exist; a dictionary dropped from the
     survey must not leave a slot pointing at nothing. */
  slots = slots.map(function (id) { return byId[id] ? id : null; });

  function slotOf(id) { return slots.indexOf(id); }
  function isLit(id) { return slotOf(id) >= 0; }
  function lit() {
    return slots.map(function (id) { return id ? byId[id] : null; })
                .filter(Boolean);
  }
  function inkClass(l) {
    var s = slotOf(l.id);
    return s < 0 ? 'ghost' : 'ink-' + s;
  }

  function toggle(id) {
    var at = slotOf(id);
    if (at >= 0) {
      /* The last lit one stays lit. A figure with nothing struck in it is
         thirteen grey lines and no way to read one, which is not a view of the
         data. */
      if (lit().length === 1) return;
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
  var hover = null;                      // band under the pointer, first figure
  var tailHover = null;                  // slot under the pointer, second

  /* Thin spaces every three digits, as the seed and the fact list use. Its own
     copy rather than a shared one: this file loads before script.js and should
     not reach forward into it for a one-line helper. */
  function grouped(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  /* Percentages run from 81 down to 0.004 here, so a fixed number of decimals
     is either noise at the top or nothing at the bottom. Three significant
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

  /* Two denominators, one per figure, and the difference between them is the
     whole reason there are two figures. shareSortable is of the words that have
     a distance; shareAll is of every word the dictionary holds. */
  var shareSortable = function (l, d) { return l.sortable ? (l.counts[d] / l.sortable) * 100 : 0; };
  var shareAll = function (l, d) { return l.words ? (l.counts[d] / l.words) * 100 : 0; };
  var noneShare = function (l) { return l.words ? (l.unsortable / l.words) * 100 : 0; };

  /* ── The picker, which is also the legend ────────────────────────────────
     One control doing both jobs. A legend that could not be pressed would sit
     beside thirteen switches carrying the same thirteen names, which is the
     same information printed twice; and switches with no ink on them would
     leave the figures identified by colour alone. So the ink is on the switch.
     One row, above both figures, because it scopes both.

     The count came off the switch when the row went from four to thirteen. At
     four it was a useful second fact; at thirteen it doubled the width of a row
     that now has to wrap, to say something the table says better. It is still
     on the switch's tooltip. */
  function drawPick() {
    pick.textContent = '';
    LANGS.forEach(function (l) {
      var b = el('button', 'pick');
      b.type = 'button';
      b.dataset.lang = l.id;
      b.appendChild(el('i', 'pick-ink ' + inkClass(l)));
      b.appendChild(el('span', 'pick-name', l.name));
      /* data-tip rather than title: the page draws its own tooltips. */
      b.dataset.tip = grouped(l.sortable) + ' of ' + grouped(l.words) + ' ' +
        l.name + ' words have a distance; ' + grouped(l.unsortable) + ' have none. ' +
        l.dict + '.';
      b.addEventListener('click', function () {
        toggle(l.id);
        /* The switches are restyled, not rebuilt. Rebuilding the row would
           destroy the element the reader is standing on, and a keyboard would
           be thrown back to the top of the page by its own click. */
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
      var b = all[i];
      var l = byId[b.dataset.lang];
      var on = isLit(l.id);
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.querySelector('.pick-ink').className = 'pick-ink ' + inkClass(l);
    }
    syncPeaks();
  }

  /* ── Figure one: the shape ───────────────────────────────────────────────
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

  function drawBars() {
    if (!wrap) return;
    var W = Math.max(280, Math.round(wrap.clientWidth));
    var H = PAD.top + PLOT_H + PAD.bottom;
    var plotW = W - PAD.left - PAD.right;
    var y0 = PAD.top + PLOT_H;

    var live4 = lit();
    var high = 0;
    live4.forEach(function (l) {
      for (var d = 0; d <= MAXD; d++) high = Math.max(high, shareSortable(l, d));
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
      'How far the alphabet has to move, for the words of ' +
      live4.map(function (l) { return l.name; }).join(', ') +
      ', as a share of the words that have a distance. Most need two or three ' +
      'swaps. The full figures are in the table below.');

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
        var h = (shareSortable(l, d) / scale.top) * PLOT_H;
        /* A hairline floor for the tail. Seven German words need nine swaps,
           which is 0.07% and a fifth of a pixel; drawn to scale it is not a
           short column, it is no column, and the reader would take the tail to
           end two bands earlier than it does. So a non-zero count gets at least
           a hairline, and the note says the floor is there. The figure below
           has no need of the trick — a log axis gives the tail its own room —
           and the table rounds nothing up to be visible. */
        h = Math.max(h, 1);
        var x = x0 + i * (barW + GAP);
        /* A 4px rounded data-end, square where it meets the baseline — and no
           rounding at all on a column shorter than the radius, which would
           otherwise turn a hairline value into a lozenge. */
        var r = Math.min(4, barW / 2, h);
        chart.appendChild(node('path', {
          class: 'bar ' + inkClass(l),
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

  /* ── Figure two: the ends ────────────────────────────────────────────────
     One point per distance per dictionary, on a logarithmic axis, as a share of
     every word rather than of the sortable ones.

     Points and lines, not columns. A column says "this much" by its length from
     a baseline, and a log axis has no baseline to measure from — zero is
     infinitely far down it. A point says "here", which is all a log axis can
     honestly support. */

  var TPAD = { top: 16, right: 10, bottom: 42, left: 54 };
  var TPLOT_H = 214;
  var DECADES = [0.001, 0.01, 0.1, 1, 10, 100];
  var LOW = 0.001, HIGH = 100;

  function logY(v, y0) {
    var t = (Math.log(v) - Math.log(LOW)) / (Math.log(HIGH) - Math.log(LOW));
    return y0 - Math.max(0, Math.min(1, t)) * TPLOT_H;
  }

  /* Two zones: the words no alphabet sorts, then the eleven distances, with a
     gap and a rule between them. "None" stands apart because it is not a
     distance — putting it on the axis as though it were would be the figure
     saying something the survey does not.

     The none zone is measured rather than given a share of the width, because
     what it has to hold is four dots side by side and that is a number of
     pixels, not a fraction of the sheet. Given a share, it shrank with the
     page and the four dots merged again at phone width. */
  var LANE = 9;                            // one dot's lane in the none zone
  function tailLayout(W, n) {
    var plotW = W - TPAD.left - TPAD.right;
    var noneW = Math.max(38, LANE * n + 10);
    var gap = 14;
    return {
      noneW: noneW, gap: gap, lanes: n,
      lane: Math.min(11, (noneW - 8) / Math.max(1, n)),
      distW: (plotW - noneW - gap) / (MAXD + 1),
      left: TPAD.left
    };
  }
  /* Slot -1 is "none"; lane is which dictionary's dot within it. */
  function tailX(slot, W, lane, n) {
    var L = tailLayout(W, n || lit().length);
    if (slot < 0) {
      var i = lane === undefined ? (L.lanes - 1) / 2 : lane;
      return L.left + L.noneW / 2 + (i - (L.lanes - 1) / 2) * L.lane;
    }
    return L.left + L.noneW + L.gap + L.distW * (slot + 0.5);
  }

  function drawTail() {
    if (!tailWrap) return;
    var W = Math.max(280, Math.round(tailWrap.clientWidth));
    var H = TPAD.top + TPLOT_H + TPAD.bottom;
    var y0 = TPAD.top + TPLOT_H;
    var live4 = lit();
    var L = tailLayout(W, live4.length);

    /* The four "none" values sit between 61% and 81%, which is a fifth of a
       decade — five pixels on this axis, and four dots eight pixels across
       land on top of each other. So they are dealt sideways, one lane each.
       Nothing is lost by it: the zone has no scale along it, because "none" is
       a single category and not a position. The dots on the distances are never
       moved sideways, where x means something. */

    tailSvg.textContent = '';
    tailSvg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    tailSvg.setAttribute('width', W);
    tailSvg.setAttribute('height', H);
    tailSvg.setAttribute('aria-label',
      'The same survey as a share of every word, on a logarithmic axis, for ' +
      live4.map(function (l) { return l.name; }).join(', ') +
      '. Most words have no distance at all; few are already abecedarian; the ' +
      'tail runs to ten swaps in German. The full figures are in the table below.');

    DECADES.forEach(function (v) {
      var y = logY(v, y0);
      tailSvg.appendChild(node('line', {
        class: v === LOW ? 'ax-base' : 'ax-grid',
        x1: TPAD.left, x2: W - TPAD.right, y1: y, y2: y
      }));
      var t = node('text', { class: 'ax-tick ax-tick-y', x: TPAD.left - 8, y: y + 3.5 });
      t.textContent = (v < 1 ? String(v) : String(v)) + '%';
      tailSvg.appendChild(t);
    });

    /* The rule that keeps "none" out of the sequence. */
    var split = L.left + L.noneW + L.gap / 2;
    tailSvg.appendChild(node('line', {
      class: 'ax-split', x1: split, x2: split, y1: TPAD.top, y2: y0
    }));

    /* One polyline per dictionary over the distances it actually reaches. The
       line simply stops where the counts do, which is the tail's end drawn
       rather than described: English runs out at eight, German at ten. */
    function trace(l, laneIndex) {
      var ghost = laneIndex === undefined;
      var pts = [];
      for (var d = 0; d <= MAXD; d++) {
        if (l.counts[d] === 0) continue;
        pts.push(tailX(d, W, undefined, live4.length) + ',' + logY(shareAll(l, d), y0));
      }
      if (pts.length > 1)
        tailSvg.appendChild(node('polyline', {
          class: 'trace ' + inkClass(l), points: pts.join(' ')
        }));

      /* A struck dictionary gets a dot at every distance, ringed in the
         sheet's own colour so two landing on the same value stay two dots. A
         grey one gets none: thirteen sets of dots is a texture, and what the
         grey lines are for is the shape of the family, not a value. */
      if (!ghost) {
        for (var q = 0; q <= MAXD; q++) {
          if (l.counts[q] === 0) continue;
          tailSvg.appendChild(node('circle', {
            class: 'dot ' + inkClass(l),
            cx: tailX(q, W, undefined, live4.length), cy: logY(shareAll(l, q), y0), r: 4
          }));
        }
      }
      /* "None" is the one value a grey dictionary keeps a dot for, because it
         is the figure's largest number and the cluster they make between 61%
         and 84% is itself the finding. The struck ones take their lanes; the
         grey ones stack on the zone's centre line and read as a band. */
      tailSvg.appendChild(node('circle', {
        class: 'dot dot-none ' + inkClass(l),
        cx: ghost ? L.left + L.noneW / 2 : tailX(-1, W, laneIndex, live4.length),
        cy: logY(noneShare(l), y0), r: ghost ? 2.5 : 4
      }));
    }

    LANGS.forEach(function (l) { if (!isLit(l.id)) trace(l); });
    live4.forEach(function (l, li) { trace(l, li); });

    var bands = [-1];
    for (var s = 0; s <= MAXD; s++) bands.push(s);
    bands.forEach(function (slot) {
      var centre = slot < 0 ? L.left + L.noneW / 2 : tailX(slot, W, undefined, live4.length);
      var w = slot < 0 ? L.noneW : L.distW;
      var t = node('text', {
        class: 'ax-tick ax-tick-x' + (slot === atDistance ? ' is-at' : '') +
               (slot < 0 ? ' ax-tick-none' : ''),
        x: centre, y: y0 + 16
      });
      t.textContent = slot < 0 ? 'none' : String(slot);
      tailSvg.appendChild(t);

      var hit = node('rect', {
        class: 'band' + (slot === tailHover ? ' is-on' : ''),
        x: centre - w / 2, y: TPAD.top, width: w, height: TPLOT_H
      });
      hit.dataset.d = slot;
      tailSvg.appendChild(hit);
    });

    var xl = node('text', {
      class: 'ax-title', x: TPAD.left + (W - TPAD.left - TPAD.right) / 2, y: y0 + 36
    });
    xl.textContent = 'swaps of the alphabet';
    tailSvg.appendChild(xl);

    if (tailHover !== null) placeTail(tailHover);
  }

  /* ── The readouts ────────────────────────────────────────────────────────
     Everything they show is also in the table below, which is the rule: a
     tooltip may add convenience and may never be the only way to a number. */
  function readout(box, host, slot, valueOf, countOf, headOf, pad, xOf) {
    var live4 = lit();
    box.textContent = '';
    box.appendChild(el('p', 'tip-head', headOf(slot)));
    var dl = el('dl', 'tip-rows');
    live4.forEach(function (l) {
      var dt = el('dt', null);
      /* A stroke of the ink rather than the switch's filled square: at this
         size a box is a data-weight mark doing a label's job, and the switch's
         square also carries an on/off state that means nothing in here. */
      dt.appendChild(el('i', 'tip-key ' + inkClass(l)));
      dt.appendChild(document.createTextNode(l.name));
      dl.appendChild(dt);
      var n = countOf(l, slot);
      var dd = el('dd', null);
      dd.appendChild(el('b', null, pct(valueOf(l, slot)) + '%'));
      dd.appendChild(el('span', 'tip-n', grouped(n) + (n === 1 ? ' word' : ' words')));
      dl.appendChild(dd);
    });
    /* One line for the grey. Without it the readout answers for four
       dictionaries while thirteen are drawn, and the nine unnamed lines have no
       number a reader can reach without opening the table. The range is not a
       fifth series — it is the extent of the ones this readout is not naming. */
    if (LANGS.length > live4.length) {
      var all = LANGS.map(function (l) { return valueOf(l, slot); });
      var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
      var dt2 = el('dt', 'tip-all');
      dt2.appendChild(el('i', 'tip-key ghost'));
      dt2.appendChild(document.createTextNode('all ' + LANGS.length));
      dl.appendChild(dt2);
      var dd2 = el('dd', 'tip-all');
      dd2.appendChild(el('span', 'tip-n', pct(lo) + '–' + pct(hi) + '%'));
      dl.appendChild(dd2);
    }

    box.appendChild(dl);
    box.hidden = false;

    /* Beside the slot rather than over it, and on whichever side has the room:
       a readout that covers the marks it is describing is answering a question
       by hiding the answer. Then pulled back inside the sheet if it would still
       hang off an edge. */
    var W = host.clientWidth;
    var centre = xOf(slot, W);
    var w = box.offsetWidth;
    var clear = 14;
    var left = centre < (W / 2) ? centre + clear : centre - clear - w;
    box.style.left = Math.max(0, Math.min(W - w, left)) + 'px';

    live.textContent = headOf(slot) + ': ' +
      live4.map(function (l) { return l.name + ' ' + pct(valueOf(l, slot)) + '%'; }).join(', ');
  }

  function place(d) {
    readout(tip, wrap, d,
      shareSortable,
      function (l, k) { return l.counts[k]; },
      function (k) { return k + (k === 1 ? ' swap' : ' swaps'); },
      PAD,
      function (k, W) {
        var bandW = (W - PAD.left - PAD.right) / (MAXD + 1);
        return PAD.left + bandW * (k + 0.5);
      });
  }

  function placeTail(slot) {
    readout(tailTip, tailWrap, slot,
      function (l, k) { return k < 0 ? noneShare(l) : shareAll(l, k); },
      function (l, k) { return k < 0 ? l.unsortable : l.counts[k]; },
      function (k) { return k < 0 ? 'no distance' : k + (k === 1 ? ' swap' : ' swaps'); },
      TPAD,
      function (k, W) {
        var L = tailLayout(W, lit().length);
        return k < 0 ? L.left + L.noneW / 2 : tailX(k, W, undefined, lit().length);
      });
  }

  function bandAt(ev) {
    var box = chart.getBoundingClientRect();
    var x = ev.clientX - box.left - PAD.left;
    var bandW = (box.width - PAD.left - PAD.right) / (MAXD + 1);
    var d = Math.floor(x / bandW);
    return d >= 0 && d <= MAXD ? d : null;
  }

  function tailSlotAt(ev) {
    var box = tailSvg.getBoundingClientRect();
    var L = tailLayout(box.width, lit().length);
    var x = ev.clientX - box.left - L.left;
    if (x < 0) return null;
    if (x < L.noneW) return -1;
    var d = Math.floor((x - L.noneW - L.gap) / L.distW);
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

  function setTailHover(slot) {
    if (slot === tailHover) return;
    tailHover = slot;
    var bands = tailSvg.querySelectorAll('.band');
    for (var i = 0; i < bands.length; i++)
      bands[i].classList.toggle('is-on', Number(bands[i].dataset.d) === tailHover);
    if (tailHover === null) { tailTip.hidden = true; live.textContent = ''; }
    else placeTail(tailHover);
  }

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
    LANGS.forEach(function (l) {
      var li = el('li', 'peak');
      li.dataset.lang = l.id;

      var who = el('span', 'peak-who');
      who.appendChild(el('i', 'peak-ink ' + inkClass(l)));
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

  /* Every dictionary keeps its row. The switches move ink, not visibility, and
     hiding nine records because their languages are not currently struck would
     make the reader hunt for a fact through a control that is about colour. */
  function syncPeaks() {
    var rows = peaks.querySelectorAll('.peak');
    for (var i = 0; i < rows.length; i++) {
      var l = byId[rows[i].dataset.lang];
      rows[i].classList.toggle('is-lit', isLit(l.id));
      rows[i].querySelector('.peak-ink').className = 'peak-ink ' + inkClass(l);
    }
  }

  /* ── The numbers ─────────────────────────────────────────────────────────
     The figures' twin, and the reason a tooltip is allowed to be a
     convenience. Counts only, one number to a cell: the two figures work in
     two different denominators, and a table that printed a percentage would
     have to pick one of them and then explain which. Counts need no
     denominator, and every share either figure draws can be got from them. */
  /* A row per dictionary, not a column. It was the other way round at four,
     where four columns fitted a sheet; at thirteen the header would run off
     the side and a reader looking for one language would be scrolling
     sideways to find its column and then reading a number a screen away from
     its name. A row keeps the name against its own figures, and the row IS the
     distribution — read across and the shape is there. */
  function drawTable() {
    var table = el('table');
    var thead = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', 'num-key', 'dictionary'));
    for (var h = 0; h <= MAXD; h++) hr.appendChild(el('th', 'num', String(h)));
    ['with a distance', 'no distance', 'every word'].forEach(function (t) {
      hr.appendChild(el('th', 'num num-wide', t));
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tb = el('tbody');
    LANGS.forEach(function (l) {
      var tr = el('tr');
      tr.appendChild(el('td', 'num-key', l.name));
      for (var d = 0; d <= MAXD; d++)
        tr.appendChild(el('td', 'num', grouped(l.counts[d])));
      tr.appendChild(el('td', 'num num-sum', grouped(l.sortable)));
      tr.appendChild(el('td', 'num num-sum', grouped(l.unsortable)));
      tr.appendChild(el('td', 'num num-sum', grouped(l.words)));
      tb.appendChild(tr);
    });

    table.appendChild(tb);
    var scroll = el('div', 'sheet-scroll');
    scroll.appendChild(table);
    tableBox.textContent = '';
    tableBox.appendChild(scroll);
    var cap = el('p', 'sheet-note table-note',
      'Counts, one number to a cell. The columns 0 to ' + MAXD + ' are how many ' +
      'of that dictionary’s words need exactly that many swaps; the last three ' +
      'are the totals the figures divide by.');
    tableBox.appendChild(cap);
  }

  /* ── Wiring ──────────────────────────────────────────────────────────────
     Pointer and caret get the same readout, which is the whole of the keyboard
     story here: the arrows walk the slots, Escape puts the readout away, and
     anything the readout would have said is in the table anyway. */
  function keys(svg, get, set, lo, hi) {
    svg.addEventListener('pointermove', function (ev) { set(get(ev)); });
    svg.addEventListener('pointerleave', function () { set(null); });
    svg.addEventListener('blur', function () { set(null); });
    svg.addEventListener('keydown', function (ev) {
      var cur = svg === chart ? hover : tailHover;
      var k = ev.key;
      var d = cur === null ? (atDistance === null ? lo : atDistance) : cur;
      if (k === 'ArrowLeft') d = Math.max(lo, d - 1);
      else if (k === 'ArrowRight') d = Math.min(hi, d + 1);
      else if (k === 'Home') d = lo;
      else if (k === 'End') d = hi;
      else if (k === 'Escape') { set(null); return; }
      else return;
      ev.preventDefault();
      set(d);
    });
  }
  keys(chart, bandAt, setHover, 0, MAXD);
  keys(tailSvg, tailSlotAt, setTailHover, -1, MAXD);

  tableBtn.addEventListener('click', function () {
    var open = tableBox.hidden;
    tableBox.hidden = !open;
    tableBtn.classList.toggle('is-active', open);
    tableBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  function draw() { drawBars(); drawTail(); syncPeaks(); }

  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { draw(); });
    ro.observe(wrap);
    ro.observe(tailWrap);
  } else {
    window.addEventListener('resize', draw);
  }

  var words = LANGS.reduce(function (a, l) { return a + l.words; }, 0);
  var sortable = LANGS.reduce(function (a, l) { return a + l.sortable; }, 0);
  var zero = LANGS.reduce(function (a, l) { return a + l.counts[0]; }, 0);
  var worst = LANGS.reduce(function (a, l) { return l.peak > a.peak ? l : a; }, LANGS[0]);
  var most = LANGS.reduce(function (a, l) { return noneShare(l) > noneShare(a) ? l : a; }, LANGS[0]);
  var least = LANGS.reduce(function (a, l) { return noneShare(l) < noneShare(a) ? l : a; }, LANGS[0]);

  meta.textContent = grouped(words) + ' words · ' + LANGS.length + ' spelling dictionaries';
  note.textContent =
    'Every headword of ' + LANGS.length + ' Hunspell spelling dictionaries, folded to ' +
    'A–Z and run through the engine above. Four at a time are struck in ink — the ' +
    'switches move the ink, and there is no fifth colour a red-green reader could ' +
    'still tell from the other four. The columns are shares of the words that have ' +
    'a distance at all, ' + grouped(sortable) + ' of the ' + grouped(words) + ', and ' +
    'anything the tail counts is drawn at least a hairline high so a handful of ' +
    'words does not vanish. The figure below drops both of those conveniences and ' +
    'draws all ' + LANGS.length + '. Sources are pinned to wooorm/dictionaries @ ' +
    ABC_CORPUS.pin + '; each switch names its own.';

  tailMeta.textContent = grouped(zero) + ' already abecedarian · ' +
    pct((zero / words) * 100) + '% of every word';
  tailNote.textContent =
    'Every dictionary, drawn; the four struck in ink are the ones the switches ' +
    'are on, and the grey ones are the rest of the family. Every share is of ' +
    'every word, so “none” — the words no ordering sorts — stands on the same ' +
    'axis as the rest, apart from the sequence because it is not a distance. It ' +
    'is the loosest figure in the survey, running from ' + pct(noneShare(least)) +
    '% of ' + least.name + ' to ' + pct(noneShare(most)) + '% of ' + most.name +
    ' — a language that builds long words by stacking endings on them puts ' +
    'nearly all of them out of reach. The axis is logarithmic, so each ruled ' +
    'line is ten times the one below and the far tail keeps its size. A point ' +
    'rather than a column, because a column measures from a baseline and a ' +
    'logarithmic axis has none.';

  peakMeta.textContent = 'the record is ' + worst.peak + ', in ' + worst.name;
  peakNote.textContent =
    'The words at the far end of the figure above, one row per dictionary, all ' +
    LANGS.length + ' of them whatever the switches are set to. Ties are the rule ' +
    'rather than the exception, so every word holding a record is listed, up to ' +
    'six of them, in the order the dictionary prints them; where more tie than ' +
    'fit, the count says how many. Click one to put it in the field at the top ' +
    'and see the alphabet it needs.';

  drawPick();
  drawPeaks();
  drawTable();
  draw();

  return {
    /* Called by script.js when the field is answered, so both figures can say
       where that word stands among the four dictionaries. */
    mark: function (distance, word) {
      atDistance = (distance === null || distance === undefined) ? null : distance;
      atWord = word || '';
      draw();
    }
  };
})();
