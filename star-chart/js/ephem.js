/* The moving bodies. Everything here returns apparent geocentric right
   ascension and declination for the equinox of date, which is the same frame
   the stars arrive in, so the map can draw them side by side without knowing
   which is which.

   Depends on Astro and EphemData. No DOM; runs under node. */
var Ephem = (function (Astro, Data) {
  'use strict';

  var RAD = Astro.RAD, DEG = Astro.DEG, ARCSEC = Astro.ARCSEC;
  var AU_KM = 149597870.7;
  var LIGHT_DAYS_PER_AU = 0.0057755183;

  /* Equatorial semidiameter at one astronomical unit, arcsec. */
  var SEMI = {
    mercury: 3.36, venus: 8.34, mars: 4.68, jupiter: 98.44,
    saturn: 82.73, uranus: 35.02, neptune: 33.50
  };
  var KEY = {
    mercury: 'mer', venus: 'ven', earth: 'ear', mars: 'mar',
    jupiter: 'jup', saturn: 'sat', uranus: 'ura', neptune: 'nep'
  };
  var ORDER = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

  /* Sum one VSOP87 variable: series in powers of tau, each a flat run of
     amplitude, phase, frequency. */
  function sumSeries(blocks, tau) {
    var total = 0, power = 1;
    for (var k = 0; k < blocks.length; k++) {
      var flat = blocks[k], s = 0;
      for (var i = 0; i < flat.length; i += 3) {
        s += flat[i] * Math.cos(flat[i + 1] + flat[i + 2] * tau);
      }
      total += s * power;
      power *= tau;
    }
    return total;
  }

  /* Heliocentric ecliptic of date. */
  function heliocentric(name, tau) {
    var b = Data.vsop[KEY[name]];
    return { lon: sumSeries(b[0], tau), lat: sumSeries(b[1], tau), r: sumSeries(b[2], tau) };
  }

  function toRect(p) {
    var cb = Math.cos(p.lat);
    return [p.r * cb * Math.cos(p.lon), p.r * cb * Math.sin(p.lon), p.r * Math.sin(p.lat)];
  }

  /* Apparent place from a geocentric ecliptic vector: nutation in longitude,
     aberration, then into equatorial coordinates of date. */
  function apparent(vec, t) {
    var d = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1] + vec[2] * vec[2]);
    var lon = Astro.norm(Math.atan2(vec[1], vec[0]));
    var lat = Math.asin(vec[2] / d);
    var ab = Astro.aberration(lon, lat, t);
    var n = Astro.nutation(t);
    var eq = Astro.eclipticToEquatorial(lon + ab.lon + n.dpsi, lat + ab.lat,
                                        Astro.obliquity(t) + n.deps);
    eq.distance = d;
    eq.lon = Astro.norm(lon + ab.lon + n.dpsi);
    eq.lat = lat + ab.lat;
    return eq;
  }

  function sun(jdTt) {
    var t = Astro.centuries(jdTt), tau = Astro.millennia(jdTt);
    var e = toRect(heliocentric('earth', tau));
    /* The Sun seen from Earth is the Earth seen from the Sun, reversed. There
       is no light-time step here on purpose: the Sun sits at the origin of
       this frame and so does not move while its light is in flight. Stepping
       Earth back instead would displace it by the 20.5" of aberration a
       second time, which is the one mistake this reduction invites. */
    var out = apparent([-e[0], -e[1], -e[2]], t);
    out.semidiameter = (959.63 / out.distance) * ARCSEC;
    out.name = 'Sun';
    out.magnitude = -26.7;
    return out;
  }

  /* ELP2000-82B main problem. The blocks are D, l', l, F, amplitude. */
  function moonEcliptic(jdTt) {
    var t = Astro.centuries(jdTt);
    function poly(c) { var s = 0; for (var i = c.length - 1; i >= 0; i--) s = s * t + c[i]; return s; }
    var W1 = poly([785939.95571, 1732564372.83264, -4.7763, 0.006604, -0.00003169]) * ARCSEC;
    var D = poly([1072260.73512, 1602961601.4603, -6.8498, 0.006595, -0.00003184]) * ARCSEC;
    var lp = poly([1287104.79306, 129596581.0474, -0.5529, 0.000147, 0]) * ARCSEC;
    var l = poly([485868.28096, 1717915923.4728, 32.3893, 0.051651, -0.00024470]) * ARCSEC;
    var F = poly([335779.55755, 1739527263.0983, -12.2505, -0.001021, 0.00000417]) * ARCSEC;

    function sum(flat, cosine) {
      var s = 0;
      for (var i = 0; i < flat.length; i += 5) {
        var arg = flat[i] * D + flat[i + 1] * lp + flat[i + 2] * l + flat[i + 3] * F;
        s += flat[i + 4] * (cosine ? Math.cos(arg) : Math.sin(arg));
      }
      return s;
    }
    return {
      lon: Astro.norm(W1 + sum(Data.moon[0], false) * ARCSEC),
      lat: sum(Data.moon[1], false) * ARCSEC,
      km: sum(Data.moon[2], true)
    };
  }

  function moon(jdTt) {
    var t = Astro.centuries(jdTt);
    var m = moonEcliptic(jdTt);
    var n = Astro.nutation(t);
    /* No aberration: the Moon's light-time is a second and a quarter, and the
       standard reduction folds that into the series itself. */
    var eq = Astro.eclipticToEquatorial(m.lon + n.dpsi, m.lat,
                                        Astro.obliquity(t) + n.deps);
    eq.distance = m.km / AU_KM;
    eq.km = m.km;
    eq.lon = Astro.norm(m.lon + n.dpsi);
    eq.lat = m.lat;
    eq.semidiameter = Math.asin(1737.4 / m.km);
    eq.parallax = Math.asin(6378.14 / m.km);
    eq.name = 'Moon';

    var s = sun(jdTt);
    /* Elongation from the Sun gives the phase angle, and the phase angle gives
       the lit fraction. The sign of the longitude difference says which limb. */
    var elong = Astro.angularSeparation(eq.ra, eq.dec, s.ra, s.dec);
    var phaseAngle = Math.atan2(s.distance * Math.sin(elong),
                                eq.distance - s.distance * Math.cos(elong));
    eq.elongation = elong;
    eq.phaseAngle = phaseAngle;
    eq.illuminated = (1 + Math.cos(phaseAngle)) / 2;
    eq.age = Astro.norm(m.lon - s.lon) / (2 * Math.PI);
    eq.waxing = eq.age < 0.5;
    eq.magnitude = -12.7 + 2.5 * Math.log(1 / Math.max(eq.illuminated, 0.001)) / Math.LN10;
    return eq;
  }

  /* Saturn's rings swing between edge-on and wide open and take the planet
     nearly a magnitude with them, so a chart that ignored them would size the
     dot wrong for years at a time. Meeus 45.1 for the ring plane. */
  function ringBrightening(lon, lat, t) {
    var i = (28.075216 - 0.012998 * t + 0.000004 * t * t) * RAD;
    var om = (169.508470 + 1.394681 * t + 0.000412 * t * t) * RAD;
    var sinB = Math.sin(i) * Math.cos(lat) * Math.sin(lon - om) - Math.cos(i) * Math.sin(lat);
    var B = Math.abs(Math.asin(sinB));
    return -2.60 * Math.sin(B) + 1.25 * Math.sin(B) * Math.sin(B);
  }

  function magnitude(name, r, delta, phaseDeg, lon, lat, t) {
    var base = 5 * Math.log(r * delta) / Math.LN10;
    var i = phaseDeg;
    switch (name) {
      case 'mercury': return -0.42 + base + 0.0380 * i - 0.000273 * i * i + 0.000002 * i * i * i;
      case 'venus': return -4.40 + base + 0.0009 * i + 0.000239 * i * i - 0.00000065 * i * i * i;
      case 'mars': return -1.52 + base + 0.016 * i;
      case 'jupiter': return -9.40 + base + 0.005 * i;
      case 'saturn': return -8.88 + base + ringBrightening(lon, lat, t);
      case 'uranus': return -7.19 + base;
      case 'neptune': return -6.87 + base;
    }
    return 0;
  }

  function planet(name, jdTt) {
    var t = Astro.centuries(jdTt), tau = Astro.millennia(jdTt);
    var earth = toRect(heliocentric('earth', tau));
    /* Light time: solve for where the planet was when the light now arriving
       left it. Two passes settle it to well under an arcsecond. */
    var vec, delta = 0;
    for (var pass = 0; pass < 3; pass++) {
      var p = toRect(heliocentric(name, Astro.millennia(jdTt - delta * LIGHT_DAYS_PER_AU)));
      vec = [p[0] - earth[0], p[1] - earth[1], p[2] - earth[2]];
      delta = Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1] + vec[2] * vec[2]);
    }
    var out = apparent(vec, t);
    var helio = heliocentric(name, tau);
    var r = helio.r;
    var sunDist = Math.sqrt(earth[0] * earth[0] + earth[1] * earth[1] + earth[2] * earth[2]);
    /* Phase angle at the planet, between the Sun and us. */
    var cosPhase = (r * r + delta * delta - sunDist * sunDist) / (2 * r * delta);
    var phase = Math.acos(Math.max(-1, Math.min(1, cosPhase)));
    out.name = name.charAt(0).toUpperCase() + name.slice(1);
    out.key = name;
    out.heliocentric = r;
    out.phaseAngle = phase;
    out.illuminated = (1 + Math.cos(phase)) / 2;
    out.semidiameter = (SEMI[name] / delta) * ARCSEC;
    out.magnitude = magnitude(name, r, delta, phase * DEG, out.lon, out.lat, t);
    var s = sun(jdTt);
    out.elongation = Astro.angularSeparation(out.ra, out.dec, s.ra, s.dec);
    return out;
  }

  function all(jdTt) {
    var out = [sun(jdTt), moon(jdTt)];
    for (var i = 0; i < ORDER.length; i++) out.push(planet(ORDER[i], jdTt));
    return out;
  }

  return {
    sun: sun, moon: moon, planet: planet, all: all,
    order: ORDER, heliocentric: heliocentric, moonEcliptic: moonEcliptic
  };
})(typeof Astro !== 'undefined' ? Astro : require('./astro.js'),
   typeof EphemData !== 'undefined' ? EphemData : require('./ephem-data.js'));
if (typeof module !== 'undefined') module.exports = Ephem;
