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
      // limits: outline extremes of signed cross-track distance on the
      // ground, using the local track bearing from neighbouring centres
      var out = shadowOutline(ecl, t, 'umbra', 40);
      if (out) {
        var next = centralPointAt(ecl, t + step) || c;
        var brg = bearing(c.lat, c.lon, next.lat, next.lon);
        var bestD = -1e9, worstD = 1e9, bp = null, wp = null;
        for (var j = 0; j < out.length; j++) {
          var dxt = crossTrack(c.lat, c.lon, brg, out[j].lat, out[j].lon);
          if (dxt > bestD) { bestD = dxt; bp = out[j]; }
          if (dxt < worstD) { worstD = dxt; wp = out[j]; }
        }
        if (bp && wp) {
          north.push(bp); south.push(wp);
          entry.widthKm = Math.abs(bestD) + Math.abs(worstD);
        }
      }
      center.push(entry);
    }
    return { center: center, north: north, south: south };
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
