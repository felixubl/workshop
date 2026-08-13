/* Geometry. Distances on the sphere, the Mercator projection the map panels
   draw in, and the part that earns the tool its keep: working out where the
   turns are when the file did not say.

   A recorded track is a list of coordinates and nothing else. No file format
   in common use writes "turn left at the church" into a track, and most people
   exporting a route have a track rather than a plan. So the instructions are
   read out of the shape: where the path changes direction by enough, by how
   much, and how far apart those places are. That is less than a routing engine
   knows — it cannot name a street it has never heard of — but it is the whole
   of what can be had without sending the route to somebody else, and printed
   next to a map it is enough to follow. */

;(function (Route) {
  "use strict";

  const R = 6371008.8;                 // metres, IUGG mean Earth radius
  const RAD = Math.PI / 180;
  const DEG = 180 / Math.PI;

  /* --- distance and direction --------------------------------------------- */

  function distance(a, b) {
    const φ1 = a.lat * RAD, φ2 = b.lat * RAD;
    const dφ = φ2 - φ1;
    const dλ = (b.lon - a.lon) * RAD;
    const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Initial bearing, degrees clockwise from north. On a sphere the bearing of
  // a leg is not the same at both ends; this is the one at `a`, which is the
  // one a person standing there would take.
  function bearing(a, b) {
    const φ1 = a.lat * RAD, φ2 = b.lat * RAD;
    const dλ = (b.lon - a.lon) * RAD;
    const y = Math.sin(dλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
    return (Math.atan2(y, x) * DEG + 360) % 360;
  }

  // Signed difference between two bearings, in (-180, 180]. Negative is left.
  function turnAngle(from, to) {
    let d = ((to - from + 540) % 360) - 180;
    return d === -180 ? 180 : d;
  }

  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                   "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

  function cumulative(points) {
    const out = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) out[i] = out[i - 1] + distance(points[i - 1], points[i]);
    return out;
  }

  function bounds(points) {
    let north = -90, south = 90, east = -180, west = 180;
    for (const p of points) {
      if (p.lat > north) north = p.lat;
      if (p.lat < south) south = p.lat;
      if (p.lon > east) east = p.lon;
      if (p.lon < west) west = p.lon;
    }
    return { north, south, east, west };
  }

  /* --- simplification ------------------------------------------------------ */

  /* Douglas–Peucker, with the perpendicular distance measured in metres on a
     local flat projection rather than in degrees. Degrees would weight
     longitude wrongly everywhere but the equator, and a route in Norway would
     simplify differently from the same shape in Kenya.

     Iterative rather than recursive: a track from a watch is routinely a
     hundred thousand points, and the recursion on a nearly-straight one of
     those is deep enough to end the call stack. */
  function simplify(points, tolerance) {
    if (points.length < 3) return points.map((_, i) => i);

    const φ0 = points[0].lat * RAD;
    const kx = Math.cos(φ0) * R * RAD;
    const ky = R * RAD;
    const x = new Float64Array(points.length);
    const y = new Float64Array(points.length);
    for (let i = 0; i < points.length; i++) {
      x[i] = points[i].lon * kx;
      y[i] = points[i].lat * ky;
    }

    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    const limit = tolerance * tolerance;

    while (stack.length) {
      const [first, last] = stack.pop();
      if (last - first < 2) continue;

      const ax = x[first], ay = y[first];
      const dx = x[last] - ax, dy = y[last] - ay;
      const span = dx * dx + dy * dy;

      let worst = 0, at = -1;
      for (let i = first + 1; i < last; i++) {
        const px = x[i] - ax, py = y[i] - ay;
        let d2;
        if (span === 0) {
          d2 = px * px + py * py;
        } else {
          // Projection onto the segment, clamped to it, so a point beyond
          // either end measures to the end rather than to the infinite line.
          const t = Math.max(0, Math.min(1, (px * dx + py * dy) / span));
          const ex = px - t * dx, ey = py - t * dy;
          d2 = ex * ex + ey * ey;
        }
        if (d2 > worst) { worst = d2; at = i; }
      }

      if (worst > limit && at > 0) {
        keep[at] = 1;
        stack.push([first, at], [at, last]);
      }
    }

    const indices = [];
    for (let i = 0; i < points.length; i++) if (keep[i]) indices.push(i);
    return indices;
  }

  /* --- turns --------------------------------------------------------------- */

  const CLASSES = [
    { at: 160, type: "u-turn", word: "Turn around" },
    { at: 115, type: "sharp", word: "Sharp" },
    { at: 45, type: "turn", word: "Turn" },
    { at: 23, type: "slight", word: "Bear" },
  ];

  function classify(angle) {
    const size = Math.abs(angle);
    for (const c of CLASSES) if (size >= c.at) return c;
    return null;
  }

  /* The direction of travel at a point, measured over a window rather than
     between neighbouring vertices. A GPS fix wanders by a few metres, so the
     bearing from one sample to the next on a straight road is noise; taken
     between points fifty metres apart it is the road. The window shrinks near
     the ends of the path and where the vertices are sparse. */
  function bearingAt(points, dist, index, span, forward) {
    const target = dist[index] + (forward ? span : -span);
    let i = index;
    if (forward) {
      while (i < points.length - 1 && dist[i] < target) i++;
    } else {
      while (i > 0 && dist[i] > target) i--;
    }
    if (i === index) i += forward ? 1 : -1;
    if (i < 0 || i > points.length - 1) return null;
    return forward ? bearing(points[index], points[i]) : bearing(points[i], points[index]);
  }

  /* Every place the path changes direction by enough to be worth saying.

     Two passes. The first measures a turn angle at every vertex of the
     simplified path. The second keeps only the local peaks: a junction taken
     at speed spreads across several vertices, and without this a single left
     turn arrives on the sheet three times with a different fraction of the
     angle each. The peak carries the sum of what its neighbours were holding,
     which is what makes a 90° corner rounded off by the recorder still read
     as 90°. */
  function findTurns(points, dist, options) {
    const window = options.window;
    const spacing = options.spacing;
    const floor = options.floor;

    const raw = [];
    for (let i = 1; i < points.length - 1; i++) {
      const inBearing = bearingAt(points, dist, i, window, false);
      const outBearing = bearingAt(points, dist, i, window, true);
      if (inBearing === null || outBearing === null) continue;
      const angle = turnAngle(inBearing, outBearing);
      if (Math.abs(angle) < floor) continue;
      raw.push({ index: i, angle, inBearing, outBearing });
    }

    // Cluster anything closer together than `spacing` and keep the sharpest of
    // each cluster, at the total angle the cluster turned through. Consecutive
    // turns in the same direction are one corner sampled badly; opposite
    // directions are a chicane and stay separate.
    const turns = [];
    let cluster = [];
    const flush = () => {
      if (!cluster.length) return;
      let best = cluster[0];
      let total = 0;
      for (const t of cluster) {
        total += t.angle;
        if (Math.abs(t.angle) > Math.abs(best.angle)) best = t;
      }
      // A cluster that doubles back on itself sums to less than its sharpest
      // member turned; the sharpest member is then the honest answer.
      const angle = Math.abs(total) >= Math.abs(best.angle) ? total : best.angle;
      turns.push({
        index: best.index,
        angle: Math.max(-180, Math.min(180, angle)),
        inBearing: cluster[0].inBearing,
        outBearing: cluster[cluster.length - 1].outBearing,
      });
      cluster = [];
    };

    for (const t of raw) {
      const last = cluster[cluster.length - 1];
      if (last && dist[t.index] - dist[last.index] <= spacing && Math.sign(t.angle) === Math.sign(last.angle)) {
        cluster.push(t);
      } else {
        flush();
        cluster = [t];
      }
    }
    flush();

    return turns.filter((t) => classify(t.angle));
  }

  /* --- elevation ----------------------------------------------------------- */

  /* Barometric and GPS altitude both drift, and summing every rise between
     consecutive samples turns a flat ride into a mountain stage. The usual fix
     is hysteresis: hold the last confirmed extreme, and only bank a climb once
     the path has risen `threshold` above it. Three metres is the figure most
     head units settle on. */
  function elevation(points, threshold) {
    let gain = 0, loss = 0, min = Infinity, max = -Infinity;
    let anchor = null, direction = 0, seen = 0;

    for (const p of points) {
      if (!Number.isFinite(p.ele)) continue;
      seen++;
      if (p.ele < min) min = p.ele;
      if (p.ele > max) max = p.ele;
      if (anchor === null) { anchor = p.ele; continue; }

      const delta = p.ele - anchor;
      if (direction >= 0 && delta >= threshold) { gain += delta; anchor = p.ele; direction = 1; }
      else if (direction <= 0 && delta <= -threshold) { loss -= delta; anchor = p.ele; direction = -1; }
      else if ((direction > 0 && delta < 0) || (direction < 0 && delta > 0)) {
        // Moving against the run in progress: shift the anchor to the new
        // extreme without banking anything, so the threshold is measured from
        // the turning point rather than from where the run began.
        if (Math.abs(delta) >= threshold) { anchor = p.ele; direction = 0; }
        else anchor = direction > 0 ? Math.max(anchor, p.ele) : Math.min(anchor, p.ele);
      }
    }

    if (!seen) return null;
    return { gain, loss, min, max, samples: seen };
  }

  /* --- Web Mercator --------------------------------------------------------- */

  /* The projection every tile server uses, so the route and the tiles under it
     agree by construction. One unit is one pixel at the given zoom, with 256
     of them to a tile. */

  const project = (lat, lon, zoom) => {
    const scale = 256 * Math.pow(2, zoom);
    const φ = Math.max(-85.05112878, Math.min(85.05112878, lat)) * RAD;
    return {
      x: ((lon + 180) / 360) * scale,
      y: (0.5 - Math.log(Math.tan(φ) + 1 / Math.cos(φ)) / (2 * Math.PI)) * scale,
    };
  };

  const unproject = (x, y, zoom) => {
    const scale = 256 * Math.pow(2, zoom);
    return {
      lon: (x / scale) * 360 - 180,
      lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale))) * DEG),
    };
  };

  // Metres per pixel at a latitude and zoom — what the scale bar is drawn from.
  const resolution = (lat, zoom) =>
    (Math.cos(lat * RAD) * 2 * Math.PI * 6378137) / (256 * Math.pow(2, zoom));

  /* The zoom at which a bounding box fills a panel. Fractional, because the
     drawing does not care; the tile layer rounds it down to an integer of its
     own and lives with the slack, which is the only way to get tiles that are
     not resampled. */
  function fit(box, width, height, padding) {
    const w = Math.max(1, width - padding * 2);
    const h = Math.max(1, height - padding * 2);

    let zoom = 19;
    for (let z = 19; z >= 0; z -= 0.05) {
      const a = project(box.north, box.west, z);
      const b = project(box.south, box.east, z);
      if (Math.abs(b.x - a.x) <= w && Math.abs(b.y - a.y) <= h) { zoom = z; break; }
      zoom = 0;
    }

    const centre = {
      lat: (box.north + box.south) / 2,
      lon: (box.east + box.west) / 2,
    };
    return { zoom, centre };
  }

  // Everything a panel needs to turn a coordinate into a point on the paper.
  function view(box, width, height, padding, maxZoom) {
    const fitted = fit(box, width, height, padding);
    const zoom = Math.min(fitted.zoom, maxZoom === undefined ? 19 : maxZoom);
    const middle = project(fitted.centre.lat, fitted.centre.lon, zoom);
    const originX = middle.x - width / 2;
    const originY = middle.y - height / 2;

    return {
      zoom,
      centre: fitted.centre,
      width, height, originX, originY,
      metresPerPixel: resolution(fitted.centre.lat, zoom),
      to(lat, lon) {
        const p = project(lat, lon, zoom);
        return { x: p.x - originX, y: p.y - originY };
      },
      corners() {
        const nw = unproject(originX, originY, zoom);
        const se = unproject(originX + width, originY + height, zoom);
        return { north: nw.lat, west: nw.lon, south: se.lat, east: se.lon };
      },
    };
  }

  // A box grown by a fraction of its own size, so a route never touches the
  // frame it is drawn in. Degenerate boxes — a single point, or a route due
  // north — are given a floor so the fit does not divide by nothing.
  function pad(box, fraction, floorMetres) {
    const midLat = (box.north + box.south) / 2;
    const latFloor = (floorMetres || 0) / 111320;
    const lonFloor = latFloor / Math.max(0.05, Math.cos(midLat * RAD));
    const dLat = Math.max((box.north - box.south) * fraction, latFloor);
    const dLon = Math.max((box.east - box.west) * fraction, lonFloor);
    return {
      north: Math.min(85, box.north + dLat),
      south: Math.max(-85, box.south - dLat),
      east: Math.min(180, box.east + dLon),
      west: Math.max(-180, box.west - dLon),
    };
  }

  /* --- units ---------------------------------------------------------------- */

  const UNITS = {
    metric: {
      long: (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`),
      short: (m) => (m < 1000 ? `${round(m, 10)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`),
      height: (m) => `${Math.round(m)} m`,
      scale: 1, scaleUnit: "m", scaleBig: 1000, scaleBigUnit: "km",
    },
    imperial: {
      long: (m) => {
        const miles = m / 1609.344;
        return miles < 0.19 ? `${Math.round(m * 3.28084)} ft` : `${miles.toFixed(miles < 10 ? 2 : 1)} mi`;
      },
      short: (m) => {
        const miles = m / 1609.344;
        return miles < 0.19 ? `${round(m * 3.28084, 10)} ft` : `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
      },
      height: (m) => `${Math.round(m * 3.28084)} ft`,
      scale: 3.28084, scaleUnit: "ft", scaleBig: 5280, scaleBigUnit: "mi",
    },
  };

  const round = (v, to) => Math.round(v / to) * to;

  // Latitude and longitude as a person would write them down, and as a phone
  // will accept them pasted back in.
  const coord = (lat, lon) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

  Route.geo = {
    distance, bearing, turnAngle, compass, cumulative, bounds,
    simplify, findTurns, classify, elevation,
    project, unproject, resolution, fit, view, pad,
    UNITS, coord, R,
  };

})(globalThis.Route || (globalThis.Route = {}));
