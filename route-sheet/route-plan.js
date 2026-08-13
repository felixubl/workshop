/* The plan: one parsed route plus one set of settings, turned into everything
   that gets drawn. The preview on the page and the PDF are two renderers over
   this same object, so what is on screen cannot disagree with what prints.

   The cue list is assembled from three sources in descending order of
   authority. An instruction the file carried outranks one worked out from the
   shape, because it knows the name of the road. A named waypoint outranks a
   bare corner, because somebody chose to put it there. Everything else is
   geometry. Where two land in the same place the weaker one is dropped rather
   than printed twice. */

;(function (Route) {
  "use strict";

  const geo = Route.geo;

  // How coarse the turn-finding is. A city ride wants every corner; a
  // motorway route across a country wants junctions and nothing else, or the
  // sheet is forty pages of "bear left" for a road that is simply not
  // straight. The scale is picked from the route's own length.
  const GRAINS = {
    fine:   { label: "every corner",  tolerance: 4,  window: 25,  spacing: 30,  floor: 20 },
    normal: { label: "the turns",     tolerance: 9,  window: 45,  spacing: 90,  floor: 26 },
    coarse: { label: "the junctions", tolerance: 22, window: 120, spacing: 400, floor: 38 },
  };

  function defaultGrain(totalMetres) {
    if (totalMetres < 25000) return "fine";
    if (totalMetres < 200000) return "normal";
    return "coarse";
  }

  /* --- cue text ------------------------------------------------------------ */

  const SIDE = (angle) => (angle < 0 ? "left" : "right");

  function turnCue(turn) {
    const kind = geo.classify(turn.angle);
    const side = SIDE(turn.angle);
    const text = kind.type === "u-turn" ? "Turn around" : `${kind.word} ${side}`;
    const type = kind.type === "u-turn" ? "u-turn"
      : kind.type === "turn" ? side
      : `${kind.type === "slight" ? "slight" : "sharp"}-${side}`;
    return { text, type, angle: turn.angle };
  }

  // The heading a person leaves a turn on, which is the one useful thing the
  // geometry knows that a street name would not tell you.
  const heading = (deg) => `${geo.compass(deg)} ${Math.round(deg)}°`;

  /* --- assembling the cues -------------------------------------------------- */

  // A coordinate from the file, placed on the path. Authored cues sit at the
  // junction rather than at a vertex, so the nearest vertex is the right
  // answer; beyond `limit` metres the cue belongs to some other part of the
  // route and is left off.
  function snap(points, dist, lat, lon, limit) {
    let best = -1, bestDistance = Infinity;
    const probe = { lat, lon };
    for (let i = 0; i < points.length; i++) {
      const d = geo.distance(points[i], probe);
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    return bestDistance <= limit ? { index: best, off: bestDistance } : null;
  }

  /* One place and no route. A Waze link, a geo: URI, a dropped pin — the
     readers promise a locator sheet for these rather than an error, so this
     builds one: the same page furniture, a map around the point, and the
     coordinates set large enough to read out over a phone. */
  function locator(route, settings) {
    const marker = route.markers[0];
    const point = { lat: marker.lat, lon: marker.lon };
    return {
      name: route.name || marker.name || "Place",
      source: route.source,
      notes: route.notes.slice(),
      kind: "place",
      single: true,
      points: [point],
      dist: new Float64Array(1),
      total: 0,
      box: geo.bounds([point]),
      climb: null,
      markers: route.markers,
      cues: [{
        index: 0, number: 1, type: "finish", source: "file",
        text: marker.name || "Destination",
        detail: marker.note ? Route.parse.stripTags(marker.note).slice(0, 90) : "",
        angle: 0, bearing: 0, at: 0, toNext: 0,
        lat: point.lat, lon: point.lon,
      }],
      grain: "none",
      grainLabel: "one place",
      sections: [],
      units: geo.UNITS[settings.units] || geo.UNITS.metric,
      straightLines: false,
    };
  }

  function build(route, settings) {
    const path = route.paths[settings.pathIndex] || route.paths[0];
    if (!path) {
      if (route.markers.length) return locator(route, settings);
      throw new Error("There is no path in this route to draw.");
    }

    const points = path.points;
    const dist = geo.cumulative(points);
    const total = dist[dist.length - 1];
    const grainKey = settings.grain === "auto" ? defaultGrain(total) : settings.grain;
    const grain = GRAINS[grainKey] || GRAINS.normal;

    const box = geo.bounds(points);
    const climb = geo.elevation(points, 3);

    /* Waypoints that lie on the path are places to name in the instructions;
       waypoints far from it are somebody's parking spot or a photo pin and
       belong on the map but not in the cue list. */
    const near = [];
    for (const marker of route.markers) {
      const hit = snap(points, dist, marker.lat, marker.lon, 120);
      if (hit) near.push({ ...marker, index: hit.index });
    }

    const cues = [];
    const startBearing = points.length > 1 ? geo.bearing(points[0], points[Math.min(4, points.length - 1)]) : 0;

    cues.push({
      index: 0, type: "start", source: "path",
      text: startName(route, near),
      detail: `Head ${heading(startBearing)}`,
      angle: 0, bearing: startBearing,
    });

    /* A path built out of stops rather than surveyed — a Google or Waze link,
       a bare list of coordinates — has no corners to find, because the line
       between two stops is a straight line this tool drew. Every interior
       vertex is a stop, and that is the honest cue. */
    if (path.kind === "stops") {
      for (let i = 1; i < points.length - 1; i++) {
        const marker = near.find((m) => m.index === i);
        cues.push({
          index: i, type: "stop", source: "file",
          text: marker?.name || `Stop ${i}`,
          detail: marker?.note ? Route.parse.stripTags(marker.note).slice(0, 90) : "",
          angle: 0,
          bearing: geo.bearing(points[i], points[i + 1]),
        });
      }
    } else {
      const kept = geo.simplify(points, grain.tolerance);
      const thin = kept.map((i) => points[i]);
      const thinDist = kept.map((i) => dist[i]);
      const turns = geo.findTurns(thin, thinDist, grain);

      /* Instructions the file carried. They are placed first and given a
         keep-out radius, so a derived turn describing the same junction in
         worse words does not print underneath. */
      const authored = [];
      for (const cue of route.cues) {
        const hit = snap(points, dist, cue.lat, cue.lon, 150);
        if (!hit) continue;
        const text = (cue.text || "").trim();
        if (!text) continue;
        authored.push({
          index: hit.index, type: cue.type || "note", source: "file",
          text: text.length > 120 ? text.slice(0, 117) + "…" : text,
          detail: "", angle: 0,
          bearing: geo.bearing(points[hit.index], points[Math.min(hit.index + 1, points.length - 1)]),
        });
      }
      cues.push(...authored);

      const blocked = (index) =>
        authored.some((a) => Math.abs(dist[a.index] - dist[index]) < grain.spacing * 1.5);

      for (const turn of turns) {
        const index = kept[turn.index];
        if (blocked(index)) continue;
        const cue = turnCue(turn);
        const marker = near.find((m) => Math.abs(dist[m.index] - dist[index]) < 60);
        cues.push({
          index,
          type: cue.type,
          source: "shape",
          text: cue.text,
          detail: marker?.name
            ? `at ${marker.name} · then ${heading(turn.outBearing)}`
            : `then ${heading(turn.outBearing)}`,
          angle: cue.angle,
          bearing: turn.outBearing,
        });
      }

      // Named places on the path that no turn already mentioned: worth a line
      // of their own, because a landmark is the one thing on this sheet a
      // reader can check themselves against.
      for (const marker of near) {
        if (!marker.name) continue;
        if (marker.index === 0 || marker.index >= points.length - 2) continue;
        if (cues.some((c) => Math.abs(dist[c.index] - dist[marker.index]) < grain.spacing)) continue;
        cues.push({
          index: marker.index, type: "place", source: "file",
          text: marker.name,
          detail: marker.note ? Route.parse.stripTags(marker.note).slice(0, 90) : "",
          angle: 0,
          bearing: geo.bearing(points[marker.index], points[Math.min(marker.index + 1, points.length - 1)]),
        });
      }
    }

    const last = points.length - 1;
    cues.push({
      index: last, type: "finish", source: "path",
      text: finishName(route, near, last),
      detail: "", angle: 0,
      bearing: points.length > 1 ? geo.bearing(points[Math.max(0, last - 4)], points[last]) : 0,
    });

    cues.sort((a, b) => a.index - b.index || rank(a) - rank(b));

    // Distances are attached last, once the order is settled: what a reader
    // needs at a junction is how far the next one is, and that is not knowable
    // until every cue is in place.
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      c.at = dist[c.index];
      c.lat = points[c.index].lat;
      c.lon = points[c.index].lon;
      c.ele = points[c.index].ele;
      c.toNext = i < cues.length - 1 ? dist[cues[i + 1].index] - c.at : 0;
      c.number = i + 1;
    }

    return {
      name: route.name || path.name || "Route",
      source: route.source,
      notes: route.notes.slice(),
      kind: path.kind,
      points, dist, total, box, climb, cues,
      markers: route.markers,
      grain: grainKey,
      grainLabel: grain.label,
      sections: sections(points, dist, total, cues, settings.detail || 0),
      units: geo.UNITS[settings.units] || geo.UNITS.metric,
      straightLines: path.kind === "stops",
    };
  }

  const RANK = { start: 0, stop: 1, place: 2, finish: 9 };
  const rank = (cue) => RANK[cue.type] ?? 3;

  function startName(route, near) {
    const marker = near.find((m) => m.index === 0 && m.name);
    return marker ? `Start — ${marker.name}` : "Start";
  }

  function finishName(route, near, last) {
    const marker = near.find((m) => m.index >= last - 2 && m.name);
    return marker ? `Arrive — ${marker.name}` : "Arrive";
  }

  /* --- detail sections ------------------------------------------------------ */

  /* The route cut into equal lengths, one to a page, each drawn at whatever
     zoom its own piece needs. This is what makes the sheet navigable: an
     overview of a 60 km route is at a scale where a junction is a pixel, and
     no amount of good instructions makes up for not being able to see which
     of the three roads at the junction is meant.

     Each section overlaps the one before it by a little, so a turn that falls
     on a cut is on both pages rather than at the very edge of one. */
  function sections(points, dist, total, cues, count) {
    if (!count || count < 1 || points.length < 2) return [];
    const out = [];
    const span = total / count;
    const overlap = Math.min(span * 0.06, 400);

    for (let i = 0; i < count; i++) {
      const fromDistance = Math.max(0, i * span - (i > 0 ? overlap : 0));
      const toDistance = Math.min(total, (i + 1) * span + (i < count - 1 ? overlap : 0));
      const from = seek(dist, fromDistance);
      const to = seek(dist, toDistance);
      if (to <= from) continue;
      const slice = points.slice(from, to + 1);
      out.push({
        number: i + 1,
        from, to,
        fromDistance: dist[from],
        toDistance: dist[to],
        points: slice,
        box: geo.bounds(slice),
        cues: cues.filter((c) => c.index >= from && c.index <= to),
      });
    }
    return out;
  }

  // First index at or past a cumulative distance. Binary, because a track can
  // be a hundred thousand points and this runs once per section.
  function seek(dist, target) {
    let lo = 0, hi = dist.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dist[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /* --- drawing-weight simplification ---------------------------------------- */

  /* A track straight off a watch can be a hundred thousand points, and at the
     scale of a printed panel most of them land on a pixel a neighbour already
     covered. Thinning to the panel's own resolution costs nothing visible and
     keeps the PDF small enough to mail. */
  function forDrawing(points, view, tolerancePixels) {
    if (points.length < 3) return points;
    const metres = Math.max(0.5, (tolerancePixels || 0.6) * view.metresPerPixel);
    const kept = geo.simplify(points, metres);
    return kept.map((i) => points[i]);
  }

  Route.plan = { build, forDrawing, GRAINS, defaultGrain, sections, seek };

})(globalThis.Route || (globalThis.Route = {}));
