/* Time, frames and the transforms between them. No DOM, no data: this file is
   the arithmetic every other file leans on, and it runs unchanged under node.

   Angles are radians inside and degrees at the edges, because every catalogue
   and every reader speaks degrees and every trig function speaks radians. The
   one exception is right ascension, which the readouts print in hours. */
var Astro = (function () {
  'use strict';

  var RAD = Math.PI / 180;
  var DEG = 180 / Math.PI;
  var ARCSEC = Math.PI / 648000;
  var J2000 = 2451545.0;

  function norm(a) { var x = a % (2 * Math.PI); return x < 0 ? x + 2 * Math.PI : x; }

  /* ---- time ---------------------------------------------------------- */

  /* A JS Date is UTC milliseconds, and 2440587.5 is the JD of the epoch it
     counts from. UTC is treated as UT1: they are kept within 0.9 s of one
     another by leap seconds, and 0.9 s of Earth rotation is 13", well under
     anything this tool draws. */
  function julianDay(date) {
    return date.getTime() / 86400000 + 2440587.5;
  }

  function fromJulianDay(jd) {
    return new Date((jd - 2440587.5) * 86400000);
  }

  /* Espenak & Meeus, the polynomial set used by NASA's eclipse pages. TT - UT
     is measured for the past and extrapolated after 2005, so a date far in
     the future carries real uncertainty; the tool says so rather than hiding
     it. Returns seconds. */
  function deltaT(year) {
    var t, u;
    if (year < 1600) return 120;
    if (year < 1700) { t = year - 1600; return 120 - 0.9808 * t - 0.01532 * t * t + t * t * t / 7129; }
    if (year < 1800) { t = year - 1700; return 8.83 + 0.1603 * t - 0.0059285 * t * t + 0.00013336 * t * t * t - t * t * t * t / 1174000; }
    if (year < 1860) { t = year - 1800; return 13.72 - 0.332447 * t + 0.0068612 * t * t + 0.0041116 * t * t * t - 0.00037436 * Math.pow(t, 4) + 0.0000121272 * Math.pow(t, 5) - 0.0000001699 * Math.pow(t, 6) + 0.000000000875 * Math.pow(t, 7); }
    if (year < 1900) { t = year - 1860; return 7.62 + 0.5737 * t - 0.251754 * t * t + 0.01680668 * t * t * t - 0.0004473624 * Math.pow(t, 4) + t * t * t * t * t / 233174; }
    if (year < 1920) { t = year - 1900; return -2.79 + 1.494119 * t - 0.0598939 * t * t + 0.0061966 * t * t * t - 0.000197 * Math.pow(t, 4); }
    if (year < 1941) { t = year - 1920; return 21.20 + 0.84493 * t - 0.076100 * t * t + 0.0020936 * t * t * t; }
    if (year < 1961) { t = year - 1950; return 29.07 + 0.407 * t - t * t / 233 + t * t * t / 2547; }
    if (year < 1986) { t = year - 1975; return 45.45 + 1.067 * t - t * t / 260 - t * t * t / 718; }
    if (year < 2005) { t = year - 2000; return 63.86 + 0.3345 * t - 0.060374 * t * t + 0.0017275 * t * t * t + 0.000651814 * Math.pow(t, 4) + 0.00002373599 * Math.pow(t, 5); }
    if (year < 2050) { t = year - 2000; return 62.92 + 0.32217 * t + 0.005589 * t * t; }
    if (year < 2150) { u = (year - 1820) / 100; return -20 + 32 * u * u - 0.5628 * (2150 - year); }
    u = (year - 1820) / 100;
    return -20 + 32 * u * u;
  }

  function yearOf(jd) { return 2000 + (jd - J2000) / 365.25; }

  /* Terrestrial Time, as a Julian Day. VSOP87 and ELP2000 both want TT. */
  function ttFromUt(jdUt) { return jdUt + deltaT(yearOf(jdUt)) / 86400; }

  function centuries(jdTt) { return (jdTt - J2000) / 36525; }
  function millennia(jdTt) { return (jdTt - J2000) / 365250; }

  /* ---- the ecliptic, and how it wobbles ------------------------------ */

  /* IAU 2006 mean obliquity, in radians. */
  function obliquity(t) {
    var s = 84381.406 - 46.836769 * t - 0.0001831 * t * t + 0.00200340 * t * t * t
          - 0.000000576 * Math.pow(t, 4) - 0.0000000434 * Math.pow(t, 5);
    return s * ARCSEC;
  }

  /* The largest terms of the IAU 1980 nutation series. Nine terms hold the
     result to about 0.5", which is a twentieth of the finest thing this tool
     can draw; the full 106-term series would be arguing with the screen. */
  var NUT = [
    [0, 0, 0, 0, 1, -171996, -174.2, 92025, 8.9],
    [0, 0, 2, -2, 2, -13187, -1.6, 5736, -3.1],
    [0, 0, 2, 0, 2, -2274, -0.2, 977, -0.5],
    [0, 0, 0, 0, 2, 2062, 0.2, -895, 0.5],
    [0, 1, 0, 0, 0, 1426, -3.4, 54, -0.1],
    [1, 0, 0, 0, 0, 712, 0.1, -7, 0],
    [0, 1, 2, -2, 2, -517, 1.2, 224, -0.6],
    [0, 0, 2, 0, 1, -386, -0.4, 200, 0],
    [1, 0, 2, 0, 2, -301, 0, 129, -0.1]
  ];

  function nutation(t) {
    var D = (297.85036 + 445267.111480 * t - 0.0019142 * t * t + t * t * t / 189474) * RAD;
    var M = (357.52772 + 35999.050340 * t - 0.0001603 * t * t - t * t * t / 300000) * RAD;
    var Mp = (134.96298 + 477198.867398 * t + 0.0086972 * t * t + t * t * t / 56250) * RAD;
    var F = (93.27191 + 483202.017538 * t - 0.0036825 * t * t + t * t * t / 327270) * RAD;
    var Om = (125.04452 - 1934.136261 * t + 0.0020708 * t * t + t * t * t / 450000) * RAD;
    var dpsi = 0, deps = 0;
    for (var i = 0; i < NUT.length; i++) {
      var r = NUT[i];
      var arg = r[0] * Mp + r[1] * M + r[2] * F + r[3] * D + r[4] * Om;
      dpsi += (r[5] + r[6] * t) * Math.sin(arg);
      deps += (r[7] + r[8] * t) * Math.cos(arg);
    }
    return { dpsi: dpsi * 0.0001 * ARCSEC, deps: deps * 0.0001 * ARCSEC };
  }

  /* ---- sidereal time ------------------------------------------------- */

  /* Greenwich mean sidereal time in radians, from UT. */
  function gmst(jdUt) {
    var t = (jdUt - J2000) / 36525;
    var s = 280.46061837 + 360.98564736629 * (jdUt - J2000)
          + 0.000387933 * t * t - t * t * t / 38710000;
    return norm(s * RAD);
  }

  /* Apparent sidereal time: the mean value plus the equation of the equinoxes,
     which is what makes an hour angle line up with a real star rather than a
     mean one. */
  function gast(jdUt, jdTt) {
    var t = centuries(jdTt);
    var n = nutation(t);
    return norm(gmst(jdUt) + n.dpsi * Math.cos(obliquity(t) + n.deps));
  }

  function localSidereal(jdUt, jdTt, lonDeg) {
    return norm(gast(jdUt, jdTt) + lonDeg * RAD);
  }

  /* ---- frames -------------------------------------------------------- */

  function eclipticToEquatorial(lon, lat, eps) {
    var sl = Math.sin(lon), cl = Math.cos(lon);
    var sb = Math.sin(lat), cb = Math.cos(lat);
    var se = Math.sin(eps), ce = Math.cos(eps);
    return {
      ra: norm(Math.atan2(sl * ce - (sb / cb) * se, cl)),
      dec: Math.asin(sb * ce + cb * se * sl)
    };
  }

  function equatorialToEcliptic(ra, dec, eps) {
    var sa = Math.sin(ra), ca = Math.cos(ra);
    var sd = Math.sin(dec), cd = Math.cos(dec);
    var se = Math.sin(eps), ce = Math.cos(eps);
    return {
      lon: norm(Math.atan2(sa * ce + (sd / cd) * se, ca)),
      lat: Math.asin(sd * ce - cd * se * sa)
    };
  }

  /* Rigorous precession from J2000 to the equinox of date (Meeus 21.3-21.4).
     A star map that skipped this would have the pole in the wrong place by a
     degree within a lifetime. */
  function precessFromJ2000(ra, dec, t) {
    var zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) * ARCSEC;
    var z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) * ARCSEC;
    var theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) * ARCSEC;
    var A = Math.cos(dec) * Math.sin(ra + zeta);
    var B = Math.cos(theta) * Math.cos(dec) * Math.cos(ra + zeta) - Math.sin(theta) * Math.sin(dec);
    var C = Math.sin(theta) * Math.cos(dec) * Math.cos(ra + zeta) + Math.cos(theta) * Math.sin(dec);
    return { ra: norm(Math.atan2(A, B) + z), dec: Math.asin(C) };
  }

  /* Annual aberration, the 20" lean that comes of the observer moving.
     Ecliptic form, Meeus 23.2. */
  var KAPPA = 20.49552 * ARCSEC;

  function aberration(lon, lat, t) {
    var sun = (280.4665 + 36000.7698 * t) * RAD;
    var e = 0.016708634 - 0.000042037 * t - 0.0000001267 * t * t;
    var pi = (102.93735 + 1.71946 * t + 0.00046 * t * t) * RAD;
    var dLon = (-KAPPA * Math.cos(sun - lon) + e * KAPPA * Math.cos(pi - lon)) / Math.cos(lat);
    var dLat = -KAPPA * Math.sin(lat) * (Math.sin(sun - lon) - e * Math.sin(pi - lon));
    return { lon: dLon, lat: dLat };
  }

  /* A catalogue star, carried to the equinox and epoch of date: proper motion
     first, then precession, then nutation and aberration. pm arrives in
     arcsec per year, ra/dec in degrees. */
  function starOfDate(raDeg, decDeg, pmRaSec, pmDecSec, jdTt) {
    var t = centuries(jdTt);
    var years = (jdTt - J2000) / 365.25;
    var ra0 = raDeg * RAD;
    var dec0 = decDeg * RAD;
    /* The Bright Star Catalogue stores the PROJECTED motion, cos(dec)*dRA/dt,
       so that pmRA and pmDec are two sides of one right triangle. Right
       ascension itself therefore moves by pmRA/cos(dec). Near the pole that
       factor is enormous -- for Polaris it is 78 -- so dropping it does not
       look like a rounding error, it looks like the pole star wandering. */
    var ra = ra0 + (pmRaSec / Math.cos(dec0)) * ARCSEC * years;
    var dec = dec0 + pmDecSec * ARCSEC * years;
    var p = precessFromJ2000(ra, dec, t);
    var eps = obliquity(t);
    var ec = equatorialToEcliptic(p.ra, p.dec, eps);
    var ab = aberration(ec.lon, ec.lat, t);
    var n = nutation(t);
    return eclipticToEquatorial(ec.lon + ab.lon + n.dpsi, ec.lat + ab.lat, eps + n.deps);
  }

  /* ---- the observer -------------------------------------------------- */

  /* Equatorial to horizontal. Azimuth is measured from north through east,
     which is the convention every compass and every reader shares. */
  function horizontal(ha, dec, latDeg) {
    var lat = latDeg * RAD;
    var sh = Math.sin(ha), ch = Math.cos(ha);
    var sd = Math.sin(dec), cd = Math.cos(dec);
    var sl = Math.sin(lat), cl = Math.cos(lat);
    var alt = Math.asin(sl * sd + cl * cd * ch);
    /* Azimuth from north through east. The denominator is
       sin(dec)cos(lat) - cos(dec)cos(H)sin(lat); writing it the other way
       round turns the whole sky through half a turn, which reads as a
       working chart pointed the wrong way rather than as an error. */
    var az = Math.atan2(-sh * cd, sd * cl - cd * ch * sl);
    return { alt: alt, az: norm(az) };
  }

  /* Saemundsson, for a body seen at its true altitude. Returns the amount to
     ADD, in radians. Below the horizon it is meaningless and returns 0. */
  function refraction(altRad) {
    var a = altRad * DEG;
    if (a < -1) return 0;
    var r = 1.02 / Math.tan((a + 10.3 / (a + 5.11)) * RAD);
    return (r / 60) * RAD;
  }

  /* Geocentric coordinates of an observer, for the parallax correction. */
  var FLATTENING = 1 / 298.257223563;

  function geocentric(latDeg, heightM) {
    var lat = latDeg * RAD;
    var u = Math.atan((1 - FLATTENING) * Math.tan(lat));
    var h = (heightM || 0) / 6378140;
    return {
      rSin: (1 - FLATTENING) * Math.sin(u) + h * Math.sin(lat),
      rCos: Math.cos(u) + h * Math.cos(lat)
    };
  }

  /* Geocentric to topocentric. Matters enormously for the Moon (up to a
     degree) and not at all for a star, which is why the star path skips it. */
  function topocentric(ra, dec, distanceAu, lst, latDeg, heightM) {
    if (!distanceAu) return { ra: ra, dec: dec };
    var g = geocentric(latDeg, heightM);
    var sinPi = Math.sin(8.794 * ARCSEC) / distanceAu;
    var H = lst - ra;
    var cd = Math.cos(dec);
    var A = cd * Math.sin(H);
    var B = cd * Math.cos(H) - g.rCos * sinPi;
    var C = Math.sin(dec) - g.rSin * sinPi;
    var q = Math.sqrt(A * A + B * B + C * C);
    var haTopo = Math.atan2(A, B);
    return { ra: norm(lst - haTopo), dec: Math.asin(C / q), ha: haTopo };
  }

  function angularSeparation(ra1, dec1, ra2, dec2) {
    var c = Math.sin(dec1) * Math.sin(dec2)
          + Math.cos(dec1) * Math.cos(dec2) * Math.cos(ra1 - ra2);
    return Math.acos(Math.max(-1, Math.min(1, c)));
  }

  return {
    RAD: RAD, DEG: DEG, ARCSEC: ARCSEC, J2000: J2000,
    norm: norm,
    julianDay: julianDay, fromJulianDay: fromJulianDay,
    deltaT: deltaT, yearOf: yearOf, ttFromUt: ttFromUt,
    centuries: centuries, millennia: millennia,
    obliquity: obliquity, nutation: nutation,
    gmst: gmst, gast: gast, localSidereal: localSidereal,
    eclipticToEquatorial: eclipticToEquatorial,
    equatorialToEcliptic: equatorialToEcliptic,
    precessFromJ2000: precessFromJ2000,
    aberration: aberration, starOfDate: starOfDate,
    horizontal: horizontal, refraction: refraction,
    geocentric: geocentric, topocentric: topocentric,
    angularSeparation: angularSeparation
  };
})();
if (typeof module !== 'undefined') module.exports = Astro;
