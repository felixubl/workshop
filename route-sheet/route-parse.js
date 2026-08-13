/* Readers. Every one of them turns somebody's file or link into the same
   shape, and the rest of the tool never learns which door the route came in
   through:

     { name, source, notes[], paths[], markers[], cues[] }

   A path is { name, kind, points: [{ lat, lon, ele, time }] }. A marker is a
   named place. A cue is an instruction the *source* supplied, as opposed to
   one this tool worked out from the geometry — the difference matters, because
   an authored cue knows the name of the street and a derived one never can.

   The formats split into two kinds, and the split is the whole story of what
   this tool can and cannot do. GPX, TCX, KML and GeoJSON carry the path: every
   vertex of it, as surveyed or as recorded. A Google Maps or Waze link carries
   the *stops* and nothing between them, because neither service exports a
   route. Readers in the second group say so in `notes`, and the caller prints
   it on the page and on the sheet rather than quietly drawing a straight line
   across a lake. */

;(function (Route) {
  "use strict";

  /* --- small shared pieces ------------------------------------------------ */

  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  // Coordinates arrive from a dozen sources and some of them are wrong. A
  // latitude past the poles or a longitude past the date line is not a point
  // this tool can place, and one pair of NaNs in the middle of a track would
  // otherwise poison every distance downstream.
  function point(lat, lon, ele, time) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    const p = { lat, lon };
    if (Number.isFinite(ele)) p.ele = ele;
    if (time) p.time = time;
    return p;
  }

  function blank() {
    return { name: "", source: "", notes: [], paths: [], markers: [], cues: [] };
  }

  // Two consecutive points at the same place carry no bearing and no distance,
  // so they are dropped here rather than guarded against in five later loops.
  function tidy(points) {
    const out = [];
    for (const p of points) {
      if (!p) continue;
      const last = out[out.length - 1];
      if (last && last.lat === p.lat && last.lon === p.lon) continue;
      out.push(p);
    }
    return out;
  }

  function addPath(route, name, kind, points) {
    const clean = tidy(points);
    if (clean.length >= 2) {
      route.paths.push({ name: name || "", kind, points: clean });
      return;
    }
    // Everything in it landed on one coordinate: a device that logged a
    // hundred fixes without moving, or a link whose stops turned out to be the
    // same place twice. That is still somewhere, and a sheet naming it is more
    // use than an error saying the file was empty when it plainly was not.
    if (clean.length === 1 && !route.markers.length) {
      route.markers.push({ lat: clean[0].lat, lon: clean[0].lon, name: name || "", note: "" });
    }
  }

  /* --- XML helpers -------------------------------------------------------- */

  // Local-name lookups throughout. A GPX in the wild may declare its namespace
  // as the default or behind a prefix, and half the TCX files ever written put
  // Garmin's extensions in a third one; matching on the local name means none
  // of that reaches the readers.
  const kids = (el, name) => Array.from(el.getElementsByTagNameNS("*", name));
  const kid = (el, name) => el.getElementsByTagNameNS("*", name)[0] || null;
  const textOf = (el, name) => {
    const found = kid(el, name);
    return found ? found.textContent.trim() : "";
  };

  function parseXML(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return null;
    return doc;
  }

  const stamp = (s) => (s && !Number.isNaN(Date.parse(s)) ? s : null);

  /* --- GPX ---------------------------------------------------------------- */

  /* Three things live in a GPX and they are not the same thing. A <trk> is a
     recording — every vertex the device saw, at whatever rate it sampled. A
     <rte> is a plan: a handful of points somebody chose, often with the turn
     written into each one's name. A <wpt> is a place, loose in the file and
     belonging to no path. All three are read, because a file that holds a
     route and its waypoints holds more than either alone. */

  function readGPX(doc, route) {
    route.source = "GPX";
    route.name = textOf(doc.documentElement, "name") || "";

    for (const trk of kids(doc.documentElement, "trk")) {
      // Segments are the recorder saying it lost the signal or was switched
      // off. They are the same journey, so they are joined, but the gap is
      // real and the caller is told about it.
      const points = [];
      for (const seg of kids(trk, "trkseg")) {
        for (const pt of kids(seg, "trkpt")) points.push(readGPXPoint(pt));
      }
      addPath(route, textOf(trk, "name"), "track", points);
    }

    for (const rte of kids(doc.documentElement, "rte")) {
      const pts = kids(rte, "rtept");
      const points = pts.map(readGPXPoint);
      addPath(route, textOf(rte, "name"), "route", points);

      // A planned route names its turns in the points themselves. Komoot,
      // RideWithGPS and Garmin all write the instruction into <name> or
      // <desc>, and it is worth more than anything the geometry can be made to
      // confess, because it knows what the street is called.
      pts.forEach((pt, i) => {
        const lat = num(pt.getAttribute("lat"));
        const lon = num(pt.getAttribute("lon"));
        const text = textOf(pt, "name") || textOf(pt, "desc") || textOf(pt, "cmt");
        if (text && Number.isFinite(lat) && Number.isFinite(lon)) {
          route.cues.push({ lat, lon, text, type: gpxCueType(pt), order: i });
        }
      });
    }

    for (const wpt of kids(doc.documentElement, "wpt")) {
      const lat = num(wpt.getAttribute("lat"));
      const lon = num(wpt.getAttribute("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      route.markers.push({
        lat, lon,
        name: textOf(wpt, "name") || textOf(wpt, "desc"),
        note: textOf(wpt, "desc"),
      });
    }

    if (!route.paths.length && route.markers.length >= 2) {
      addPath(route, "", "stops", route.markers.map((m) => point(m.lat, m.lon)));
      route.notes.push(
        "This GPX holds waypoints but no track or route, so the stops are " +
        "joined in the order the file lists them. The line between them is not a road."
      );
    }
  }

  function readGPXPoint(pt) {
    return point(
      num(pt.getAttribute("lat")),
      num(pt.getAttribute("lon")),
      num(textOf(pt, "ele")),
      stamp(textOf(pt, "time"))
    );
  }

  // Garmin writes the turn as a symbol name; everyone else leaves it out.
  function gpxCueType(pt) {
    const sym = (textOf(pt, "sym") || textOf(pt, "type")).toLowerCase();
    if (!sym) return "";
    if (sym.includes("left")) return sym.includes("sharp") ? "sharp-left" : "left";
    if (sym.includes("right")) return sym.includes("sharp") ? "sharp-right" : "right";
    if (sym.includes("straight") || sym.includes("continue")) return "straight";
    if (sym.includes("summit") || sym.includes("food") || sym.includes("water")) return "place";
    return "";
  }

  /* --- TCX ---------------------------------------------------------------- */

  /* Garmin's training format. Worth reading for one reason beyond the track:
     a <CoursePoint> is a real turn instruction with a name and a type, placed
     at a coordinate. A TCX course is the one common sport file that arrives
     already knowing where to tell you to turn. */

  const TCX_TURNS = {
    left: "left", right: "right", straight: "straight",
    slightleft: "slight-left", slightright: "slight-right",
    sharpleft: "sharp-left", sharpright: "sharp-right",
    uturn: "u-turn", summit: "place", valley: "place", water: "place",
    food: "place", danger: "place", first_aid: "place", generic: "place",
  };

  function readTCX(doc, route) {
    route.source = "TCX";

    for (const course of kids(doc.documentElement, "Course")) {
      readTCXTrack(course, route, textOf(course, "Name"));
      for (const cp of kids(course, "CoursePoint")) {
        const pos = kid(cp, "Position");
        if (!pos) continue;
        const lat = num(textOf(pos, "LatitudeDegrees"));
        const lon = num(textOf(pos, "LongitudeDegrees"));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const kind = textOf(cp, "PointType").toLowerCase().replace(/[\s_-]/g, "");
        route.cues.push({
          lat, lon,
          text: textOf(cp, "Name") || textOf(cp, "Notes"),
          type: TCX_TURNS[kind] || "",
        });
      }
    }

    // An Activity is a recording rather than a plan, and has no course points.
    for (const act of kids(doc.documentElement, "Activity")) {
      readTCXTrack(act, route, textOf(act, "Id"));
    }
    if (!route.paths.length) readTCXTrack(doc.documentElement, route, "");
    route.name = route.paths.length ? route.paths[0].name : "";
  }

  function readTCXTrack(scope, route, name) {
    const points = [];
    for (const tp of kids(scope, "Trackpoint")) {
      const pos = kid(tp, "Position");
      if (!pos) continue;
      points.push(point(
        num(textOf(pos, "LatitudeDegrees")),
        num(textOf(pos, "LongitudeDegrees")),
        num(textOf(tp, "AltitudeMeters")),
        stamp(textOf(tp, "Time"))
      ));
    }
    addPath(route, name, "track", points);
  }

  /* --- KML ---------------------------------------------------------------- */

  /* Google's format, and the one door out of Google Maps that actually works:
     My Maps exports it, and a My Maps layer built from directions carries the
     road geometry as a LineString plus the written instructions in the
     placemark's description. Note the coordinate order — KML writes
     lon,lat,ele, which is the opposite of every other format here. */

  function readKML(doc, route) {
    route.source = "KML";
    route.name = textOf(doc.documentElement, "name") || "";

    for (const placemark of kids(doc.documentElement, "Placemark")) {
      const name = textOf(placemark, "name");

      const lines = [
        ...kids(placemark, "LineString"),
        ...kids(placemark, "LinearRing"),
      ];
      for (const line of lines) {
        addPath(route, name, "line", kmlCoords(textOf(line, "coordinates")));
      }

      // gx:Track interleaves <when> and <gx:coord>, which is how a KML holds
      // a recording rather than a drawn shape.
      for (const track of kids(placemark, "Track")) {
        const whens = kids(track, "when").map((w) => w.textContent.trim());
        const coords = kids(track, "coord").map((c) => c.textContent.trim());
        const points = coords.map((c, i) => {
          const [lon, lat, ele] = c.split(/\s+/).map(num);
          return point(lat, lon, ele, stamp(whens[i]));
        });
        addPath(route, name, "track", points);
      }

      for (const pt of kids(placemark, "Point")) {
        const parsed = kmlCoords(textOf(pt, "coordinates"));
        if (!parsed.length || !parsed[0]) continue;
        route.markers.push({
          lat: parsed[0].lat,
          lon: parsed[0].lon,
          name,
          note: stripTags(textOf(placemark, "description")),
        });
      }
    }

    if (!route.paths.length && route.markers.length >= 2) {
      addPath(route, "", "stops", route.markers.map((m) => point(m.lat, m.lon)));
      route.notes.push(
        "This KML holds pins but no line, so they are joined in file order. " +
        "The line between them is not a road."
      );
    }
  }

  // Whitespace between tuples, commas inside them, and any amount of either.
  function kmlCoords(text) {
    if (!text) return [];
    return text.trim().split(/\s+/).map((tuple) => {
      const [lon, lat, ele] = tuple.split(",").map(num);
      return point(lat, lon, ele);
    });
  }

  // My Maps writes its directions as an HTML fragment inside <description>.
  function stripTags(html) {
    if (!html) return "";
    return html
      .replace(/<br\s*\/?>/gi, " · ")
      .replace(/<\/(p|div|li|tr)>/gi, " · ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s*·\s*(·\s*)+/g, " · ")
      .replace(/\s+/g, " ")
      .replace(/^\s*·\s*|\s*·\s*$/g, "")
      .trim();
  }

  /* --- KMZ ---------------------------------------------------------------- */

  /* A KMZ is a zip with a KML in it, and My Maps hands you one by default, so
     not reading it would send most Google users away at the door. Only the
     central directory is walked — enough to find the first .kml entry and
     nothing more. Decompression is the browser's: DecompressionStream is
     asynchronous, which rules it out of an inner loop but is exactly right for
     a file somebody just dropped. */

  async function readKMZ(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = findEOCD(view, bytes.length);
    if (end < 0) throw new Error("This KMZ has no zip directory in it.");

    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);

    for (let i = 0; i < count && at + 46 <= bytes.length; i++) {
      if (view.getUint32(at, true) !== 0x02014b50) break;
      const method = view.getUint16(at + 10, true);
      const compressed = view.getUint32(at + 20, true);
      const nameLen = view.getUint16(at + 28, true);
      const extraLen = view.getUint16(at + 30, true);
      const commentLen = view.getUint16(at + 32, true);
      const localAt = view.getUint32(at + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
      at += 46 + nameLen + extraLen + commentLen;

      if (!/\.kml$/i.test(name)) continue;

      // The local header repeats the name and extra fields at its own lengths,
      // which are not always the directory's, so the data offset is read from
      // the local header rather than assumed.
      const localNameLen = view.getUint16(localAt + 26, true);
      const localExtraLen = view.getUint16(localAt + 28, true);
      const from = localAt + 30 + localNameLen + localExtraLen;
      const raw = bytes.subarray(from, from + compressed);

      if (method === 0) return new TextDecoder().decode(raw);
      if (method !== 8) throw new Error(`This KMZ compresses ${name} in a way the browser cannot undo.`);
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return await new Response(stream).text();
    }
    throw new Error("This KMZ holds no KML file.");
  }

  // The end-of-central-directory record is last, unless there is a comment
  // after it, so it is hunted backwards through the 64k a comment may occupy.
  function findEOCD(view, length) {
    const floor = Math.max(0, length - 0x10000 - 22);
    for (let at = length - 22; at >= floor; at--) {
      if (view.getUint32(at, true) === 0x06054b50) return at;
    }
    return -1;
  }

  /* --- GeoJSON and the routing-engine JSONs ------------------------------- */

  function readGeoJSON(data, route) {
    route.source = "GeoJSON";

    // Before treating it as GeoJSON: the same .json extension covers what a
    // routing engine answered, and those hold a road path and real written
    // instructions. Worth checking for, because it is the best input there is.
    if (readDirections(data, route)) return;

    const walk = (node, name) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach((n) => walk(n, name)); return; }

      const label = node.properties?.name || node.properties?.title || name || "";
      if (node.type === "FeatureCollection") { walk(node.features, label); return; }
      if (node.type === "Feature") { walk(node.geometry, label); return; }
      if (node.type === "GeometryCollection") { walk(node.geometries, label); return; }

      const c = node.coordinates;
      if (!c) return;
      if (node.type === "LineString") addPath(route, label, "line", geoCoords(c));
      else if (node.type === "MultiLineString") c.forEach((line) => addPath(route, label, "line", geoCoords(line)));
      else if (node.type === "Point") {
        const p = point(num(c[1]), num(c[0]));
        if (p) route.markers.push({ lat: p.lat, lon: p.lon, name: label, note: "" });
      } else if (node.type === "MultiPoint") {
        for (const one of c) {
          const p = point(num(one[1]), num(one[0]));
          if (p) route.markers.push({ lat: p.lat, lon: p.lon, name: label, note: "" });
        }
      }
    };

    walk(data, "");
    route.name = route.paths.find((p) => p.name)?.name || "";
    if (!route.paths.length && route.markers.length >= 2) {
      addPath(route, "", "stops", route.markers.map((m) => point(m.lat, m.lon)));
      route.notes.push("This file holds points but no line, so they are joined in file order.");
    }
  }

  // GeoJSON is lon,lat, and the third slot is elevation in metres.
  const geoCoords = (list) =>
    list.map((c) => point(num(c[1]), num(c[0]), c.length > 2 ? num(c[2]) : null));

  /* What a routing engine returns. Google's Directions API, OSRM, Mapbox and
     GraphHopper all answer with an encoded polyline plus a list of steps, and
     the steps are written instructions with street names in them. Anybody who
     can get one of these has the best possible input to this tool, so all four
     dialects are read. */
  function readDirections(data, route) {
    const google = data.routes?.[0]?.overview_polyline?.points;
    if (typeof google === "string") {
      route.source = "Google Directions response";
      addPath(route, data.routes[0].summary || "", "line", decodePolyline(google, 5));
      for (const leg of data.routes[0].legs || []) {
        for (const step of leg.steps || []) {
          const at = step.start_location;
          if (!at) continue;
          route.cues.push({
            lat: num(at.lat), lon: num(at.lng),
            text: stripTags(step.html_instructions || ""),
            type: manoeuvre(step.maneuver),
          });
        }
      }
      return true;
    }

    // OSRM and Mapbox share a schema; GraphHopper puts its polyline elsewhere.
    const osrm = data.routes?.[0]?.geometry;
    if (osrm) {
      route.source = "OSRM route";
      const pts = typeof osrm === "string"
        ? decodePolyline(osrm, 5)
        : geoCoords(osrm.coordinates || []);
      addPath(route, "", "line", pts);
      for (const leg of data.routes[0].legs || []) {
        for (const step of leg.steps || []) {
          const at = step.maneuver?.location;
          if (!Array.isArray(at)) continue;
          route.cues.push({
            lat: num(at[1]), lon: num(at[0]),
            text: step.name ? `${manoeuvreWord(step.maneuver)} onto ${step.name}`.trim() : manoeuvreWord(step.maneuver),
            type: manoeuvre(step.maneuver?.modifier),
          });
        }
      }
      return true;
    }

    const gh = data.paths?.[0]?.points;
    if (gh) {
      route.source = "GraphHopper route";
      addPath(route, "", "line", typeof gh === "string" ? decodePolyline(gh, 5) : geoCoords(gh.coordinates || []));
      return true;
    }
    return false;
  }

  const MANOEUVRES = {
    "turn-left": "left", "turn-right": "right",
    "turn-slight-left": "slight-left", "turn-slight-right": "slight-right",
    "turn-sharp-left": "sharp-left", "turn-sharp-right": "sharp-right",
    "uturn-left": "u-turn", "uturn-right": "u-turn", uturn: "u-turn",
    "ramp-left": "slight-left", "ramp-right": "slight-right",
    "fork-left": "slight-left", "fork-right": "slight-right",
    "roundabout-left": "left", "roundabout-right": "right",
    left: "left", right: "right", straight: "straight",
    "slight left": "slight-left", "slight right": "slight-right",
    "sharp left": "sharp-left", "sharp right": "sharp-right",
  };
  const manoeuvre = (m) => MANOEUVRES[String(m || "").toLowerCase()] || "";
  const manoeuvreWord = (m) => {
    const type = String(m?.type || "").replace(/[_-]/g, " ");
    const mod = String(m?.modifier || "").replace(/[_-]/g, " ");
    if (type === "depart") return "Start";
    if (type === "arrive") return "Arrive";
    if (mod) return `Turn ${mod}`;
    return type ? type[0].toUpperCase() + type.slice(1) : "Continue";
  };

  /* --- encoded polylines -------------------------------------------------- */

  /* Google's algorithm, and the one everybody borrowed. Signed offsets from
     the point before, zigzagged so a small negative number stays small, then
     five bits to a character with the high bit as a continuation flag. */
  function decodePolyline(str, precision) {
    const factor = Math.pow(10, precision || 5);
    const out = [];
    let index = 0, lat = 0, lon = 0;

    while (index < str.length) {
      let shift = 0, result = 0, byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        if (byte < 0) return out;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < str.length);
      lat += result & 1 ? ~(result >> 1) : result >> 1;

      shift = 0; result = 0;
      do {
        byte = str.charCodeAt(index++) - 63;
        if (byte < 0) return out;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < str.length);
      lon += result & 1 ? ~(result >> 1) : result >> 1;

      const p = point(lat / factor, lon / factor);
      if (p) out.push(p);
    }
    return out;
  }

  // Precision 5 is Google's and precision 6 is Valhalla's and Mapbox's
  // high-accuracy variant. Told apart by trying both and keeping whichever
  // lands somewhere on Earth with sane step sizes: a precision-6 string read at
  // 5 comes out ten times too large and leaves the planet on the first hop.
  function decodePolylineAuto(str) {
    for (const precision of [5, 6]) {
      const pts = decodePolyline(str, precision);
      if (pts.length < 2) continue;
      let sane = true;
      for (let i = 1; i < pts.length && sane; i++) {
        if (Math.abs(pts[i].lat - pts[i - 1].lat) > 1) sane = false;
        if (Math.abs(pts[i].lon - pts[i - 1].lon) > 1) sane = false;
      }
      if (sane) return { points: pts, precision };
    }
    const fallback = decodePolyline(str, 5);
    return fallback.length >= 2 ? { points: fallback, precision: 5 } : null;
  }

  /* --- links -------------------------------------------------------------- */

  const NOT_A_ROAD =
    "joined by straight lines, which are not roads — the service does not " +
    "publish the path between the stops.";

  /* Google Maps. There is no export, so what can be had is what the address
     bar happens to carry, and that is the stops rather than the route.

     The reliable seam is the data blob: inside a /dir/ URL, each stop is a
     !1d<lng>!2d<lat> pair, in order. It is undocumented and could change
     tomorrow, so the path segments and the api=1 parameters are read as well,
     and whichever yields the most stops wins.

     A maps.app.goo.gl short link cannot be resolved here at all. Following it
     is a cross-origin redirect the browser will not let a page read, and the
     alternative is asking a server somewhere to open the link — which would
     hand somebody's destination to a third party to save one paste. The reader
     says what to do instead. */
  function readGoogleLink(url, route) {
    route.source = "Google Maps link";

    if (/^(https?:\/\/)?(maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(url)) {
      throw new Error(
        "That is a Google short link. The browser is not allowed to follow it, " +
        "and resolving it elsewhere would hand your destination to a stranger. " +
        "Open it once in Maps and paste the full address from the bar instead."
      );
    }

    const stops = [];
    const seen = new Set();
    const add = (lat, lon, name) => {
      const p = point(lat, lon);
      if (!p) return;
      const key = `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
      if (seen.has(key)) return;
      seen.add(key);
      stops.push({ ...p, name: name || "" });
    };

    const blob = [];
    // Longitude first: Google's blob is the one place in this file where the
    // order is d-number-then-d-number rather than a named pair.
    const pairs = /!1d(-?\d+\.?\d*)!2d(-?\d+\.?\d*)/g;
    let match;
    while ((match = pairs.exec(url))) blob.push([num(match[2]), num(match[1])]);

    let parsed = null;
    try { parsed = new URL(url.startsWith("http") ? url : "https://" + url); } catch { parsed = null; }

    const names = [];
    const dir = /\/maps\/dir\/([^@?]*)/.exec(url);
    const segments = dir
      ? dir[1].split("/").map((s) => decodeURIComponent(s).trim()).filter(Boolean)
      : [];

    const fromSegments = [];
    for (const seg of segments) {
      const coord = /^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/.exec(seg);
      if (coord) fromSegments.push([num(coord[1]), num(coord[2])]);
      else if (!/^data=|^@/.test(seg)) names.push(seg.replace(/\+/g, " "));
    }

    // api=1 links are the documented form and are trusted first when present.
    const params = parsed?.searchParams;
    const fromParams = [];
    if (params) {
      const grab = (v) => {
        if (!v) return;
        for (const part of v.split("|")) {
          const c = /^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/.exec(part.trim());
          if (c) fromParams.push([num(c[1]), num(c[2])]);
          else if (part.trim()) names.push(part.trim());
        }
      };
      grab(params.get("origin"));
      grab(params.get("waypoints"));
      grab(params.get("destination"));
      if (!fromParams.length) {
        grab(params.get("q"));
        grab(params.get("query"));
        grab(params.get("ll"));
        grab(params.get("center"));
      }
    }

    const best = [fromParams, blob, fromSegments].sort((a, b) => b.length - a.length)[0];
    for (const [lat, lon] of best) add(lat, lon);

    // A /place/ link, or any link at all with a map centre in it, is one
    // destination rather than a route — still worth a sheet, and the map
    // centre is close enough to the pin to be the honest answer.
    if (!stops.length) {
      const at = /[@!]?(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(url);
      if (at) {
        add(num(at[1]), num(at[2]));
        route.notes.push(
          "Only the map's centre could be read from this link, which is near " +
          "the pin rather than exactly on it."
        );
      }
    }

    finishLink(route, stops, names, "Google Maps");
    const place = /\/maps\/place\/([^/@]+)/.exec(url);
    if (place && !route.name) route.name = decodeURIComponent(place[1]).replace(/\+/g, " ");
  }

  /* Waze publishes no route and no export. A link carries a destination, and
     sometimes an origin, and that is the whole of it. */
  function readWazeLink(url, route) {
    route.source = "Waze link";
    let parsed = null;
    try { parsed = new URL(url.startsWith("http") ? url : "https://" + url); } catch { parsed = null; }

    const stops = [];
    const add = (lat, lon, name) => {
      const p = point(lat, lon);
      if (p) stops.push({ ...p, name: name || "" });
    };
    // Waze writes a place as `ll.<lat>,<lon>` in from/to, and as a bare pair
    // in `ll`, `latlng` and `to`/`from` alike depending on which of its own
    // link formats produced it.
    const coord = (v) => {
      if (!v) return null;
      const m = /(-?\d+\.?\d*)\s*[,%]?[C2]?0?\s*(-?\d+\.?\d*)/.exec(v.replace(/^ll\./, ""));
      return m ? [num(m[1]), num(m[2])] : null;
    };

    const params = parsed?.searchParams;
    if (params) {
      const from = coord(params.get("from"));
      if (from) add(from[0], from[1], "Start");
      const to = coord(params.get("to")) || coord(params.get("ll")) || coord(params.get("latlng"));
      if (to) add(to[0], to[1], "Destination");
    }
    if (!stops.length) {
      const hash = /(?:ll|latlng)=(-?\d+\.?\d*)[,%2C]+(-?\d+\.?\d*)/i.exec(url);
      if (hash) add(num(hash[1]), num(hash[2]), "Destination");
    }

    finishLink(route, stops, [], "Waze");
  }

  function readAppleLink(url, route) {
    route.source = "Apple Maps link";
    let parsed = null;
    try { parsed = new URL(url.startsWith("http") ? url : "https://" + url); } catch { parsed = null; }
    const stops = [];
    const names = [];
    const params = parsed?.searchParams;
    const grab = (v, label) => {
      if (!v) return;
      const c = /^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/.exec(v.trim());
      const p = c ? point(num(c[1]), num(c[2])) : null;
      if (p) stops.push({ ...p, name: label });
      else names.push(v.trim());
    };
    if (params) {
      grab(params.get("saddr"), "Start");
      grab(params.get("daddr"), "Destination");
      if (!stops.length) grab(params.get("ll") || params.get("q"), "");
    }
    finishLink(route, stops, names, "Apple Maps");
  }

  /* OpenStreetMap is the one map link that does carry its route, because the
     directions page puts every stop in `route=` and the engine is public. Still
     only the stops, not the path between them. */
  function readOSMLink(url, route) {
    route.source = "OpenStreetMap link";
    const stops = [];
    const routeParam = /[?&]route=([^&#]+)/.exec(url);
    if (routeParam) {
      for (const leg of decodeURIComponent(routeParam[1]).split(";")) {
        const c = /^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/.exec(leg.trim());
        const p = c ? point(num(c[1]), num(c[2])) : null;
        if (p) stops.push({ ...p, name: "" });
      }
    }
    if (!stops.length) {
      const at = /#map=[\d.]+\/(-?\d+\.?\d*)\/(-?\d+\.?\d*)/.exec(url);
      const p = at ? point(num(at[1]), num(at[2])) : null;
      if (p) stops.push({ ...p, name: "" });
    }
    finishLink(route, stops, [], "OpenStreetMap");
  }

  function readBingLink(url, route) {
    route.source = "Bing Maps link";
    const stops = [];
    const pos = /pos\.(-?\d+\.?\d*)_(-?\d+\.?\d*)/g;
    let m;
    while ((m = pos.exec(url))) {
      const p = point(num(m[1]), num(m[2]));
      if (p) stops.push({ ...p, name: "" });
    }
    finishLink(route, stops, [], "Bing Maps");
  }

  // Every link reader ends the same way, so the honesty about what a link can
  // and cannot carry is written once.
  function finishLink(route, stops, names, service) {
    if (!stops.length) {
      throw new Error(
        `No coordinates could be read from that ${service} link. Open it in ` +
        `${service}, then copy the full address from the browser's bar — the ` +
        `one with the numbers in it — rather than a shortened share link.`
      );
    }

    for (let i = 0; i < stops.length; i++) {
      const label = stops[i].name ||
        (i === 0 ? "Start" : i === stops.length - 1 ? "Destination" : `Stop ${i}`);
      route.markers.push({ lat: stops[i].lat, lon: stops[i].lon, name: label, note: "" });
    }

    if (stops.length === 1) {
      route.notes.push(
        `This ${service} link holds one place, not a route. The sheet is a ` +
        `locator for it: the coordinates, and a map around them.`
      );
      route.name = names[0] || "";
      return;
    }

    addPath(route, "", "stops", stops.map((s) => point(s.lat, s.lon)));
    route.notes.push(`${stops.length} stops read from a ${service} link, ${NOT_A_ROAD}`);
    if (names.length) {
      route.notes.push(
        `The link also names ${names.map((n) => `“${n}”`).join(", ")}, which ` +
        `cannot be turned into coordinates without asking a geocoder, so ` +
        `${names.length > 1 ? "they are" : "it is"} left off the map.`
      );
    }
    route.name = names.length ? names[names.length - 1] : "";
  }

  /* --- pasted coordinates ------------------------------------------------- */

  /* A list of coordinates is two different things depending on how long it is,
     and guessing wrong is worse than either. A handful is somebody's stops,
     and the lines between them are this tool's invention — they get the dashed
     line and the warning. Hundreds of them are a path somebody already traced
     or exported as text, where every vertex is real and the turns can be read
     out of the shape. The threshold is arbitrary but it has to be somewhere,
     and it is stated on the sheet either way. */
  const STOPS_AT_MOST = 25;

  function readCoordinates(text, route) {
    const found = [];
    for (const line of text.split(/[\n;]+/)) {
      const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*(?:[,\s]\s*(-?\d+(?:\.\d+)?))?\s*$/.exec(line);
      if (!m) continue;
      const p = point(num(m[1]), num(m[2]), m[3] ? num(m[3]) : null);
      if (p) found.push(p);
    }
    if (!found.length) return false;

    const points = tidy(found);
    route.source = "pasted coordinates";
    const repeats = found.length - points.length;

    if (points.length === 1) {
      route.markers.push({ lat: points[0].lat, lon: points[0].lon, name: "Destination", note: "" });
      route.notes.push(
        repeats
          ? `${found.length} coordinates, all of them the same place. Read as latitude then longitude.`
          : "One coordinate, read as latitude then longitude."
      );
      return true;
    }

    if (points.length <= STOPS_AT_MOST) {
      addPath(route, "", "stops", points);
      route.notes.push(
        `${points.length} coordinates, read as latitude then longitude and ` +
        `joined in the order given. The lines between them are not roads.`
      );
    } else {
      addPath(route, "", "line", points);
      route.notes.push(
        `${points.length} coordinates, read as latitude then longitude and ` +
        `taken as a path rather than as stops, because there are more than ` +
        `${STOPS_AT_MOST} of them. The instructions come from its shape.`
      );
    }
    return true;
  }

  /* --- the front door ----------------------------------------------------- */

  const LINKS = [
    [/google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/maps|maps\.app\.goo\.gl/i, readGoogleLink],
    [/waze\.com/i, readWazeLink],
    [/maps\.apple\.com/i, readAppleLink],
    [/openstreetmap\.org|osm\.org/i, readOSMLink],
    [/bing\.com\/maps/i, readBingLink],
  ];

  // Text in, route out. Everything that can be decided from the bytes is
  // decided here, so a file named .txt holding a GPX still reads as a GPX.
  function fromText(text, filename) {
    const route = blank();
    const trimmed = text.trim();
    if (!trimmed) throw new Error("There is nothing in that.");

    if (/^(https?:\/\/|www\.)/i.test(trimmed) || /^(geo:|maps\.|google\.)/i.test(trimmed)) {
      const url = trimmed.split(/\s+/)[0];
      const geo = /^geo:(-?\d+\.?\d*),(-?\d+\.?\d*)/i.exec(url);
      if (geo) {
        route.source = "geo: link";
        route.markers.push({ lat: num(geo[1]), lon: num(geo[2]), name: "Destination", note: "" });
        route.notes.push("A geo: link holds one place, not a route.");
        return route;
      }
      for (const [pattern, reader] of LINKS) {
        if (pattern.test(url)) { reader(url, route); return route; }
      }
      throw new Error(
        "That link is not from a mapping service this tool knows. Google Maps, " +
        "Waze, Apple Maps, OpenStreetMap and Bing links are read; anything else " +
        "has to come in as a file."
      );
    }

    if (trimmed[0] === "<") {
      const doc = parseXML(trimmed);
      if (!doc) throw new Error("That file says it is XML, but it will not parse.");
      const root = doc.documentElement.localName.toLowerCase();
      if (root === "gpx") readGPX(doc, route);
      else if (root === "trainingcenterdatabase") readTCX(doc, route);
      else if (root === "kml") readKML(doc, route);
      else if (kids(doc.documentElement, "trkpt").length) readGPX(doc, route);
      else if (kids(doc.documentElement, "Placemark").length) readKML(doc, route);
      else if (kids(doc.documentElement, "Trackpoint").length) readTCX(doc, route);
      else throw new Error(`This is XML, but its root element is <${root}> and not a route format.`);
      return finish(route, filename);
    }

    if (trimmed[0] === "{" || trimmed[0] === "[") {
      let data;
      try { data = JSON.parse(trimmed); }
      catch (err) { throw new Error("That file says it is JSON, but it will not parse."); }
      readGeoJSON(data, route);
      return finish(route, filename);
    }

    if (readCoordinates(trimmed, route)) return finish(route, filename);

    // Last resort: an encoded polyline, pasted on its own. It is the densest
    // way a route travels as text and turns up in API responses and URLs.
    if (/^[\x20-\x7e]+$/.test(trimmed) && trimmed.length > 8 && !/\s/.test(trimmed)) {
      const decoded = decodePolylineAuto(trimmed);
      if (decoded) {
        route.source = `encoded polyline (precision ${decoded.precision})`;
        addPath(route, "", "line", decoded.points);
        return finish(route, filename);
      }
    }

    throw new Error(
      "Nothing in that looked like a route. Drop a GPX, TCX, KML, KMZ or " +
      "GeoJSON file, or paste a map link or a list of coordinates."
    );
  }

  async function fromFile(file) {
    const name = file.name || "";
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const zipped = head[0] === 0x50 && head[1] === 0x4b;

    if (zipped || /\.kmz$/i.test(name)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const route = blank();
      const doc = parseXML(await readKMZ(bytes));
      if (!doc) throw new Error("The KML inside that KMZ will not parse.");
      readKML(doc, route);
      route.source = "KMZ";
      return finish(route, name);
    }

    if (/\.fit$/i.test(name) || (head[8] === 0x2e && head[9] === 0x46)) {
      throw new Error(
        "That is a Garmin FIT file, which is a binary format this tool does " +
        "not read. Every app that makes one can also export the same ride as " +
        "a GPX or a TCX — use that."
      );
    }

    return fromText(await file.text(), name);
  }

  // Housekeeping every reader would otherwise repeat: name the route after its
  // file if nothing inside it had a name, and say when a file held more than
  // one path so the caller knows to offer the choice.
  function finish(route, filename) {
    if (!route.paths.length && !route.markers.length) {
      throw new Error("That parsed, but there is no route or place in it.");
    }
    if (!route.name && filename) {
      route.name = filename.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim();
    }
    route.cues.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return route;
  }

  Route.parse = {
    fromText,
    fromFile,
    decodePolyline,
    stripTags,
    // Exported for the verification page, which checks the readers against
    // files whose answers are known.
    _internal: { readGPX, readKML, readTCX, readGeoJSON, parseXML, blank, finish },
  };

})(globalThis.Route || (globalThis.Route = {}));
