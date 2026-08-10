/* Eclipse Recon — the engine.
   Classical Besselian-element reduction, after Meeus ("Elements of Solar
   Eclipses") and the Explanatory Supplement. Everything works in the
   fundamental plane: the plane through Earth's centre perpendicular to the
   Moon's shadow axis. The elements say where the axis and the two shadow
   cones are; the observer is rotated into that frame and the rest is circle
   geometry.

   Conventions used throughout:
   - time is decimal hours TT on the eclipse day; UT = TT - deltaT/3600
   - longitude is degrees east-positive, latitude degrees north-positive
   - the smooth-limb Moon: no Baily's-beads limb corrections, so contact
     times at the very edge of the band carry a few seconds of uncertainty */

var Bessel = (function () {
  'use strict';

  var RAD = Math.PI / 180;
  var DEG = 180 / Math.PI;
  var FLAT = 1 / 298.26;             // Earth flattening, as the predictions use
  var ONE_F = 1 - FLAT;
  var E2 = FLAT * (2 - FLAT);        // first eccentricity squared
  var EARTH_R = 6378.137;            // equatorial radius, km
  var ROT = 0.00417807;              // degrees of Earth rotation per second

  function poly(c, t) { return ((c[3] * t + c[2]) * t + c[1]) * t + c[0]; }
  function dpoly(c, t) { return (3 * c[3] * t + 2 * c[2]) * t + c[1]; }

  /* Elements and their hourly rates at TT hour t. */
  function elements(ecl, t) {
    var tau = t - ecl.t0;
    return {
      t: t,
      x: poly(ecl.x, tau),   dx: dpoly(ecl.x, tau),
      y: poly(ecl.y, tau),   dy: dpoly(ecl.y, tau),
      d: poly(ecl.d, tau) * RAD,   dd: dpoly(ecl.d, tau) * RAD,
      l1: poly(ecl.l1, tau), dl1: dpoly(ecl.l1, tau),
      l2: poly(ecl.l2, tau), dl2: dpoly(ecl.l2, tau),
      mu: poly(ecl.mu, tau) * RAD, dmu: dpoly(ecl.mu, tau) * RAD
    };
  }

  /* Observer's geocentric coordinates. */
  function geocentric(lat, hMeters) {
    var phi = lat * RAD;
    var u = Math.atan(ONE_F * Math.tan(phi));
    var hR = (hMeters || 0) / (EARTH_R * 1000);
    return {
      rSin: ONE_F * Math.sin(u) + hR * Math.sin(phi),
      rCos: Math.cos(u) + hR * Math.cos(phi)
    };
  }

  /* Observer in the fundamental frame at TT hour t, plus rates. */
  function observer(ecl, el, geo, lonDeg) {
    var H = el.mu + (lonDeg - ROT * ecl.deltaT) * RAD;
    var sinH = Math.sin(H), cosH = Math.cos(H);
    var sinD = Math.sin(el.d), cosD = Math.cos(el.d);
    var xi = geo.rCos * sinH;
    var eta = geo.rSin * cosD - geo.rCos * cosH * sinD;
    var zeta = geo.rSin * sinD + geo.rCos * cosH * cosD;
    return {
      xi: xi, eta: eta, zeta: zeta, H: H,
      dxi: el.dmu * geo.rCos * cosH,
      deta: el.dmu * xi * sinD - zeta * el.dd
    };
  }

  /* One evaluation of the eclipse geometry for an observer at TT hour t. */
  function situation(ecl, t, geo, lonDeg) {
    var el = elements(ecl, t);
    var ob = observer(ecl, el, geo, lonDeg);
    var u = el.x - ob.xi;
    var v = el.y - ob.eta;
    var a = el.dx - ob.dxi;
    var b = el.dy - ob.deta;
    var L1 = el.l1 - ob.zeta * ecl.tanF1;
    var L2 = el.l2 - ob.zeta * ecl.tanF2;
    return {
      el: el, ob: ob, u: u, v: v, a: a, b: b,
      n2: a * a + b * b, m: Math.hypot(u, v), L1: L1, L2: L2
    };
  }

  /* Sun's geometric altitude/azimuth for the observer, using the shadow
     axis as the Sun's direction (they differ by under half an arcminute). */
  function sunAltAz(ecl, t, lat, lonDeg) {
    var el = elements(ecl, t);
    var H = el.mu + (lonDeg - ROT * ecl.deltaT) * RAD;
    var phi = lat * RAD;
    var sinAlt = Math.sin(phi) * Math.sin(el.d) +
                 Math.cos(phi) * Math.cos(el.d) * Math.cos(H);
    var alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;
    var az = Math.atan2(Math.sin(H),
                        Math.cos(H) * Math.sin(phi) -
                        Math.tan(el.d) * Math.cos(phi)) * DEG + 180;
    return { alt: alt, az: ((az % 360) + 360) % 360 };
  }

  /* Saemundsson refraction, degrees, for a geometric altitude in degrees. */
  function refraction(altDeg) {
    if (altDeg < -1.5) return 0;
    return 1.02 / Math.tan((altDeg + 10.3 / (altDeg + 5.11)) * RAD) / 60;
  }

  /* Fraction of the Sun's disc area covered, from the magnitude and the
     local cone radii (classic two-circle lens area). */
  function obscuration(mag, L1, L2) {
    if (mag <= 0) return 0;
    var A = (L1 - L2) / (L1 + L2);        // Moon/Sun apparent size ratio
    if (mag >= 1) return A >= 1 ? 1 : A * A;
    var S = 1 + A - 2 * mag;              // separation, Sun radii
    if (S >= 1 + A) return 0;
    if (S <= A - 1) return 1;
    if (S <= 1 - A) return A * A;
    var c1 = (S * S + 1 - A * A) / (2 * S);
    var c2 = (S * S + A * A - 1) / (2 * S);
    var area = Math.acos(Math.max(-1, Math.min(1, c1))) -
               c1 * Math.sqrt(Math.max(0, 1 - c1 * c1)) +
               A * A * Math.acos(Math.max(-1, Math.min(1, c2 / A))) -
               c2 * Math.sqrt(Math.max(0, A * A - c2 * c2));
    return area / Math.PI;
  }

  /* TT hour of greatest eclipse (axis closest to Earth's centre). */
  function greatestT(ecl) {
    var t = ecl.t0;
    for (var i = 0; i < 4; i++) {
      var el = elements(ecl, t);
      t -= (el.x * el.dx + el.y * el.dy) / (el.dx * el.dx + el.dy * el.dy);
    }
    return t;
  }

  /* Time of maximum eclipse for an observer, by Newton on the separation.
     Returns null when the geometry never closes (no eclipse there). */
  function maximumT(ecl, geo, lonDeg, tGuess) {
    var t = tGuess;
    for (var i = 0; i < 6; i++) {
      var s = situation(ecl, t, geo, lonDeg);
      var step = -(s.u * s.a + s.v * s.b) / s.n2;
      t += step;
      if (Math.abs(step) < 1e-7) break;
    }
    return t;
  }

  /* Contact times around the maximum: solve |u,v| = L by the standard
     tau = -(ua+vb)/n^2 +/- sqrt(L^2 - D^2)/n iteration.
     which: 'L1' for first/last contact, 'L2' for second/third. */
  function contact(ecl, geo, lonDeg, tMax, which, sign) {
    var t = tMax;
    for (var i = 0; i < 8; i++) {
      var s = situation(ecl, t, geo, lonDeg);
      var L = which === 'L1' ? s.L1 : Math.abs(s.L2);
      var n = Math.sqrt(s.n2);
      var D = (s.u * s.b - s.v * s.a) / n;
      var disc = L * L - D * D;
      if (disc < 0) return null;
      var tNew = t - (s.u * s.a + s.v * s.b) / s.n2 + sign * Math.sqrt(disc) / n;
      if (Math.abs(tNew - t) < 1e-8) { t = tNew; break; }
      t = tNew;
    }
    return t;
  }

  function toDate(ecl, tTT) {
    var ut = tTT - ecl.deltaT / 3600;
    return new Date(Date.UTC(ecl.date[0], ecl.date[1] - 1, ecl.date[2]) +
                    ut * 3600000);
  }

  /* Full local circumstances for a site. Null when no eclipse is visible. */
  function localCircumstances(ecl, lat, lonDeg, hMeters) {
    var geo = geocentric(lat, hMeters);
    var tMax = maximumT(ecl, geo, lonDeg, greatestT(ecl));
    // outside the fitted window the polynomials are fiction, and Newton can
    // wander there from a point no eclipse ever touches
    if (!isFinite(tMax) || Math.abs(tMax - ecl.t0) > 5) return null;
    var s = situation(ecl, tMax, geo, lonDeg);
    var mag = (s.L1 - s.m) / (s.L1 + s.L2);
    if (mag <= 0 || !isFinite(mag)) return null;

    var sun = sunAltAz(ecl, tMax, lat, lonDeg);
    var res = {
      tMax: tMax, dateMax: toDate(ecl, tMax),
      magnitude: mag,
      obscuration: obscuration(mag, s.L1, s.L2),
      sunAlt: sun.alt,
      sunAltApparent: sun.alt + refraction(sun.alt),
      sunAz: sun.az,
      type: 'partial', duration: 0,
      c1: null, c2: null, c3: null, c4: null
    };

    var c1 = contact(ecl, geo, lonDeg, tMax, 'L1', -1);
    var c4 = contact(ecl, geo, lonDeg, tMax, 'L1', +1);
    if (c1 !== null) res.c1 = mkContact(ecl, c1, lat, lonDeg);
    if (c4 !== null) res.c4 = mkContact(ecl, c4, lat, lonDeg);

    if (s.m < Math.abs(s.L2)) {
      res.type = s.L2 < 0 ? 'total' : 'annular';
      var c2 = contact(ecl, geo, lonDeg, tMax, 'L2', -1);
      var c3 = contact(ecl, geo, lonDeg, tMax, 'L2', +1);
      if (c2 !== null && c3 !== null) {
        res.c2 = mkContact(ecl, c2, lat, lonDeg);
        res.c3 = mkContact(ecl, c3, lat, lonDeg);
        res.duration = (c3 - c2) * 3600;
        // the anti-shadow: the cone's geometry also closes for observers on
        // the night side, where no physical umbra ever stands. A central
        // phase entirely below the horizon is that phantom, and everything
        // that draws or scores the band must know it.
        var midAlt = sunAltAz(ecl, (c2 + c3) / 2, lat, lonDeg).alt;
        res.centralVisible = midAlt > -0.9;
      }
    }
    // is any of it above the horizon? (refraction allowance at rise/set)
    var vis = false;
    var t1 = res.c1 ? res.c1.tTT : tMax, t2 = res.c4 ? res.c4.tTT : tMax;
    for (var i = 0; i <= 8; i++) {
      var alt = sunAltAz(ecl, t1 + (t2 - t1) * i / 8, lat, lonDeg).alt;
      if (alt > -0.9) { vis = true; break; }
    }
    res.visible = vis;
    return res;
  }

  function mkContact(ecl, tTT, lat, lonDeg) {
    var sun = sunAltAz(ecl, tTT, lat, lonDeg);
    return { tTT: tTT, date: toDate(ecl, tTT), alt: sun.alt, az: sun.az };
  }

  /* --- the path on the ground ------------------------------------------ */

  /* Point on the ellipsoid under fundamental-plane coordinates (x, y),
     or null when the axis misses the Earth. Works in coordinates flattened
     to a sphere: y1 = y/rho1, then back to geodetic. */
  function groundPoint(ecl, el, px, py) {
    var sinD = Math.sin(el.d), cosD = Math.cos(el.d);
    var rho1 = Math.sqrt(1 - E2 * cosD * cosD);
    var sinD1 = sinD / rho1;
    var cosD1 = Math.sqrt(1 - E2) * cosD / rho1;
    var y1 = py / rho1;
    var B2 = 1 - px * px - y1 * y1;
    if (B2 < 0) return null;
    var B = Math.sqrt(B2);
    var sinPhi1 = y1 * cosD1 + B * sinD1;
    var cosPhi1 = Math.sqrt(Math.max(0, 1 - sinPhi1 * sinPhi1));
    var theta = Math.atan2(px, B * cosD1 - y1 * sinD1);
    var lat = Math.atan2(sinPhi1, cosPhi1 * Math.sqrt(1 - E2)) * DEG;
    var lon = (theta - el.mu) * DEG + ROT * ecl.deltaT;
    lon = ((lon + 540) % 360) - 180;
    return { lat: lat, lon: lon, B: B };
  }

  function centralPointAt(ecl, t) {
    var el = elements(ecl, t);
    return groundPoint(ecl, el, el.x, el.y);
  }

  /* Umbral (or penumbral) outline on the ground at TT hour t. Where the
     cone slides off the limb the outline is clipped to the terminator.
     cone: 'umbra' | 'penumbra'. Returns array of {lat, lon} or null. */
  function shadowOutline(ecl, t, cone, steps) {
    var el = elements(ecl, t);
    var tanF = cone === 'penumbra' ? ecl.tanF1 : ecl.tanF2;
    var l0 = cone === 'penumbra' ? el.l1 : el.l2;
    var N = steps || 72;
    var pts = [];
    var center = groundPoint(ecl, el, el.x, el.y);
    for (var i = 0; i < N; i++) {
      var psi = 2 * Math.PI * i / N;
      var cs = Math.cos(psi), sn = Math.sin(psi);
      // iterate the local cone radius against the surface height
      var zeta = center ? center.B : 0;
      var p = null;
      for (var k = 0; k < 3; k++) {
        var r = Math.abs(l0 - zeta * tanF);
        var q = groundPoint(ecl, el, el.x + r * cs, el.y + r * sn);
        if (!q) {
          // slid off the limb: clip the ray to the unit circle (terminator)
          q = limbPoint(ecl, el, el.x, el.y, r * cs, r * sn);
          if (!q) break;
          p = q; break;
        }
        p = q; zeta = q.B;
      }
      if (p) pts.push({ lat: p.lat, lon: p.lon });
    }
    return pts.length > 2 ? pts : null;
  }

  /* Intersection of the segment (cx,cy)->(cx+dx,cy+dy) with the unit circle
     in flattened coordinates, mapped to the ground (a terminator point). */
  function limbPoint(ecl, el, cx, cy, dx, dy) {
    var rho1 = Math.sqrt(1 - E2 * Math.cos(el.d) * Math.cos(el.d));
    var x0 = cx, y0 = cy / rho1, vx = dx, vy = dy / rho1;
    var A = vx * vx + vy * vy;
    var Bq = 2 * (x0 * vx + y0 * vy);
    var C = x0 * x0 + y0 * y0 - 1;
    var disc = Bq * Bq - 4 * A * C;
    if (disc < 0) return null;
    var s = (-Bq + Math.sqrt(disc)) / (2 * A);
    if (s < 0) return null;
    return groundPoint(ecl, el, cx + s * vx, (y0 + s * vy) * rho1);
  }

  /* Central path with limits, sampled every stepSec of TT.
     Returns { center: [...], north: [...], south: [...] } where a centre
     sample carries time, duration and Sun altitude. */
  function centralPath(ecl, stepSec) {
    var step = (stepSec || 60) / 3600;
    var center = [], north = [], south = [];
    var mainPairs = [];
    var t0 = greatestT(ecl);
    // walk both directions until the axis leaves the Earth
    var range = [];
    for (var t = t0; t > t0 - 4; t -= step) {
      if (!centralPointAt(ecl, t)) break;
      range.unshift(t);
    }
    for (t = t0 + step; t < t0 + 4; t += step) {
      if (!centralPointAt(ecl, t)) break;
      range.push(t);
    }
    for (var i = 0; i < range.length; i++) {
      t = range[i];
      var el = elements(ecl, t);
      var c = centralPointAt(ecl, t);
      if (!c) continue;
      var sun = sunAltAz(ecl, t, c.lat, c.lon);
      var geo = geocentric(c.lat, 0);
      var sit = situation(ecl, t, geo, c.lon);
      var n = Math.sqrt(sit.n2);
      // duration straight from the local cone: 2*|L2|/n hours
      var dur = n > 0 ? 2 * Math.abs(sit.L2) / n * 3600 : 0;
      var entry = {
        tTT: t, date: toDate(ecl, t), lat: c.lat, lon: c.lon,
        sunAlt: sun.alt, sunAz: sun.az, duration: dur
      };
      // limits: the axis displaced perpendicular to its own motion by the
      // umbral radius, in the fundamental plane, then mapped to ground —
      // the definition of the published limit curves. Reading extremes off
      // the ground outline instead breaks at low Sun, where the outline is
      // a sliver hundreds of kilometres long: the 2026 tail drew an 800 km
      // edge over a 290 km band and the polygon folded over itself.
      var lim = bandLimits(ecl, t, c);
      if (lim) {
        north.push(lim.n); south.push(lim.s);
        entry.widthKm = lim.width;
        mainPairs.push({ c: entry, n: lim.n, s: lim.s });
      }
      center.push(entry);
    }

    /* The band does not end where the axis leaves the Earth: the umbra is
       a wide low-Sun ellipse by then, and it keeps grazing the ground for
       minutes more — the 2026 path covers the Balearics entirely inside
       that cap, at totality durations over a minute. Both caps are walked
       with the axis projected onto the disc's rim standing in for the
       centre, which continues the track smoothly where the axis itself
       has left. */
    function cap(dir) {
      if (!center.length) return;
      var edgeIdx = dir > 0 ? center.length - 1 : 0;
      var prev = { lat: center[edgeIdx].lat, lon: center[edgeIdx].lon };
      var tEdge = center[edgeIdx].tTT;
      for (var s2 = 1; s2 <= 90; s2++) {
        var t2 = tEdge + dir * s2 * step;
        var c2 = limbCentre(ecl, t2);
        if (!c2) break;
        var lim2 = bandLimits(ecl, t2, c2);
        // gone once no rail touches and the rim point is out of the shadow
        if (!lim2 || (!lim2.nOn && !lim2.sOn && !lim2.live)) break;
        prev = c2;
        var sun2 = sunAltAz(ecl, t2, c2.lat, c2.lon);
        var geo2 = geocentric(c2.lat, 0);
        var sit2 = situation(ecl, t2, geo2, c2.lon);
        var n2 = Math.sqrt(sit2.n2);
        var entry2 = {
          tTT: t2, date: toDate(ecl, t2), lat: c2.lat, lon: c2.lon,
          sunAlt: sun2.alt, sunAz: sun2.az, widthKm: lim2.width,
          duration: n2 > 0 ? 2 * Math.abs(sit2.L2) / n2 * 3600 : 0
        };
        if (dir > 0) {
          center.push(entry2); north.push(lim2.n); south.push(lim2.s);
        } else {
          center.unshift(entry2); north.unshift(lim2.n); south.unshift(lim2.s);
        }
      }
    }
    // the drawn ring wants the exact main-path rails only; the graze walk
    // below extends the sampling frame, not the outline
    var mainN = north.slice(), mainS = south.slice();
    var mainC = center.slice();

    cap(+1);
    cap(-1);

    /* The rails are exact limit curves, but a band's END is not where they
       converge: it is a sunrise/sunset contact arc that bulges past them —
       the 2026 band reaches Menorca east of everything the rails trace,
       because totality there ran out before the shadow's last ground
       contact further west. Rather than derive the set curves, each end is
       closed by asking the engine itself: a fan of bearings from the last
       on-axis centre — safely inside, and seeing the whole rounded cap —
       swept rail to rail through the outward direction, each ray bisected
       against the localCircumstances oracle. The fan IS the boundary, to a
       kilometre. */
    function isCentral(lat, lon) {
      var lc = localCircumstances(ecl, lat, lon, 0);
      return !!(lc && lc.type !== 'partial' && lc.c2 && lc.c3 &&
                lc.centralVisible);
    }
    /* March along the oracle's own contour: from a rail end, probe ahead
       at a fixed step, preferring to go straight, turning as the boundary
       turns; each accepted step is refined onto the contour by bisecting
       across it. Cusps, lobes, whatever shape the cap takes — the marcher
       follows it, which no fan from any single origin can promise. The
       band is kept on the RIGHT of the direction of travel throughout. */
    function traceBoundary(startPt, heading, target, stepKm, awayFrom) {
      var P = startPt, h = heading;
      var pts = [];
      var TURNS = [0, -20, 20, -40, 40, -60, 60, -85, 85, -110, 110];
      // the first step self-orients: scan the whole circle, and refuse any
      // step that walks back toward the rail we came from
      var FIRST = [0, -20, 20, -40, 40, -60, 60, -80, 80, -100, 100,
                   -120, 120, -140, 140, -160, 160, 180];
      for (var i2 = 0; i2 < 140; i2++) {
        var found = null, hNew = h;
        var SCAN = i2 === 0 ? FIRST : TURNS;
        for (var ti = 0; ti < SCAN.length; ti++) {
          var hh = h + SCAN[ti] * RAD;
          var Q = destination(P.lat, P.lon, hh * DEG, stepKm);
          // does the local normal straddle the contour here?
          var span = stepKm * 1.3;
          var inP = destination(Q.lat, Q.lon, (hh + Math.PI / 2) * DEG, span);
          var outP = destination(Q.lat, Q.lon, (hh - Math.PI / 2) * DEG, span);
          if (!isCentral(inP.lat, inP.lon) || isCentral(outP.lat, outP.lon)) {
            continue;
          }
          // bisect across the contour along that normal
          var lo2 = -span, hi2 = span;   // +: inside direction
          for (var it2 = 0; it2 < 14; it2++) {
            var mid = (lo2 + hi2) / 2;
            var M = destination(Q.lat, Q.lon, (hh + Math.PI / 2) * DEG, mid);
            if (isCentral(M.lat, M.lon)) hi2 = mid; else lo2 = mid;
          }
          var cand = destination(Q.lat, Q.lon, (hh + Math.PI / 2) * DEG,
                                 (lo2 + hi2) / 2);
          if (i2 === 0 && awayFrom &&
              distKm(cand.lat, cand.lon, awayFrom.lat, awayFrom.lon) <
              distKm(P.lat, P.lon, awayFrom.lat, awayFrom.lon)) {
            continue;              // that way lies the rail we came from
          }
          found = cand;
          hNew = hh;
          break;
        }
        if (!found) break;
        pts.push(found);
        h = bearing(P.lat, P.lon, found.lat, found.lon);
        P = found;
        if (distKm(P.lat, P.lon, target.lat, target.lon) < stepKm * 1.5) break;
      }
      return pts;
    }

    /* The ring: rails through the middle, marched caps at the ends. A
       rail index is kept only while its point verifiably sits ON the
       observable boundary (outward feeler dark, inward feeler central) —
       near a sunrise/sunset end the geometric rails dive INSIDE the
       observable band, where they are no boundary at all. From the last
       good index on each side the marcher takes over and rounds the whole
       end region, whatever its shape. */
    var ring = [];
    function onObservable(pr, key) {
      var e = pr[key], c0 = pr.c;
      var bOut = bearing(c0.lat, c0.lon, e.lat, e.lon) * DEG;
      var out = destination(e.lat, e.lon, bOut, 25);
      var inn = destination(e.lat, e.lon,
        bearing(e.lat, e.lon, c0.lat, c0.lon) * DEG, 25);
      return !isCentral(out.lat, out.lon) && isCentral(inn.lat, inn.lon);
    }
    var M = mainPairs.length;
    if (M > 12) {
      var kEnd = M - 1;
      while (kEnd > M * 0.5 &&
             !(onObservable(mainPairs[kEnd], 'n') &&
               onObservable(mainPairs[kEnd], 's'))) kEnd--;
      kEnd = Math.max(6, kEnd - 2);
      var kStart = 0;
      while (kStart < M * 0.5 &&
             !(onObservable(mainPairs[kStart], 'n') &&
               onObservable(mainPairs[kStart], 's'))) kStart++;
      kStart = Math.min(kEnd - 4, kStart + 2);
      if (kStart >= 0 && kEnd > kStart + 3) {
        var pairs = mainPairs.slice(kStart, kEnd + 1);
        var P0 = pairs.length;
        var STEP = 18;
        var hEnd = bearing(pairs[P0 - 2].n.lat, pairs[P0 - 2].n.lon,
                           pairs[P0 - 1].n.lat, pairs[P0 - 1].n.lon);
        var capEnd = traceBoundary(pairs[P0 - 1].n, hEnd,
                                   pairs[P0 - 1].s, STEP,
                                   pairs[Math.max(0, P0 - 8)].n);
        var hStart = bearing(pairs[1].s.lat, pairs[1].s.lon,
                             pairs[0].s.lat, pairs[0].s.lon);
        var capStart = traceBoundary(pairs[0].s, hStart, pairs[0].n, STEP,
                                     pairs[Math.min(P0 - 1, 7)].s);
        ring = pairs.map(function (x) { return x.n; })
          .concat(capEnd)
          .concat(pairs.map(function (x) { return x.s; }).reverse())
          .concat(capStart);
      }
    }
    if (!ring.length && mainN.length > 2) {
      ring = mainN.concat(mainS.slice().reverse());
    }

    return { center: center, north: north, south: south, ring: ring };
  }

  /* Where the axis misses the ground: the nearest point of the disc to it,
     mapped to the ground — the track's natural continuation into the caps. */
  function limbCentre(ecl, t) {
    var el = elements(ecl, t);
    var onDisc = groundPoint(ecl, el, el.x, el.y);
    if (onDisc) return onDisc;
    var rho1 = Math.sqrt(1 - E2 * Math.cos(el.d) * Math.cos(el.d));
    var u = el.x, v = el.y / rho1;
    var h = Math.hypot(u, v);
    if (!h) return null;
    var s = 0.9995 / h;
    return groundPoint(ecl, el, u * s, v * s * rho1);
  }

  /* The umbral limit curves, from the elements themselves: the axis
     displaced by the local umbral radius perpendicular to the shadow's
     motion — motion RELATIVE TO THE GROUND, the (a, b) the contact solver
     already uses, because the band is traced on a rotating Earth and the
     fixed-frame direction is wrong exactly where it matters, at low Sun.
     Displacements iterate against the surface height and map to ground.
     Where a displaced point has slid off the disc it is clamped to the rim
     (flagged off), so the rails keep following the limb through the caps
     until the whole band is gone. */
  function bandLimits(ecl, t, near) {
    var el = elements(ecl, t);
    // relative velocity at the nearest ground point the caller knows of;
    // fall back to the sub-axis point of the disc
    var at = near || limbCentre(ecl, t);
    if (!at) return null;
    var sit = situation(ecl, t, geocentric(at.lat, 0), at.lon);
    var n = Math.sqrt(sit.n2);
    if (!n) return null;
    var nx = -sit.b / n, ny = sit.a / n;   // left of motion: the north side
    var rho1 = Math.sqrt(1 - E2 * Math.cos(el.d) * Math.cos(el.d));
    function rail(sign) {
      var zeta = at.B || 0, q = null;
      for (var k = 0; k < 4; k++) {
        var r = Math.abs(el.l2 - zeta * ecl.tanF2);
        var q2 = groundPoint(ecl, el, el.x + sign * nx * r, el.y + sign * ny * r);
        if (!q2) break;
        q = q2; zeta = q2.B;
      }
      if (q) return { p: q, on: true };
      var r0 = Math.abs(el.l2);
      var u = el.x + sign * nx * r0, v = (el.y + sign * ny * r0) / rho1;
      var h = Math.hypot(u, v);
      if (!h) return null;
      var sc = 0.9995 / h;
      var rim = groundPoint(ecl, el, u * sc, v * sc * rho1);
      return rim ? { p: rim, on: false } : null;
    }
    var N = rail(+1), S = rail(-1);
    if (!N || !S) return null;
    return {
      n: N.p, s: S.p, nOn: N.on, sOn: S.on,
      // does the reference point itself still stand in the central shadow?
      live: sit.m < Math.abs(sit.L2),
      width: distKm(N.p.lat, N.p.lon, S.p.lat, S.p.lon)
    };
  }

  /* great-circle helpers (km, degrees) */
  function bearing(lat1, lon1, lat2, lon2) {
    var p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
    return Math.atan2(Math.sin(dl) * Math.cos(p2),
      Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  }
  function distKm(lat1, lon1, lat2, lon2) {
    var p1 = lat1 * RAD, p2 = lat2 * RAD;
    var dp = p2 - p1, dl = (lon2 - lon1) * RAD;
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  /* signed cross-track distance of P from the great circle through A with
     bearing brg; positive to the left of travel (which is geographic north
     of an eastbound track) */
  function crossTrack(latA, lonA, brg, latP, lonP) {
    var d13 = distKm(latA, lonA, latP, lonP) / 6371;
    var b13 = bearing(latA, lonA, latP, lonP);
    return -Math.asin(Math.sin(d13) * Math.sin(b13 - brg)) * 6371;
  }
  function destination(lat, lon, brgDeg, dKm) {
    var d = dKm / 6371, b = brgDeg * RAD, p1 = lat * RAD, l1 = lon * RAD;
    var p2 = Math.asin(Math.sin(p1) * Math.cos(d) +
                       Math.cos(p1) * Math.sin(d) * Math.cos(b));
    var l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1),
                             Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 * DEG, lon: ((l2 * DEG + 540) % 360) - 180 };
  }

  /* Quick maximum obscuration for a site — the raster workhorse.
     Returns null if no eclipse or the whole event is below the horizon. */
  function quickMax(ecl, lat, lonDeg, tGE) {
    var geo = geocentric(lat, 0);
    var t = maximumT(ecl, geo, lonDeg, tGE);
    if (!isFinite(t) || Math.abs(t - ecl.t0) > 5) return null;
    var s = situation(ecl, t, geo, lonDeg);
    var mag = (s.L1 - s.m) / (s.L1 + s.L2);
    if (mag <= 0) return null;
    var alt = sunAltAz(ecl, t, lat, lonDeg).alt;
    if (alt < -0.9) return null;   // eclipse happens, but below the horizon
    return {
      mag: mag,
      obsc: obscuration(mag, s.L1, s.L2),
      total: s.m < Math.abs(s.L2) && s.L2 < 0,
      alt: alt
    };
  }

  /* Subsolar point at TT hour t (for the day/night terminator). */
  function subsolar(ecl, t) {
    var el = elements(ecl, t);
    var lon = -(el.mu * DEG - ROT * ecl.deltaT);
    return { lat: el.d * DEG, lon: ((lon + 540) % 360) - 180 };
  }

  /* Global event summary: P1/U1/greatest/U4/P4 in one object. */
  function globalTimes(ecl) {
    var tGE = greatestT(ecl);
    var el = elements(ecl, tGE);
    var gamma = Math.hypot(el.x, el.y) * (el.y >= 0 ? 1 : -1);
    var ge = centralPointAt(ecl, tGE);
    // first/last touch of a shadow cone with the Earth: bisect on
    // |axis distance| = 1 + l, outward from greatest eclipse
    function touch(lc, sign) {
      var f = function (t) {
        var e = elements(ecl, t);
        return Math.hypot(e.x, e.y) - (1 + poly(lc, t - ecl.t0));
      };
      var a = tGE, b = tGE + sign * 6;
      if (f(a) > 0) return null;              // already outside at greatest
      var lo = a, hi = b;
      for (var i = 0; i < 60; i++) {
        var mid = (lo + hi) / 2;
        if (f(mid) <= 0) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    }
    var res = {
      tGE: tGE, dateGE: toDate(ecl, tGE), gamma: gamma,
      latGE: ge ? ge.lat : null, lonGE: ge ? ge.lon : null,
      p1: touch(ecl.l1, -1), p4: touch(ecl.l1, +1),
      u1: touch(ecl.l2, -1), u4: touch(ecl.l2, +1)
    };
    ['p1', 'p4', 'u1', 'u4'].forEach(function (k) {
      res[k + 'Date'] = res[k] !== null ? toDate(ecl, res[k]) : null;
    });
    if (ge) {
      var lc = localCircumstances(ecl, ge.lat, ge.lon, 0);
      res.maxDuration = lc ? lc.duration : 0;
      res.magGE = lc ? lc.magnitude : 0;
      // Moon/Sun apparent diameter ratio at greatest — the "magnitude"
      // headline number the NASA bulletins print
      var sit = situation(ecl, tGE, geocentric(ge.lat, 0), ge.lon);
      res.ratioGE = (sit.L1 - sit.L2) / (sit.L1 + sit.L2);
    }
    return res;
  }

  return {
    elements: elements,
    localCircumstances: localCircumstances,
    sunAltAz: sunAltAz,
    refraction: refraction,
    greatestT: greatestT,
    centralPointAt: centralPointAt,
    shadowOutline: shadowOutline,
    centralPath: centralPath,
    quickMax: quickMax,
    subsolar: subsolar,
    globalTimes: globalTimes,
    toDate: toDate,
    distKm: distKm,
    bearing: bearing,
    destination: destination
  };
})();

if (typeof module !== 'undefined') module.exports = Bessel;
