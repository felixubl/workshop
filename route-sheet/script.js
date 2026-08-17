/* The page. Reads a route, keeps a plan in step with the controls, draws the
   panels that will print, and writes the file.

   The preview is not a picture of the sheet: it is the sheet's own panel,
   at the sheet's own framing, with the same route drawn over it by the same
   geometry. When the map is switched on the squares are fetched once and used
   twice — on screen and in the PDF — so what is previewed cannot differ from
   what prints, and turning the preview does not cost a second download. */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const ui = {
    intake: $("intake"), dropzone: $("dropzone"), pick: $("pick"), file: $("file"),
    pasted: $("pasted"), read: $("read"), example: $("example"), clear: $("clear"),
    hint: $("hint"), empty: $("empty"), workbench: $("workbench"),
    pathGroup: $("pathGroup"), pathPick: $("pathPick"),
    grain: $("grain"), detail: $("detail"), map: $("basemap"), units: $("units"),
    paper: $("paper"), orientation: $("orientation"),
    custodyNote: $("custodyNote"), custodyText: $("custodyText"),
    canvas: $("map"), mapBusy: $("mapBusy"), mapCredit: $("mapCredit"), mapNote: $("mapNote"),
    panelAt: $("panelAt"), panelCap: $("panelCap"), panelMeta: $("panelMeta"),
    prevPanel: $("prevPanel"), nextPanel: $("nextPanel"),
    routeCap: $("routeCap"), routeMeta: $("routeMeta"), facts: $("facts"), notes: $("notes"),
    cueBody: $("cueBody"), cueNote: $("cueNote"), copyCues: $("copyCues"), download: $("download"),
  };

  const state = {
    route: null,     // what a reader handed over
    plan: null,      // that route plus the settings, resolved
    sheet: null,     // page and panel rectangles
    panels: {},      // fetched map squares, keyed by panel id
    at: 0,           // which panel the preview is showing
    job: 0,          // rising token: an older fetch that lands late is dropped
    label: "",       // the file name it arrived under, if it arrived as a file
    filename: "route",
  };

  /* --- messages ------------------------------------------------------------ */

  let hintTimer = 0;
  function say(message, tone) {
    clearTimeout(hintTimer);
    ui.hint.textContent = message;
    ui.hint.hidden = !message;
    ui.hint.dataset.tone = tone || "";
    if (message && tone !== "bad") hintTimer = setTimeout(() => { ui.hint.hidden = true; }, 6000);
  }

  // A file name a filesystem will take unchanged, from a route name that came
  // from anywhere. Accents are decomposed and dropped rather than replaced by
  // hyphens, so "Großglockner" saves as "grossglockner" and not "gro-glockner".
  function slug(text) {
    const out = String(text)
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/ß/g, "ss")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      .slice(0, 48);
    return out || "route";
  }

  /* --- settings ------------------------------------------------------------ */

  function settings() {
    return {
      pathIndex: Number(ui.pathPick.value) || 0,
      grain: ui.grain.value,
      detail: Math.max(0, Math.min(24, Number(ui.detail.value) || 0)),
      tiles: ui.map.value,
      units: ui.units.value,
      paper: ui.paper.value,
      orientation: ui.orientation.value,
      density: 2.5,
    };
  }

  /* --- reading ------------------------------------------------------------- */

  async function load(reader, label) {
    // Reading is synchronous once it starts — XML parsing and turn-finding both
    // are — and a track off a watch can be a hundred thousand points, which is
    // a couple of seconds of a frozen tab. Saying so first, and letting the
    // browser paint that before the work begins, is the difference between a
    // slow tool and a broken-looking one.
    say("Reading the route…");
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

    try {
      const route = await reader();
      state.route = route;
      state.label = label;

      ui.pathPick.innerHTML = "";
      route.paths.forEach((path, i) => {
        const option = document.createElement("option");
        option.value = String(i);
        const km = Route.geo.cumulative(path.points);
        option.textContent =
          `${path.name || `${path.kind} ${i + 1}`} — ${Route.geo.UNITS.metric.long(km[km.length - 1])}`;
        ui.pathPick.append(option);
      });
      ui.pathGroup.hidden = route.paths.length < 2;
      ui.empty.hidden = true;
      ui.workbench.hidden = false;
      ui.clear.hidden = false;
      state.at = 0;
      Route.tiles.reset();
      say("");
      await rebuild();
      ui.workbench.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      say(err.message || String(err), "bad");
    }
  }

  /* --- the plan ------------------------------------------------------------ */

  let pending = 0;
  function schedule() {
    clearTimeout(pending);
    pending = setTimeout(rebuild, 120);
  }

  async function rebuild() {
    if (!state.route) return;
    const opts = settings();

    try {
      state.plan = Route.plan.build(state.route, opts);
    } catch (err) {
      say(err.message, "bad");
      return;
    }
    state.sheet = Route.pdf.layout(state.plan, opts);
    state.at = Math.min(state.at, state.sheet.panels.length - 1);
    // Named after the file it came from where there was one, and after whatever
    // the plan settled on otherwise — a link carries no filename, but by this
    // point the plan has resolved a name for the place or the route.
    state.filename = slug(state.label || state.plan.name || "route");

    // Controls that would have nothing to act on are put away rather than left
    // to do nothing: a path built from stops has no corners to grade, and one
    // place has neither corners nor a length to cut into pages.
    ui.grain.closest(".group").hidden = state.plan.straightLines || state.plan.single;
    ui.detail.closest(".group").hidden = state.plan.single;

    custody(opts);
    facts();
    cues();
    drawPreview();

    if (opts.tiles !== "off") await fetchPanels(opts);
  }

  function custody(opts) {
    const off = opts.tiles === "off";
    ui.custodyNote.dataset.live = off ? "" : "on";
    ui.custodyText.innerHTML = off
      ? "Nothing has left this page. With the map set to <em>None</em> the tool " +
        "opens no socket: the file is read here, the turns are worked out here, " +
        "and the PDF is written here byte by byte."
      : "The map is on, so this page asks <code>tile.openstreetmap.org</code> for " +
        "the squares your route crosses — which carries your IP address and, in " +
        "the squares themselves, where you are going. Nothing is uploaded and " +
        "nothing is kept. Set the map to <em>None</em> to close the socket.";
  }

  /* --- fetching the map ---------------------------------------------------- */

  async function fetchPanels(opts) {
    const job = ++state.job;
    const wanted = state.sheet.panels.filter((p) => !state.panels[key(p, opts)]);
    if (!wanted.length) { drawPreview(); return; }

    const total = wanted.reduce((n, p) => n + Route.tiles.tileCount(p.views.tile), 0);
    ui.mapBusy.hidden = false;
    ui.mapBusy.textContent = `fetching ${total} map square${total === 1 ? "" : "s"}…`;
    ui.download.disabled = true;

    let done = 0;
    try {
      for (const panel of wanted) {
        if (job !== state.job) return;
        const result = await Route.tiles.drawPanel(panel.views.tile, {
          treatment: opts.tiles,
          onProgress: () => {
            done++;
            ui.mapBusy.textContent = `fetching map squares… ${done} of ${total}`;
          },
        });
        if (job !== state.job) return;
        state.panels[key(panel, opts)] = result;
        if (state.sheet.panels[state.at] === panel) drawPreview();
      }
      drawPreview();
      say("");
    } catch (err) {
      say(
        `The map could not be fetched — ${err.message}. The sheet still prints; ` +
        `it prints without a map under the route.`,
        "bad"
      );
    } finally {
      if (job === state.job) {
        ui.mapBusy.hidden = true;
        ui.download.disabled = false;
      }
    }
  }

  // A panel's squares depend on where it is, how big it is, and how it is
  // treated — so all three are in the key, and changing the paper or the
  // treatment does not silently reuse the wrong picture.
  const key = (panel, opts) =>
    `${panel.id}|${panel.views.tile ? panel.views.tile.zoom : "-"}|` +
    `${Math.round(panel.w)}x${Math.round(panel.h)}|${opts.tiles}|` +
    `${panel.box.north.toFixed(4)},${panel.box.west.toFixed(4)}`;

  /* --- the preview canvas --------------------------------------------------- */

  /* The same panel the PDF will hold, drawn with the canvas API instead of PDF
     operators. The two renderers share the projection and the plan, which is
     what keeps them honest; they do not share their drawing calls, because a
     shim over both would be longer than either. */
  function drawPreview() {
    const sheet = state.sheet;
    const plan = state.plan;
    if (!sheet || !plan) return;

    const panel = sheet.panels[state.at];
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const canvas = ui.canvas;
    const cssWidth = canvas.parentElement.clientWidth || 900;
    const scale = cssWidth / panel.w;
    const cssHeight = panel.h * scale;

    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);

    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0);
    ctx.clearRect(0, 0, panel.w, panel.h);

    const style = getComputedStyle(document.documentElement);
    const paper = style.getPropertyValue("--pp-paper").trim() || "#fbfbf9";
    const ink = style.getPropertyValue("--pp-ink").trim() || "#171716";
    const line = style.getPropertyValue("--pp-plate-2").trim() || "#ff2e6e";

    const fetched = state.panels[key(panel, settings())];
    ctx.fillStyle = fetched ? "#ffffff" : paper;
    ctx.fillRect(0, 0, panel.w, panel.h);
    if (fetched) ctx.drawImage(fetched.canvas, 0, 0, panel.w, panel.h);

    const view = panel.views.paper;
    const at = (p) => {
      const s = view.to(p.lat, p.lon);
      return { x: s.x, y: s.y };
    };

    const drawn = Route.plan.forDrawing(panel.points, view, 0.5).map(at);
    ctx.lineJoin = ctx.lineCap = "round";

    ctx.beginPath();
    ctx.moveTo(drawn[0].x, drawn[0].y);
    for (let i = 1; i < drawn.length; i++) ctx.lineTo(drawn[i].x, drawn[i].y);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = ROUTE_WIDTH + 2.6;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.strokeStyle = line;
    ctx.lineWidth = plan.straightLines ? 2 : ROUTE_WIDTH;
    if (plan.straightLines) ctx.setLineDash([5, 3.5]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!plan.straightLines) chevrons(ctx, drawn);

    const turns = (panel.cues || []).filter((c) => c.type !== "start" && c.type !== "finish");
    const numbered = turns.length <= 40;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const cue of turns) {
      const p = at(cue);
      ctx.beginPath();
      ctx.arc(p.x, p.y, numbered ? 7.4 : 3.4, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, numbered ? 6.2 : 2.2, 0, Math.PI * 2);
      ctx.fillStyle = ink;
      ctx.fill();
      if (numbered) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 6.6px system-ui, sans-serif";
        ctx.fillText(String(cue.number), p.x, p.y + 0.3);
      }
    }

    const dot = (p, ring, fill, inner) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, ring, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff"; ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, ring - 1.4, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, inner, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff"; ctx.fill();
    };

    if (plan.single) {
      dot(at(plan.points[0]), 9.4, line, 3);
    } else {
      dot(at(plan.points[0]), 8.4, line, 2.6);
      const last = plan.points[plan.points.length - 1];
      dot(at(last), 8.4, ink, 3.4);
      const f = at(last);
      ctx.beginPath(); ctx.arc(f.x, f.y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = ink; ctx.fill();
    }

    scaleBar(ctx, panel, view, plan.units, ink);

    ctx.strokeStyle = style.getPropertyValue("--pp-line").trim() || "rgba(0,0,0,.27)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, panel.w - 1, panel.h - 1);

    pager(panel, fetched);
  }

  /* The same marks the sheet carries, at the same weights and the same spacing.
     Kept in step with route-pdf.js by hand rather than by a shared shim: the
     two drawing APIs are different enough that a wrapper over both would be
     longer than either, and these four numbers are the whole of the overlap. */
  const ROUTE_WIDTH = 3;
  const CHEVRON_WIDTH = 1;
  const CHEVRON_SIZE = 2.8;
  const CHEVRON_SPREAD = 0.62;

  function chevrons(ctx, pts) {
    if (pts.length < 2) return;
    const lengths = [];
    let run = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      lengths.push(d);
      run += d;
    }
    const step = Math.max(78, run / 10);
    let target = step;
    let walked = 0;

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = CHEVRON_WIDTH;
    ctx.beginPath();
    for (let i = 1; i < pts.length; i++) {
      const next = walked + lengths[i - 1];
      while (target <= next && lengths[i - 1] > 0.001) {
        const t = (target - walked) / lengths[i - 1];
        const px = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
        const py = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
        const back = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x) + Math.PI;
        ctx.moveTo(px + Math.cos(back + CHEVRON_SPREAD) * CHEVRON_SIZE, py + Math.sin(back + CHEVRON_SPREAD) * CHEVRON_SIZE);
        ctx.lineTo(px, py);
        ctx.lineTo(px + Math.cos(back - CHEVRON_SPREAD) * CHEVRON_SIZE, py + Math.sin(back - CHEVRON_SPREAD) * CHEVRON_SIZE);
        target += step;
      }
      walked = next;
    }
    ctx.stroke();
  }

  function scaleBar(ctx, panel, view, units, ink) {
    const metres = 130 * view.metresPerPixel;
    const inUnits = metres * (units.scale === 1 ? 1 : 3.28084);
    const magnitude = Math.pow(10, Math.floor(Math.log10(inUnits)));
    let nice = magnitude;
    for (const step of [1, 2, 5, 10]) if (step * magnitude <= inUnits) nice = step * magnitude;

    const barMetres = units.scale === 1 ? nice : nice / 3.28084;
    const width = barMetres / view.metresPerPixel;
    if (!Number.isFinite(width) || width < 12) return;

    const label = units.scale === 1
      ? (nice >= 1000 ? `${nice / 1000} km` : `${nice} m`)
      : (nice >= 5280 ? `${+(nice / 5280).toFixed(1)} mi` : `${nice} ft`);

    const y = panel.h - 14;
    ctx.fillStyle = "rgba(255,255,255,.86)";
    ctx.fillRect(7, y - 4, width + 52, 15);
    ctx.fillStyle = ink;
    ctx.fillRect(10, y, width, 4);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(10 + width / 2, y + 0.8, width / 2 - 0.8, 2.4);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 0.7;
    ctx.strokeRect(10, y, width, 4);
    ctx.fillStyle = ink;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = "7px ui-monospace, monospace";
    ctx.fillText(label, 10 + width + 5, y + 4);
  }

  function pager(panel, fetched) {
    const sheet = state.sheet;
    const plan = state.plan;
    const view = panel.views.paper;

    ui.prevPanel.disabled = state.at === 0;
    ui.nextPanel.disabled = state.at >= sheet.panels.length - 1;
    ui.panelAt.textContent = panel.section
      ? `part ${panel.section.number} / ${plan.sections.length}`
      : "overview";

    ui.panelCap.textContent = panel.section
      ? `${plan.units.long(panel.section.fromDistance)} – ${plan.units.long(panel.section.toDistance)}`
      : plan.single ? "one place" : plan.units.long(plan.total);
    ui.panelMeta.textContent =
      `zoom ${view.zoom.toFixed(view.zoom % 1 ? 1 : 0)} · ` +
      `${Math.round(view.metresPerPixel * 100) / 100} m per point · ` +
      `${sheet.page.label}`;

    ui.mapCredit.hidden = !fetched;
    if (fetched) {
      ui.mapCredit.innerHTML =
        'Map data © <a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap contributors</a>' +
        (fetched.missing ? ` — ${fetched.missing} square${fetched.missing === 1 ? "" : "s"} did not arrive` : "");
    }

    ui.mapNote.textContent = plan.single
      ? "One map around the place, and its coordinates. There is no route here to cut into pages."
      : plan.sections.length
      ? `The sheet is ${sheet.panels.length} map${sheet.panels.length === 1 ? "" : "s"}: ` +
        `this overview and ${plan.sections.length} detail page${plan.sections.length === 1 ? "" : "s"}, ` +
        `then the instructions.`
      : "One overview map, then the instructions. Ask for detail pages to have " +
        "the route cut into stretches, each drawn close enough to tell one junction from the next.";
  }

  /* --- the panels beside the map --------------------------------------------- */

  function facts() {
    const plan = state.plan;
    const units = plan.units;
    const first = plan.points[0];
    const last = plan.points[plan.points.length - 1];

    ui.routeCap.textContent = plan.name || "Route";
    ui.routeMeta.textContent = plan.single
      ? plan.source
      : `${plan.source} · ${plan.points.length.toLocaleString()} points`;

    if (plan.single) {
      ui.facts.innerHTML = "";
      for (const [label, value] of [
        ["Place", plan.name],
        ["Coordinates", Route.geo.coord(first.lat, first.lon)],
      ]) {
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value;
        if (label === "Coordinates") dd.className = "mono";
        ui.facts.append(dt, dd);
      }
      showNotes(plan);
      return;
    }

    const rows = [
      ["Distance", units.long(plan.total)],
      ["Instructions", `${plan.cues.length}`],
    ];
    if (plan.climb) {
      rows.push(["Ascent", units.height(plan.climb.gain)]);
      rows.push(["Descent", units.height(plan.climb.loss)]);
      rows.push(["Highest", units.height(plan.climb.max)]);
      rows.push(["Lowest", units.height(plan.climb.min)]);
    }
    rows.push(["Start", Route.geo.coord(first.lat, first.lon)]);
    rows.push(["Finish", Route.geo.coord(last.lat, last.lon)]);
    if (!plan.straightLines) rows.push(["Detail", plan.grainLabel]);

    ui.facts.innerHTML = "";
    for (const [label, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      if (/,/.test(value)) dd.className = "mono";
      ui.facts.append(dt, dd);
    }

    showNotes(plan);
  }

  function showNotes(plan) {
    ui.notes.innerHTML = "";
    const notes = plan.notes.slice();

    /* The PDF sets its type in the fonts every reader already has, which means
       WinAnsi, which means western Europe. Accents survive by being dropped off
       a letter that stays; a script with no Latin under it does not survive at
       all. Said here rather than discovered on paper, and said with the
       characters in it, because "some characters were lost" is not something a
       reader can act on and "大通り cannot be printed" is. */
    const gone = Route.pdf.lost([plan.name, ...plan.cues.map((c) => c.text)].join(" "));
    if (gone.length) {
      notes.push(
        `The PDF is set in the fonts every reader already has, and those cannot ` +
        `carry ${gone.slice(0, 12).map((c) => `“${c}”`).join(" ")}` +
        `${gone.length > 12 ? ` and ${gone.length - 12} more` : ""}. ` +
        `Accented Latin letters come through with the accent dropped; these are ` +
        `left out. Rename the route if that matters.`
      );
    }
    if (plan.straightLines) {
      notes.unshift(
        "The dashed line is drawn straight between the stops. It is not a road, " +
        "and its length is not how far you will travel."
      );
    }
    for (const note of notes) {
      const p = document.createElement("p");
      p.className = "sheet-note warn";
      p.textContent = note;
      ui.notes.append(p);
    }
  }

  const GLYPH = {
    start: "●", finish: "◎", stop: "◆", place: "◆", note: "•",
    left: "←", right: "→", "slight-left": "↖", "slight-right": "↗",
    "sharp-left": "↰", "sharp-right": "↱", "u-turn": "↩", straight: "↑",
  };

  function cues() {
    const plan = state.plan;
    const units = plan.units;
    ui.cueBody.innerHTML = "";

    for (const cue of plan.cues) {
      const tr = document.createElement("tr");
      tr.dataset.type = cue.type;

      const n = document.createElement("td");
      n.className = "col-n";
      n.textContent = String(cue.number);

      const glyph = document.createElement("td");
      glyph.className = "col-glyph";
      glyph.textContent = GLYPH[cue.type] || "•";
      if (Number.isFinite(cue.angle) && cue.angle) {
        glyph.title = `${Math.round(Math.abs(cue.angle))}° to the ${cue.angle < 0 ? "left" : "right"}`;
      }

      const text = document.createElement("td");
      const strong = document.createElement("strong");
      strong.textContent = cue.text;
      text.append(strong);
      if (cue.detail) {
        const small = document.createElement("span");
        small.className = "cue-detail";
        small.textContent = cue.detail;
        text.append(small);
      }
      if (cue.source === "file") {
        const tag = document.createElement("span");
        tag.className = "cue-tag";
        tag.textContent = "from the file";
        text.append(tag);
      }

      const at = document.createElement("td");
      at.className = "col-num";
      at.textContent = units.short(cue.at);

      const next = document.createElement("td");
      next.className = "col-num";
      next.textContent = cue.toNext > 0 ? units.short(cue.toNext) : "—";

      const coord = document.createElement("td");
      coord.className = "col-coord";
      coord.textContent = Route.geo.coord(cue.lat, cue.lon);

      tr.append(n, glyph, text, at, next, coord);
      ui.cueBody.append(tr);
    }

    if (plan.single) {
      ui.cueNote.textContent =
        "One place, so there is nothing to give instructions about. The sheet " +
        "is a locator: a map around the point and the coordinates in full.";
      return;
    }

    const derived = plan.cues.filter((c) => c.source === "shape").length;
    ui.cueNote.textContent = derived === plan.cues.length - 2 && derived > 0
      ? `All ${derived} turns were worked out from the shape of the path — this ` +
        `file carried no written instructions, which is normal for a recorded track. ` +
        `They cannot name a street, so the map beside them is doing half the work.`
      : derived === 0
        ? "Every instruction here came out of the file, street names and all."
        : `${plan.cues.length - derived - 2} instructions came from the file; ` +
          `${derived} were worked out from the shape of the path.`;
  }

  /* --- output ------------------------------------------------------------------ */

  function build() {
    const opts = settings();
    const panels = {};
    for (const panel of state.sheet.panels) {
      const held = state.panels[key(panel, opts)];
      if (held) panels[panel.id] = held;
    }
    return Promise.all(
      Object.keys(panels).map(async (id) => {
        const bytes = await Route.tiles.toJPEG(panels[id].canvas, 0.82);
        return [id, { bytes, width: panels[id].canvas.width, height: panels[id].canvas.height }];
      })
    ).then((entries) => {
      const images = Object.fromEntries(entries);
      return Route.pdf.print(state.plan, opts, state.sheet, images);
    });
  }

  async function download() {
    ui.download.disabled = true;
    try {
      const bytes = await build();
      const blob = new Blob([bytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${state.filename}-route-sheet.pdf`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      const kb = Math.round(bytes.length / 102.4) / 10;
      say(`Written — ${state.sheet.pages.length + 1} pages or so, ${kb} kB.`, "good");
    } catch (err) {
      say(`The PDF could not be written — ${err.message}`, "bad");
    } finally {
      ui.download.disabled = false;
    }
  }

  function copyCues() {
    const plan = state.plan;
    const units = plan.units;
    const lines = [
      plan.name || "Route",
      `${units.long(plan.total)} · ${plan.cues.length} instructions · ${plan.source}`,
      "",
    ];
    for (const cue of plan.cues) {
      lines.push(
        `${String(cue.number).padStart(3)}  ${units.short(cue.at).padStart(9)}  ` +
        `${cue.text}${cue.detail ? ` (${cue.detail})` : ""}  [${Route.geo.coord(cue.lat, cue.lon)}]`
      );
    }
    navigator.clipboard.writeText(lines.join("\n")).then(
      () => say("The instructions are on the clipboard.", "good"),
      () => say("The browser would not let this page write to the clipboard.", "bad")
    );
  }

  /* --- wiring -------------------------------------------------------------------- */

  ui.pick.addEventListener("click", () => ui.file.click());
  ui.file.addEventListener("change", () => {
    const file = ui.file.files[0];
    if (file) load(() => Route.parse.fromFile(file), file.name);
    ui.file.value = "";
  });

  for (const event of ["dragenter", "dragover"]) {
    ui.dropzone.addEventListener(event, (e) => {
      e.preventDefault();
      ui.dropzone.classList.add("drag-over");
    });
  }
  for (const event of ["dragleave", "drop"]) {
    ui.dropzone.addEventListener(event, () => ui.dropzone.classList.remove("drag-over"));
  }
  ui.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) load(() => Route.parse.fromFile(file), file.name);
  });

  ui.read.addEventListener("click", () => {
    const text = ui.pasted.value.trim();
    if (!text) { say("Paste a link, some coordinates or an encoded polyline first.", "bad"); return; }
    load(() => Route.parse.fromText(text, ""), "");
  });
  ui.pasted.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ui.read.click();
  });

  ui.clear.addEventListener("click", () => {
    state.route = state.plan = state.sheet = null;
    state.panels = {};
    Route.tiles.forget();
    ui.pasted.value = "";
    ui.workbench.hidden = true;
    ui.empty.hidden = false;
    ui.clear.hidden = true;
    say("");
    ui.intake.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  for (const control of [ui.pathPick, ui.grain, ui.detail, ui.units, ui.paper, ui.orientation]) {
    control.addEventListener("change", schedule);
    control.addEventListener("input", schedule);
  }
  ui.map.addEventListener("change", () => {
    // A change of treatment invalidates every panel, because the fade is baked
    // into the picture rather than applied when it is drawn.
    state.panels = {};
    Route.tiles.forget();
    schedule();
  });

  ui.prevPanel.addEventListener("click", () => { state.at = Math.max(0, state.at - 1); drawPreview(); });
  ui.nextPanel.addEventListener("click", () => {
    state.at = Math.min(state.sheet.panels.length - 1, state.at + 1);
    drawPreview();
  });

  ui.download.addEventListener("click", download);
  ui.copyCues.addEventListener("click", copyCues);

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.sheet) drawPreview(); }, 140);
  });

  /* An example that shows the tool doing the thing it is for: a recorded track
     with no instructions in it at all, whose every cue has to come out of the
     shape. It is a loop of the Ringstrasse in Vienna, written out here as a
     GPX so the page needs nothing from anywhere to demonstrate itself. */
  const EXAMPLE = [
    [48.20359, 16.36301], [48.20516, 16.36106], [48.20668, 16.35924], [48.20791, 16.35777],
    [48.20904, 16.35804], [48.21014, 16.35937], [48.21134, 16.36095], [48.21245, 16.36240],
    [48.21356, 16.36386], [48.21470, 16.36534], [48.21580, 16.36683], [48.21668, 16.36838],
    [48.21707, 16.37013], [48.21690, 16.37206], [48.21624, 16.37378], [48.21525, 16.37516],
    [48.21404, 16.37622], [48.21276, 16.37704], [48.21143, 16.37780], [48.21008, 16.37858],
    [48.20873, 16.37936], [48.20744, 16.38014], [48.20618, 16.38102], [48.20505, 16.38216],
    [48.20418, 16.38358], [48.20358, 16.38520], [48.20286, 16.38648], [48.20180, 16.38712],
    [48.20060, 16.38700], [48.19949, 16.38620], [48.19862, 16.38486], [48.19812, 16.38318],
    [48.19806, 16.38138], [48.19844, 16.37962], [48.19918, 16.37806], [48.20014, 16.37672],
    [48.20112, 16.37542], [48.20196, 16.37388], [48.20254, 16.37214], [48.20288, 16.37028],
    [48.20308, 16.36838], [48.20326, 16.36646], [48.20342, 16.36470], [48.20359, 16.36301],
  ];

  ui.example.addEventListener("click", () => {
    const points = EXAMPLE.map(([lat, lon], i) =>
      `<trkpt lat="${lat}" lon="${lon}"><ele>${(171 + Math.sin(i / 4) * 7).toFixed(1)}</ele></trkpt>`
    ).join("");
    const gpx =
      `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">` +
      `<trk><name>Ringstrasse loop</name><trkseg>${points}</trkseg></trk></gpx>`;
    ui.pasted.value = "";
    load(() => Promise.resolve(Route.parse.fromText(gpx, "Ringstrasse loop.gpx")), "Ringstrasse loop");
  });
})();
