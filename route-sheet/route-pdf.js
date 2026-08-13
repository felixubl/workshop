/* The sheet. Written straight to bytes, as the PDF Toolkit and the bingo cards
   next door are: the site is checkable client-side code, and a route sheet is
   rules, type and one polyline, which is not worth half a megabyte of somebody
   else's library to draw.

   Two phases, because one of them may need the network and PDF writing should
   not. `layout` works out every page and every panel rectangle from the plan
   alone and returns them; the caller then fetches a map for each panel if the
   reader asked for one; `print` draws. With the map switched off the second
   phase never happens and the whole tool runs off the disk. */

;(function (Route) {
  "use strict";

  const geo = Route.geo;

  /* --- metrics ------------------------------------------------------------- */

  /* Adobe's published AFM widths for the two Helvetica faces every PDF reader
     already has, in 1/1000 em, indexed by WinAnsi byte from 0x20. Every string
     here is measured before it is placed — right-aligned in a column, centred
     in a marker, or wrapped in a cell — and it has to be measured against the
     font that will draw it rather than the one the browser would. */

  const W_REGULAR = [
    278, 278, 355, 556, 556, 889, 667, 222, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    222, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
    556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
    0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
    278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
    400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
  ];

  const W_BOLD = [
    278, 333, 474, 556, 556, 889, 722, 278, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    278, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 0,
    556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
    0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 889, 0, 500, 667,
    278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
    400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278,
    611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
  ];

  // Courier needs no table: every glyph in it is 600/1000 of the em, which is
  // the whole point of the face. Distances and coordinates are set in it so
  // that a column of numbers lines up on its digits.
  const COURIER = 600;
  const CAP = 0.718;

  const FONTS = { regular: "F1", bold: "F2", mono: "F3" };

  function widthOf(encoded, size, font) {
    if (font === "mono") return (encoded.length * COURIER * size) / 1000;
    const table = font === "bold" ? W_BOLD : W_REGULAR;
    let units = 0;
    for (let i = 0; i < encoded.length; i++) {
      const w = table[encoded.charCodeAt(i) - 0x20];
      units += w === undefined ? 0 : w;
    }
    return (units / 1000) * size;
  }

  /* --- WinAnsi ------------------------------------------------------------- */

  /* Route names arrive from wherever the file came from, which is to say from
     anywhere. WinAnsi covers western Europe; past that, a character is
     decomposed and its accent dropped, so a Czech street name comes out
     readable rather than as a row of boxes. */

  const C1 = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
    0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
    0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
    0x017e: 0x9e, 0x0178: 0x9f,
  };

  function encodeChar(ch) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) return [code];
    if (code >= 0xa0 && code <= 0xff) return [code];
    if (C1[code] !== undefined) return [C1[code]];
    const decomposed = ch.normalize("NFD");
    if (decomposed !== ch) {
      const out = [];
      for (const part of decomposed) {
        const p = part.codePointAt(0);
        if (p >= 0x0300 && p <= 0x036f) continue;
        const bytes = encodeChar(part);
        if (bytes) out.push(...bytes);
      }
      if (out.length) return out;
    }
    return null;
  }

  function enc(text) {
    let out = "";
    for (const ch of String(text == null ? "" : text)) {
      if (ch < " ") { out += " "; continue; }
      const bytes = encodeChar(ch);
      if (bytes) for (const b of bytes) out += String.fromCharCode(b);
    }
    return out;
  }

  // What the encoding cannot carry at all, asked before anything is drawn so
  // the answer arrives while the reader can still do something about it. An
  // accent is not a loss — it is dropped and the letter survives, which keeps a
  // Czech street name readable. A script with no Latin under it is a loss, and
  // the tool says which characters went rather than only that some did.
  function lost(text) {
    const gone = [];
    for (const ch of String(text || "")) {
      if (ch < " ") continue;
      if (!encodeChar(ch) && !gone.includes(ch)) gone.push(ch);
    }
    return gone;
  }

  /* --- content streams ------------------------------------------------------ */

  const fixed = (v) => {
    if (!Number.isFinite(v)) return "0";
    const s = v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    return s === "-0" || s === "" ? "0" : s;
  };

  function literal(encoded) {
    let out = "(";
    for (let i = 0; i < encoded.length; i++) {
      const c = encoded.charCodeAt(i) & 0xff;
      if (c === 0x28 || c === 0x29 || c === 0x5c) out += "\\" + encoded[i];
      else if (c < 0x20 || c > 0x7e) out += "\\" + c.toString(8).padStart(3, "0");
      else out += encoded[i];
    }
    return out + ")";
  }

  class Content {
    constructor() { this.ops = []; this.images = new Set(); }

    push(op) { this.ops.push(op); return this; }
    save() { return this.push("q"); }
    restore() { return this.push("Q"); }

    fill(colour) { return this.push(`${rgb(colour)} rg`); }
    stroke(colour) { return this.push(`${rgb(colour)} RG`); }
    width(w) { return this.push(`${fixed(w)} w`); }
    cap(mode) { return this.push(`${mode} J`); }
    join(mode) { return this.push(`${mode} j`); }
    dash(on, off) { return this.push(off ? `[${fixed(on)} ${fixed(off)}] 0 d` : "[] 0 d"); }
    alpha(name) { return this.push(`/${name} gs`); }

    moveTo(x, y) { return this.push(`${fixed(x)} ${fixed(y)} m`); }
    lineTo(x, y) { return this.push(`${fixed(x)} ${fixed(y)} l`); }
    curveTo(x1, y1, x2, y2, x3, y3) {
      return this.push(`${fixed(x1)} ${fixed(y1)} ${fixed(x2)} ${fixed(y2)} ${fixed(x3)} ${fixed(y3)} c`);
    }
    close() { return this.push("h"); }
    rect(x, y, w, h) { return this.push(`${fixed(x)} ${fixed(y)} ${fixed(w)} ${fixed(h)} re`); }
    paint(mode) { return this.push(mode); }
    clip() { return this.push("W n"); }

    // A circle from four Béziers. 0.5523 is the classic magic number: the
    // control-point offset that puts the maximum radial error of a quarter-arc
    // approximation at about one part in ten thousand.
    circle(cx, cy, r) {
      const k = r * 0.5523;
      this.moveTo(cx, cy + r);
      this.curveTo(cx + k, cy + r, cx + r, cy + k, cx + r, cy);
      this.curveTo(cx + r, cy - k, cx + k, cy - r, cx, cy - r);
      this.curveTo(cx - k, cy - r, cx - r, cy - k, cx - r, cy);
      this.curveTo(cx - r, cy + k, cx - k, cy + r, cx, cy + r);
      return this.close();
    }

    polyline(pts) {
      if (!pts.length) return this;
      this.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) this.lineTo(pts[i].x, pts[i].y);
      return this;
    }

    image(name, x, y, w, h) {
      this.images.add(name);
      return this.push(`q ${fixed(w)} 0 0 ${fixed(h)} ${fixed(x)} ${fixed(y)} cm /${name} Do Q`);
    }

    text(str, x, y, size, font) {
      if (!str) return this;
      return this.push(
        `BT /${FONTS[font] || FONTS.regular} ${fixed(size)} Tf ` +
        `1 0 0 1 ${fixed(x)} ${fixed(y)} Tm ${literal(str)} Tj ET`
      );
    }

    right(str, x, y, size, font) {
      return this.text(str, x - widthOf(str, size, font), y, size, font);
    }

    centred(str, cx, y, size, font) {
      return this.text(str, cx - widthOf(str, size, font) / 2, y, size, font);
    }

    // Centred in both directions, on the capitals rather than the baseline:
    // a number in a marker looks centred when its caps straddle the middle.
    inBox(str, cx, cy, size, font) {
      return this.centred(str, cx, cy - (CAP * size) / 2, size, font);
    }

    toString() { return this.ops.join("\n"); }
  }

  const rgb = (c) => `${fixed(c[0])} ${fixed(c[1])} ${fixed(c[2])}`;
  const hex = (s) => [
    parseInt(s.slice(1, 3), 16) / 255,
    parseInt(s.slice(3, 5), 16) / 255,
    parseInt(s.slice(5, 7), 16) / 255,
  ];
  const grey = (v) => [v, v, v];

  /* The workshop's plates, as the press mixes them. The route is plate 2,
     because a red line is the one thing on a grey map that survives a tired
     office printer, and because a route line has been red since the AA started
     drawing them. */
  const INK = {
    line: hex("#ed0a3f"),
    ink: hex("#171716"),
    rule: grey(0.72),
    faint: grey(0.86),
    soft: grey(0.42),
    mid: grey(0.55),
    paper: grey(1),
    casing: grey(1),
    marker: hex("#171716"),
  };

  /* --- paper ---------------------------------------------------------------- */

  const PAPER = {
    a4: { width: 595.28, height: 841.89, label: "A4" },
    letter: { width: 612, height: 792, label: "US Letter" },
    a5: { width: 419.53, height: 595.28, label: "A5" },
  };

  const MARGIN = 42;

  function sheetSize(settings) {
    const base = PAPER[settings.paper] || PAPER.a4;
    if (settings.orientation === "landscape") {
      return { width: base.height, height: base.width, label: `${base.label} landscape` };
    }
    return { ...base, label: base.label };
  }

  /* --- views ---------------------------------------------------------------- */

  /* A panel has to hold the same geographic window whether or not a map is
     fetched for it, and when one is, the tiles have to line up with the line
     drawn over them to the pixel. So the tile view is the authority when tiles
     are on: it is computed in device pixels at a whole-number zoom, and the
     paper view is that same view divided down to points. With tiles off there
     is nothing to line up with and the fit can be fractional, which frames the
     route a little tighter. */
  function panelViews(box, w, h, padding, settings) {
    if (settings.tiles === "off") {
      return { paper: geo.view(box, w, h, padding), tile: null };
    }
    const tile = Route.tiles.panelView(box, w, h, padding, settings.density);
    const factor = tile.width / w;
    return { paper: scaleDown(tile, factor, w, h), tile };
  }

  function scaleDown(view, factor, width, height) {
    return {
      zoom: view.zoom,
      centre: view.centre,
      width, height,
      metresPerPixel: view.metresPerPixel * factor,
      to(lat, lon) {
        const p = view.to(lat, lon);
        return { x: p.x / factor, y: p.y / factor };
      },
      corners: () => view.corners(),
    };
  }

  /* --- what goes on the overview, and how tall each part is ------------------ */

  const TITLE_SIZE = 21;
  const FACT_ROW = 30;
  const PROFILE_H = 54;
  const NOTE_LEADING = 9.6;

  const STRAIGHT_WARNING =
    "The dashed line is drawn straight between stops. It is not a road and " +
    "not a distance you will travel — check it against a map before setting off.";

  function noteList(plan) {
    const notes = plan.notes.slice();
    if (plan.straightLines) notes.unshift(STRAIGHT_WARNING);
    return notes;
  }

  /* The facts block, worked out once so that the page that draws it and the
     layout that has to leave room for it cannot come to different answers. */
  function factsShape(plan) {
    const first = plan.points[0];
    const last = plan.points[plan.points.length - 1];
    const units = plan.units;

    if (plan.single) {
      return {
        facts: [
          ["Place", plan.name, "bold"],
          ["Coordinates", geo.coord(first.lat, first.lon), "mono"],
        ],
        columns: 2, rows: 1, height: FACT_ROW,
      };
    }

    const facts = [
      ["Distance", units.long(plan.total), "bold"],
      ["Instructions", String(plan.cues.length), "bold"],
    ];
    if (plan.climb) {
      facts.push(["Ascent", units.height(plan.climb.gain), "bold"]);
      facts.push(["Descent", units.height(plan.climb.loss), "bold"]);
    }
    facts.push(["Start", geo.coord(first.lat, first.lon), "mono"]);
    facts.push(["Finish", geo.coord(last.lat, last.lon), "mono"]);

    const columns = plan.climb ? 3 : 2;
    const rows = Math.ceil(facts.length / columns);
    return { facts, columns, rows, height: rows * FACT_ROW };
  }

  /* The map gets whatever the rest of the page does not want. Fixing it at a
     fraction of the paper was simpler and wrong: a route with no elevation and
     nothing to warn about left a hand's width of blank paper under the numbers,
     and the map is the one thing on the sheet that is always worth more space. */
  function overviewMapHeight(plan, page, contentW, settings) {
    const titleBlock = TITLE_SIZE * CAP + 12 + 8 * CAP + 12 + 12;
    const attribution = settings.tiles === "off" ? 0 : 12;
    const profile = plan.climb && plan.climb.samples > 4 ? PROFILE_H + 16 : 0;

    let notes = 0;
    const list = noteList(plan);
    if (list.length) {
      notes = 12;
      for (const note of list) {
        notes += wrap(enc("— " + note), contentW, 7.6, "regular").length * NOTE_LEADING + 2;
      }
    }

    const room = page.height - MARGIN * 2 - titleBlock - attribution -
      factsShape(plan).height - profile - notes - 11;
    return Math.max(190, Math.min(room, page.height * 0.66));
  }

  /* --- layout ---------------------------------------------------------------- */

  /* Every page and every panel rectangle, from the plan alone. Returned to the
     caller so it knows what maps to fetch before anything is drawn. */
  function layout(plan, settings) {
    const page = sheetSize(settings);
    const contentW = page.width - MARGIN * 2;
    const pages = [];
    const panels = [];

    const overviewH = overviewMapHeight(plan, page, contentW, settings);
    const overviewBox = geo.pad(plan.box, 0.06, 120);
    const overviewViews = panelViews(overviewBox, contentW, overviewH, 10, settings);
    const overview = {
      id: "overview",
      box: overviewBox,
      x: MARGIN,
      y: 0,
      w: contentW,
      h: overviewH,
      views: overviewViews,
      points: plan.points,
      cues: plan.cues,
    };
    panels.push(overview);
    pages.push({ kind: "overview", panel: overview });

    for (const section of plan.sections) {
      const cueRoom = Math.min(section.cues.length, 12) * 15 + 30;
      const h = page.height - MARGIN * 2 - 52 - cueRoom;
      const box = geo.pad(section.box, 0.07, 150);
      const panel = {
        id: `section-${section.number}`,
        box,
        x: MARGIN,
        y: 0,
        w: contentW,
        h: Math.max(180, h),
        views: panelViews(box, contentW, Math.max(180, h), 10, settings),
        points: section.points,
        cues: section.cues,
        section,
      };
      panels.push(panel);
      pages.push({ kind: "section", panel, section });
    }

    return { page, contentW, pages, panels, settings };
  }

  /* --- the map panel ---------------------------------------------------------- */

  /* One panel: the map if there is one, the route over it, its markers, a scale
     bar and a north arrow. Drawn inside a clip so nothing can escape the frame,
     which matters because a padded bounding box still lets a wandering track
     out of the corner. */
  function drawPanel(c, panel, plan, images, settings) {
    const { x, y, w, h } = panel;
    const view = panel.views.paper;
    const at = (p) => {
      const s = view.to(p.lat, p.lon);
      return { x: x + s.x, y: y + h - s.y };
    };

    c.save();
    c.rect(x, y, w, h).clip();

    const image = images && images[panel.id];
    if (image) {
      c.image(image.name, x, y, w, h);
    } else {
      c.fill(INK.paper).rect(x, y, w, h).paint("f");
      if (settings.tiles !== "off") {
        c.fill(INK.faint).inBox(enc("map unavailable"), x + w / 2, y + h / 2, 9, "regular");
      }
    }

    const drawn = Route.plan.forDrawing(panel.points, view, 0.5).map(at);

    // A white casing under the line. On a printed map with type under it this
    // is what keeps the route readable where it runs along a labelled street,
    // and it is how every road atlas ever drawn handles the same problem.
    c.join(1).cap(1);
    c.stroke(INK.casing).width(ROUTE_WIDTH + 2.6).polyline(drawn).paint("S");

    if (plan.straightLines) {
      // A line this tool invented between two stops is drawn as a dashed one,
      // because it is not a road and should not be able to pass for one.
      c.dash(5, 3.5);
      c.stroke(INK.line).width(2).polyline(drawn).paint("S");
      c.dash(0, 0);
    } else {
      c.stroke(INK.line).width(ROUTE_WIDTH).polyline(drawn).paint("S");
    }

    drawDirection(c, drawn, plan.straightLines ? 0 : 1);
    drawMarkers(c, panel, plan, at);

    c.restore();

    c.stroke(INK.rule).width(0.8).rect(x, y, w, h).paint("S");
    drawScale(c, x + 10, y + 10, view, plan.units);
    drawNorth(c, x + w - 20, y + h - 20);
  }

  /* Small chevrons along the line, so a sheet says which way round the route
     runs without needing a sentence to do it.

     They are drawn in the casing colour on top of the route, which means they
     eat into it, and the width they eat is the whole design problem: a chevron
     as thick as the line leaves a gap in it, and a gap in a solid line is this
     sheet's own notation for "not a road". So the line is drawn wide enough to
     carry a mark thinner than itself, and the marks are spaced far enough apart
     that no reader could take the sequence for a dash pattern. */
  const ROUTE_WIDTH = 3;
  const CHEVRON_WIDTH = 1;

  function drawDirection(c, pts, enabled) {
    if (!enabled || pts.length < 2) return;
    let run = 0;
    const lengths = [];
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      lengths.push(d);
      run += d;
    }
    const step = Math.max(78, run / 10);
    let target = step;
    let walked = 0;

    c.stroke(INK.casing).width(CHEVRON_WIDTH).cap(1);
    const marks = [];
    for (let i = 1; i < pts.length; i++) {
      const next = walked + lengths[i - 1];
      while (target <= next && lengths[i - 1] > 0.001) {
        const t = (target - walked) / lengths[i - 1];
        const px = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
        const py = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
        const angle = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
        marks.push({ px, py, angle });
        target += step;
      }
      walked = next;
    }

    for (const m of marks) {
      const back = m.angle + Math.PI;
      const s = 2.8;
      const spread = 0.62;
      c.moveTo(m.px + Math.cos(back + spread) * s, m.py + Math.sin(back + spread) * s);
      c.lineTo(m.px, m.py);
      c.lineTo(m.px + Math.cos(back - spread) * s, m.py + Math.sin(back - spread) * s);
    }
    if (marks.length) c.paint("S");
  }

  function drawMarkers(c, panel, plan, at) {
    // A locator has one place, which is neither a start nor a finish. Drawing
    // both on the same coordinate would stack a black disc on a red one.
    if (plan.single) {
      const p = at(plan.points[0]);
      c.fill(INK.casing).circle(p.x, p.y, 9.4).paint("f");
      c.fill(INK.line).circle(p.x, p.y, 8).paint("f");
      c.fill(INK.paper).circle(p.x, p.y, 3).paint("f");
      return;
    }

    const cues = panel.cues || [];
    const turns = cues.filter((cue) => cue.type !== "start" && cue.type !== "finish");
    // Past forty numbered discs a panel is a bag of numbers rather than a map.
    // Beyond that the turns stay as plain dots and the cue sheet carries the
    // numbering on its own.
    const numbered = turns.length <= 40;

    for (const cue of turns) {
      const p = at(cue);
      if (numbered) {
        c.fill(INK.casing).circle(p.x, p.y, 7.4).paint("f");
        c.fill(INK.marker).circle(p.x, p.y, 6.2).paint("f");
        c.fill(INK.paper).inBox(enc(String(cue.number)), p.x, p.y, 6.6, "bold");
      } else {
        c.fill(INK.casing).circle(p.x, p.y, 3.4).paint("f");
        c.fill(INK.marker).circle(p.x, p.y, 2.2).paint("f");
      }
    }

    const start = at(plan.points[0]);
    c.fill(INK.casing).circle(start.x, start.y, 8.4).paint("f");
    c.fill(INK.line).circle(start.x, start.y, 7).paint("f");
    c.fill(INK.paper).circle(start.x, start.y, 2.6).paint("f");

    const last = plan.points[plan.points.length - 1];
    const finish = at(last);
    c.fill(INK.casing).circle(finish.x, finish.y, 8.4).paint("f");
    c.fill(INK.ink).circle(finish.x, finish.y, 7).paint("f");
    // A ring rather than a dot, so the two ends of a loop are still one glance
    // apart when they land on the same spot.
    c.fill(INK.paper).circle(finish.x, finish.y, 3.4).paint("f");
    c.fill(INK.ink).circle(finish.x, finish.y, 1.5).paint("f");
  }

  /* A scale bar in whole units — 1, 2 or 5 times a power of ten — because a bar
     labelled "173 m" is a bar nobody can use to measure anything. */
  function drawScale(c, x, y, view, units) {
    const maxWidth = 130;
    const metres = maxWidth * view.metresPerPixel;
    const inUnits = metres * (units.scale === 1 ? 1 : 3.28084);

    const magnitude = Math.pow(10, Math.floor(Math.log10(inUnits)));
    let nice = magnitude;
    for (const step of [1, 2, 5, 10]) {
      if (step * magnitude <= inUnits) nice = step * magnitude;
    }

    const barUnits = nice;
    const barMetres = units.scale === 1 ? barUnits : barUnits / 3.28084;
    const barWidth = barMetres / view.metresPerPixel;
    if (!Number.isFinite(barWidth) || barWidth < 12) return;

    const label = units.scale === 1
      ? (barUnits >= 1000 ? `${barUnits / 1000} km` : `${barUnits} m`)
      : (barUnits >= 5280 ? `${+(barUnits / 5280).toFixed(1)} mi` : `${barUnits} ft`);

    const h = 4;
    c.fill(INK.paper).rect(x - 3, y - 3, barWidth + widthOf(enc(label), 7, "mono") + 14, h + 12).paint("f");
    c.fill(INK.ink).rect(x, y, barWidth, h).paint("f");
    c.fill(INK.paper).rect(x + barWidth / 2, y + 0.8, barWidth / 2 - 0.8, h - 1.6).paint("f");
    c.stroke(INK.ink).width(0.7).rect(x, y, barWidth, h).paint("S");
    c.fill(INK.ink).text(enc(label), x + barWidth + 5, y, 7, "mono");
  }

  function drawNorth(c, cx, cy) {
    c.fill(INK.paper).circle(cx, cy, 11).paint("f");
    c.stroke(INK.rule).width(0.7).circle(cx, cy, 11).paint("S");
    c.fill(INK.ink);
    c.moveTo(cx, cy + 8).lineTo(cx + 3.6, cy - 3).lineTo(cx, cy - 0.6).lineTo(cx - 3.6, cy - 3).close();
    c.paint("f");
    c.fill(INK.ink).inBox(enc("N"), cx, cy - 6.6, 5.5, "bold");
  }

  /* --- turn glyphs -------------------------------------------------------------- */

  /* The arrow beside each instruction, drawn at the angle the route actually
     turns through rather than snapped to one of four pictures. A reader takes
     the shape in before the words, and a 30° bend and a 90° corner should not
     look the same on the page when they do not look the same on the ground. */
  function drawTurn(c, cx, cy, r, cue) {
    // The weight follows the size. Fixed at 1.5pt the arrow was a hairline in
    // the specimen at r=22 and a blob at r=6, and the head — the part that
    // carries the meaning — disappeared at the size the table actually uses.
    c.stroke(INK.ink).width(Math.min(1.7, Math.max(0.95, r * 0.17))).cap(1).join(1);

    if (cue.type === "start") {
      c.fill(INK.line).circle(cx, cy, r * 0.62).paint("f");
      c.fill(INK.paper).circle(cx, cy, r * 0.24).paint("f");
      return;
    }
    if (cue.type === "finish") {
      c.fill(INK.ink).circle(cx, cy, r * 0.62).paint("f");
      c.fill(INK.paper).circle(cx, cy, r * 0.32).paint("f");
      c.fill(INK.ink).circle(cx, cy, r * 0.14).paint("f");
      return;
    }
    if (cue.type === "stop" || cue.type === "place") {
      c.fill(INK.ink);
      c.moveTo(cx, cy + r * 0.6).lineTo(cx + r * 0.6, cy).lineTo(cx, cy - r * 0.6).lineTo(cx - r * 0.6, cy).close();
      c.paint("f");
      return;
    }

    const angle = Number.isFinite(cue.angle) ? cue.angle : 0;

    // A U-turn drawn as a rotated arrow would fold back over its own shaft, so
    // it gets the one shape that has to be special-cased: up one side, round,
    // and back down the other.
    if (Math.abs(angle) > 150) {
      const side = angle < 0 ? -1 : 1;
      const dx = r * 0.42 * side;
      c.moveTo(cx - dx, cy - r * 0.8);
      c.lineTo(cx - dx, cy + r * 0.1);
      c.curveTo(cx - dx, cy + r * 0.75, cx + dx, cy + r * 0.75, cx + dx, cy + r * 0.1);
      c.lineTo(cx + dx, cy - r * 0.35);
      c.paint("S");
      arrowhead(c, cx + dx, cy - r * 0.8, Math.PI / 2 * 3, r * 0.5);
      return;
    }

    /* The arrow comes up from the bottom of the box, bends once, and leaves on
       the bearing the route leaves on. The bend is a real corner rather than a
       curve: this is a cue sheet, and the reader is being told the shape of a
       junction, not shown a picture of one. Straight up is no turn, so a bend
       of five degrees draws as five degrees and a right angle draws as a right
       angle — the glyph carries the measurement, which is the reason for
       drawing it at the angle rather than picking one of four pictures. */
    const θ = angle * Math.PI / 180;
    const knee = { x: cx, y: cy - r * 0.2 };
    const tip = {
      x: knee.x + Math.sin(θ) * r * 0.85,
      y: knee.y + Math.cos(θ) * r * 0.85,
    };

    c.moveTo(cx, cy - r * 0.9);
    c.lineTo(knee.x, knee.y);
    c.lineTo(tip.x, tip.y);
    c.paint("S");
    arrowhead(c, tip.x, tip.y, Math.atan2(tip.y - knee.y, tip.x - knee.x), r * 0.5);
  }

  function arrowhead(c, x, y, angle, size) {
    const back = angle + Math.PI;
    const spread = 0.5;
    c.fill(INK.ink);
    c.moveTo(x, y);
    c.lineTo(x + Math.cos(back + spread) * size, y + Math.sin(back + spread) * size);
    c.lineTo(x + Math.cos(back) * size * 0.55, y + Math.sin(back) * size * 0.55);
    c.lineTo(x + Math.cos(back - spread) * size, y + Math.sin(back - spread) * size);
    c.close().paint("f");
  }

  /* --- text setting ------------------------------------------------------------- */

  function wrap(encoded, limit, size, font) {
    const words = encoded.split(" ").filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (widthOf(candidate, size, font) <= limit) { line = candidate; continue; }
      if (line) lines.push(line);
      if (widthOf(word, size, font) <= limit) { line = word; continue; }
      // A single unbreakable run wider than its column — a road number with
      // slashes in it, a pasted URL — is cut by character, because there is
      // nowhere else to cut it.
      let piece = "";
      for (const ch of word) {
        if (piece && widthOf(piece + ch, size, font) > limit) { lines.push(piece); piece = ch; }
        else piece += ch;
      }
      line = piece;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  function clip(encoded, limit, size, font) {
    if (widthOf(encoded, size, font) <= limit) return encoded;
    let out = encoded;
    while (out && widthOf(out + "\x85", size, font) > limit) out = out.slice(0, -1);
    return out + "\x85";
  }

  /* --- pages ---------------------------------------------------------------------- */

  const CREDIT = "workshop.fubl.org/route-sheet";

  function header(c, page, title, right, y) {
    c.fill(INK.ink).text(clip(enc(title), page.width - MARGIN * 2 - 130, 10, "bold"), MARGIN, y, 10, "bold");
    if (right) c.fill(INK.soft).right(enc(right), page.width - MARGIN, y, 8, "mono");
    c.stroke(INK.rule).width(0.7).moveTo(MARGIN, y - 7).lineTo(page.width - MARGIN, y - 7).paint("S");
    return y - 20;
  }

  function footer(c, page, left, right) {
    const y = MARGIN - 13;
    c.fill(INK.soft).text(enc(left), MARGIN, y, 7, "regular");
    c.right(enc(right), page.width - MARGIN, y, 7, "regular");
  }

  function overviewPage(plan, sheet, images, settings) {
    const c = new Content();
    const { page, contentW } = sheet;
    const panel = sheet.panels[0];
    const units = plan.units;

    let y = page.height - MARGIN;

    const title = clip(enc(plan.name || "Route"), contentW, TITLE_SIZE, "bold");
    c.fill(INK.ink).text(title, MARGIN, y - TITLE_SIZE * CAP, TITLE_SIZE, "bold");
    y -= TITLE_SIZE * CAP + 12;

    const strap = plan.single
      ? `One place · ${geo.coord(plan.points[0].lat, plan.points[0].lon)} · ${plan.source}`
      : [
          units.long(plan.total),
          plan.climb ? `${units.height(plan.climb.gain)} up` : null,
          plan.climb ? `${units.height(plan.climb.loss)} down` : null,
          `${plan.cues.length} instructions`,
        ].filter(Boolean).join("   ·   ");
    c.fill(INK.soft).text(enc(strap), MARGIN, y - 8 * CAP, 8.5, "regular");
    y -= 8 * CAP + 12;

    c.stroke(INK.ink).width(1.2).moveTo(MARGIN, y).lineTo(page.width - MARGIN, y).paint("S");
    y -= 12;

    panel.y = y - panel.h;
    drawPanel(c, panel, plan, images, settings);
    y = panel.y - 11;

    if (settings.tiles !== "off" && images && images[panel.id]) {
      c.fill(INK.soft).text(enc(Route.tiles.ATTRIBUTION), MARGIN, y, 6.5, "regular");
      y -= 12;
    }

    y = factsBlock(c, plan, MARGIN, y, contentW);

    if (plan.climb && plan.climb.samples > 4) {
      y -= 6;
      y = profile(c, plan, MARGIN, y - PROFILE_H, contentW, PROFILE_H) - 10;
    }

    // Whatever the readers had to say about this route — a link that carried
    // stops rather than a path, a waypoint file with no line in it. It belongs
    // on the sheet and not only on the screen, because the sheet is what gets
    // carried and the screen is what gets closed.
    const notes = noteList(plan);
    if (notes.length && y > MARGIN + 30) {
      c.stroke(INK.rule).width(0.7).dash(2, 2).moveTo(MARGIN, y).lineTo(page.width - MARGIN, y).paint("S");
      c.dash(0, 0);
      y -= 12;
      for (const note of notes) {
        if (y < MARGIN + 10) break;
        for (const line of wrap(enc("— " + note), contentW, 7.6, "regular")) {
          if (y < MARGIN + 4) break;
          c.fill(INK.soft).text(line, MARGIN, y, 7.6, "regular");
          y -= NOTE_LEADING;
        }
        y -= 2;
      }
    }

    footer(c, page, `${plan.source} · ${sheet.stamp}`, CREDIT);
    return c;
  }

  /* The numbers a reader wants before setting off, in a row of boxes. Start and
     finish coordinates are set in Courier and at full precision on purpose:
     they are the one thing on this sheet that can be typed back into a phone
     when the phone comes back. */
  function factsBlock(c, plan, x, top, width) {
    const { facts, columns, rows, height } = factsShape(plan);
    const cellW = width / columns;
    const cellH = FACT_ROW;

    c.stroke(INK.faint).width(0.7);
    for (let i = 1; i < columns; i++) {
      c.moveTo(x + i * cellW, top - height).lineTo(x + i * cellW, top);
    }
    for (let i = 1; i < rows; i++) {
      c.moveTo(x, top - i * cellH).lineTo(x + width, top - i * cellH);
    }
    c.paint("S");
    c.stroke(INK.rule).width(0.7).rect(x, top - height, width, height).paint("S");

    facts.forEach((fact, i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const cx = x + col * cellW + 9;
      const cy = top - row * cellH;
      c.fill(INK.mid).text(enc(fact[0].toUpperCase()), cx, cy - 11, 6, "regular");
      const value = clip(enc(fact[1]), cellW - 18, 10, fact[2]);
      c.fill(INK.ink).text(value, cx, cy - 23, fact[2] === "mono" ? 8.5 : 10, fact[2]);
    });

    return top - height;
  }

  /* The height of the route against the distance along it. Worth a strip of the
     page for the same reason the map is: it answers a question the numbers
     cannot, which is whether the climbing is one hill or forty. */
  function profile(c, plan, x, y, w, h) {
    const points = plan.points;
    const dist = plan.dist;
    const climb = plan.climb;
    const span = Math.max(1, climb.max - climb.min);
    const units = plan.units;

    c.fill(grey(0.97)).rect(x, y, w, h).paint("f");

    const step = Math.max(1, Math.floor(points.length / Math.max(2, w * 2)));
    const shape = [];
    for (let i = 0; i < points.length; i += step) {
      if (!Number.isFinite(points[i].ele)) continue;
      shape.push({
        x: x + (dist[i] / plan.total) * w,
        y: y + 8 + ((points[i].ele - climb.min) / span) * (h - 16),
      });
    }
    if (shape.length < 2) return y;

    c.fill(grey(0.84));
    c.moveTo(shape[0].x, y);
    for (const p of shape) c.lineTo(p.x, p.y);
    c.lineTo(shape[shape.length - 1].x, y);
    c.close().paint("f");

    c.stroke(INK.line).width(1).join(1).polyline(shape).paint("S");
    c.stroke(INK.rule).width(0.7).rect(x, y, w, h).paint("S");

    c.fill(INK.soft);
    c.text(enc(units.height(climb.max)), x + 5, y + h - 9, 6.5, "mono");
    c.text(enc(units.height(climb.min)), x + 5, y + 5, 6.5, "mono");
    c.right(enc(`profile · ${units.long(plan.total)}`), x + w - 5, y + h - 9, 6.5, "regular");
    return y;
  }

  function sectionPage(plan, sheet, page, images, settings, index) {
    const c = new Content();
    const { panel, section } = page;
    const paper = sheet.page;
    const units = plan.units;

    let y = paper.height - MARGIN - 10;
    y = header(
      c, paper,
      `${plan.name || "Route"} — part ${section.number} of ${plan.sections.length}`,
      `${units.long(section.fromDistance)} – ${units.long(section.toDistance)}`,
      y
    );

    panel.y = y - panel.h;
    drawPanel(c, panel, plan, images, settings);
    y = panel.y - 10;

    if (settings.tiles !== "off" && images && images[panel.id]) {
      c.fill(INK.soft).text(enc(Route.tiles.ATTRIBUTION), MARGIN, y, 6.5, "regular");
      y -= 12;
    }

    // The instructions for this stretch, repeated under its own map, so a page
    // torn out of the sheet is still usable on its own.
    for (const cue of section.cues) {
      if (y < MARGIN + 8) break;
      drawTurn(c, MARGIN + 9, y - 5, 8, cue);
      c.fill(INK.mid).text(enc(String(cue.number)), MARGIN + 19, y - 7, 7, "mono");
      c.fill(INK.ink).text(
        clip(enc(cue.text), sheet.contentW - 150, 8.5, "regular"),
        MARGIN + 38, y - 7, 8.5, "regular"
      );
      c.fill(INK.soft).right(enc(units.long(cue.at)), paper.width - MARGIN, y - 7, 8, "mono");
      y -= 15;
    }

    footer(c, paper, `Part ${section.number} of ${plan.sections.length}`, CREDIT);
    return c;
  }

  /* --- the cue sheet --------------------------------------------------------------- */

  /* Six columns, right to left: the three on the right have widths their
     contents cannot exceed, and the instruction takes what is left. The gutters
     are explicit because two of the columns are right-aligned and the one after
     them is not — without a gutter of its own between them, a distance and a
     latitude meet with no space at all and read as one number. */
  const GUTTER = 10;

  const COLUMNS = (width) => {
    const number = 20;
    const glyph = 26;
    const at = 58;
    // Widest a coordinate pair gets: two signed five-decimal numbers and a
    // comma, in Courier at 7pt.
    const coord = Math.ceil(widthOf("-000.00000, -000.00000", 7, "mono")) + 2;
    const next = 54;
    return {
      number: { x: 0, w: number },
      glyph: { x: number, w: glyph },
      text: {
        x: number + glyph + 6,
        w: Math.max(90, width - number - glyph - at - next - coord - GUTTER * 3),
      },
      at: { x: width - coord - next - at - GUTTER * 2, w: at },
      next: { x: width - coord - next - GUTTER, w: next },
      coord: { x: width - coord, w: coord },
    };
  };

  function cuePages(plan, sheet, settings) {
    const paper = sheet.page;
    const width = sheet.contentW;
    const cols = COLUMNS(width);
    const units = plan.units;
    const pages = [];

    const rows = plan.cues.map((cue) => {
      const lines = wrap(enc(cue.text), cols.text.w, 9, "bold");
      const detail = cue.detail ? wrap(enc(cue.detail), cols.text.w, 7.2, "regular") : [];
      const height = Math.max(20, lines.length * 11 + detail.length * 8.6 + 9);
      return { cue, lines, detail, height };
    });

    let index = 0;
    while (index < rows.length) {
      const c = new Content();
      let y = paper.height - MARGIN - 10;
      y = header(
        c, paper,
        pages.length === 0 ? `${plan.name || "Route"} — instructions` : `${plan.name || "Route"} — instructions, continued`,
        settings.units === "imperial" ? "distances in miles" : "distances in km",
        y
      );

      // The column heads, repeated on every page of the table: a cue sheet is
      // read a page at a time on a handlebar, not front to back at a desk.
      c.fill(INK.mid);
      c.text(enc("AT"), MARGIN + cols.at.x + cols.at.w - widthOf(enc("AT"), 6, "regular"), y, 6, "regular");
      c.text(enc("THEN"), MARGIN + cols.next.x + cols.next.w - widthOf(enc("THEN"), 6, "regular"), y, 6, "regular");
      c.text(enc("COORDINATES"), MARGIN + cols.coord.x, y, 6, "regular");
      y -= 9;
      c.stroke(INK.faint).width(0.7).moveTo(MARGIN, y).lineTo(paper.width - MARGIN, y).paint("S");
      y -= 6;

      const floor = MARGIN + 6;
      while (index < rows.length) {
        const row = rows[index];
        if (y - row.height < floor && y < paper.height - MARGIN - 60) break;

        const cue = row.cue;
        const top = y;

        if (cue.type === "start" || cue.type === "finish") {
          c.fill(grey(0.94)).rect(MARGIN - 4, y - row.height + 4, width + 8, row.height).paint("f");
        }

        c.fill(INK.mid).text(enc(String(cue.number)), MARGIN + cols.number.x, y - 11, 8, "mono");
        drawTurn(c, MARGIN + cols.glyph.x + cols.glyph.w / 2, y - 11, 10, cue);

        let ty = y - 11;
        for (const line of row.lines) {
          c.fill(INK.ink).text(line, MARGIN + cols.text.x, ty, 9, "bold");
          ty -= 11;
        }
        for (const line of row.detail) {
          c.fill(INK.soft).text(line, MARGIN + cols.text.x, ty, 7.2, "regular");
          ty -= 8.6;
        }

        c.fill(INK.ink).right(enc(units.short(cue.at)), MARGIN + cols.at.x + cols.at.w, y - 11, 8.5, "mono");
        if (cue.toNext > 0) {
          c.fill(INK.soft).right(enc(units.short(cue.toNext)), MARGIN + cols.next.x + cols.next.w, y - 11, 8.5, "mono");
        }
        c.fill(INK.soft).text(enc(geo.coord(cue.lat, cue.lon)), MARGIN + cols.coord.x, y - 11, 7, "mono");

        y -= row.height;
        c.stroke(INK.faint).width(0.6).moveTo(MARGIN, y + 3).lineTo(paper.width - MARGIN, y + 3).paint("S");
        index++;
        if (top === y) break;
      }

      pages.push(c);
    }

    return pages;
  }

  /* --- assembly -------------------------------------------------------------------- */

  class Sink {
    constructor() { this.parts = []; this.length = 0; }
    push(s) {
      if (s instanceof Uint8Array) { this.parts.push(s); this.length += s.length; return; }
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
      this.parts.push(b);
      this.length += b.length;
    }
    join() {
      const out = new Uint8Array(this.length);
      let at = 0;
      for (const p of this.parts) { out.set(p, at); at += p.length; }
      return out;
    }
  }

  function pdfDate(date) {
    const p = (n) => String(Math.abs(n)).padStart(2, "0");
    const tz = -date.getTimezoneOffset();
    return "D:" + date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) +
      p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds()) +
      (tz >= 0 ? "+" : "-") + p((tz / 60) | 0) + "'" + p(tz % 60) + "'";
  }

  /* Plain objects and a classic cross-reference table. Nothing but the map
     panels is compressed, which costs a few kilobytes and keeps the file
     readable in a text editor — the same bargain the other two PDF writers on
     this site make, and the reason a reader can check what was written. */
  function assemble(pages, paper, images, info) {
    const objects = [];
    let next = 1;
    const reserve = () => next++;
    const put = (num, body) => { objects[num] = body; };

    const CATALOG = reserve();
    const PAGES = reserve();
    const F1 = reserve();
    const F2 = reserve();
    const F3 = reserve();
    const INFO = reserve();

    put(F1, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    put(F2, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    put(F3, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
    put(INFO, info);

    const imageObjects = {};
    for (const name of Object.keys(images || {})) {
      const image = images[name];
      const num = reserve();
      imageObjects[name] = num;
      put(num, {
        dict:
          `<< /Type /XObject /Subtype /Image /Name /${image.name} ` +
          `/Width ${image.width} /Height ${image.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
          `/Filter /DCTDecode /Length ${image.bytes.length} >>`,
        bytes: image.bytes,
      });
    }

    const pageRefs = [];
    for (const content of pages) {
      const pageNum = reserve();
      const streamNum = reserve();
      const stream = content.toString();

      const used = Array.from(content.images)
        .map((n) => {
          const owner = Object.values(images || {}).find((im) => im.name === n);
          const num = owner ? imageObjects[owner.key] : null;
          return num ? `/${n} ${num} 0 R` : null;
        })
        .filter(Boolean);

      pageRefs.push(`${pageNum} 0 R`);
      put(pageNum,
        `<< /Type /Page /Parent ${PAGES} 0 R ` +
        `/MediaBox [0 0 ${fixed(paper.width)} ${fixed(paper.height)}] ` +
        `/Resources << /Font << /F1 ${F1} 0 R /F2 ${F2} 0 R /F3 ${F3} 0 R >>` +
        (used.length ? ` /XObject << ${used.join(" ")} >>` : "") +
        ` >> /Contents ${streamNum} 0 R >>`);
      put(streamNum, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    }

    put(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);
    put(PAGES, `<< /Type /Pages /Count ${pageRefs.length} /Kids [${pageRefs.join(" ")}] >>`);

    const sink = new Sink();
    sink.push("%PDF-1.7\n");
    sink.push("%\xe2\xe3\xcf\xd3\n");

    const offsets = [];
    for (let num = 1; num < next; num++) {
      offsets[num] = sink.length;
      const body = objects[num];
      if (body && body.bytes) {
        sink.push(`${num} 0 obj\n${body.dict}\nstream\n`);
        sink.push(body.bytes);
        sink.push("\nendstream\nendobj\n");
      } else {
        sink.push(`${num} 0 obj\n${body || "<< >>"}\nendobj\n`);
      }
    }

    const xref = sink.length;
    sink.push(`xref\n0 ${next}\n0000000000 65535 f \n`);
    for (let num = 1; num < next; num++) {
      sink.push(String(offsets[num]).padStart(10, "0") + " 00000 n \n");
    }
    sink.push(
      `trailer\n<< /Size ${next} /Root ${CATALOG} 0 R /Info ${INFO} 0 R >>\n` +
      `startxref\n${xref}\n%%EOF\n`
    );
    return sink.join();
  }

  /* --- the entry point ------------------------------------------------------------- */

  /* `panels` is what the caller fetched, keyed by panel id:
     { bytes, width, height }. Absent, every panel draws as an empty frame and
     the file is written without ever having opened a socket. */
  function print(plan, settings, sheet, panels) {
    const now = settings.now || new Date();
    sheet.stamp = now.toISOString().slice(0, 10);

    const images = {};
    let n = 0;
    for (const id of Object.keys(panels || {})) {
      const panel = panels[id];
      if (!panel || !panel.bytes) continue;
      n++;
      images[id] = {
        key: id, name: `Im${n}`,
        bytes: panel.bytes, width: panel.width, height: panel.height,
      };
    }

    const contents = [];
    for (const page of sheet.pages) {
      if (page.kind === "overview") contents.push(overviewPage(plan, sheet, images, settings));
      else contents.push(sectionPage(plan, sheet, page, images, settings));
    }
    contents.push(...cuePages(plan, sheet, settings));

    const subject = [
      plan.units.long(plan.total),
      `${plan.cues.length} instructions`,
      plan.source,
    ].join(" · ");

    const info =
      "<< /Title " + literal(enc(plan.name || "Route sheet")) +
      " /Subject " + literal(enc(subject)) +
      " /Creator " + literal(enc("Felix' Workshop — Route Sheet")) +
      " /Producer " + literal(enc(CREDIT)) +
      " /CreationDate " + literal(pdfDate(now)) +
      " /ModDate " + literal(pdfDate(now)) + " >>";

    return assemble(contents, sheet.page, images, info);
  }

  Route.pdf = { layout, print, PAPER, sheetSize, panelViews, drawTurn, Content, INK, enc, lost, widthOf, MARGIN };

})(globalThis.Route || (globalThis.Route = {}));
