/* Eclipse Recon — the catalogue.
   Pure data: polynomial Besselian elements, nothing else. Everything a
   record used to carry beside them — a display name, a type word, a home
   view, a line of prose — is derivable from the elements, so app.js derives
   it. A record is:
     { id, date: [y,m,d], t0, deltaT,
       x, y, d, l1, l2, mu (each a0..a3), tanF1, tanF2 }
   a(t) = a0 + a1*t + a2*t^2 + a3*t^3, t = TT hours since t0.
   x, y      shadow-axis intersection with the fundamental plane, Earth radii
   d, mu     declination and ephemeris hour angle of the shadow axis, degrees
   l1, l2    penumbral / umbral cone radii in the fundamental plane
   tanF1/2   cone half-angle tangents
   deltaT    TT - UT1 in seconds; observed/modern values, which land the
             path within ~1 km of the NASA plot.

   The shipped records are transcribed from NASA/GSFC eclipse predictions by
   Fred Espenak (VSOP87/ELP2000-82). Any other eclipse loads at runtime:
   parseElements() below reads the "Polynomial Besselian Elements" block off
   a NASA page verbatim, and the app keeps what it parses in localStorage.
   That is the whole generalisation story — data in, everything computed. */

var ECLIPSES = [
  {
    id: '2026-08-12',
    date: [2026, 8, 12],
    t0: 18.0,
    deltaT: 69.2,
    x:  [ 0.4755140,  0.5189249, -0.0000773, -0.0000080],
    y:  [ 0.7711830, -0.2301680, -0.0001246,  0.0000038],
    d:  [14.7966700, -0.0120650, -0.0000030,  0.0],
    l1: [ 0.5379550,  0.0000939, -0.0000121,  0.0],
    l2: [-0.0081420,  0.0000935, -0.0000121,  0.0],
    mu: [88.747787,  15.003090,   0.0,        0.0],
    tanF1: 0.0046141,
    tanF2: 0.0045911
  },
  {
    id: '2027-08-02',
    date: [2027, 8, 2],
    t0: 10.0,
    deltaT: 69.3,
    x:  [-0.0196450,  0.5447105, -0.0000444, -0.0000091],
    y:  [ 0.1600630, -0.2111569, -0.0001217,  0.0000037],
    d:  [17.7624700, -0.0101810, -0.0000040,  0.0],
    l1: [ 0.5305960,  0.0000138, -0.0000128,  0.0],
    l2: [-0.0154640,  0.0000137, -0.0000128,  0.0],
    mu: [328.422490, 15.002093,   0.0,        0.0],
    tanF1: 0.0046064,
    tanF2: 0.0045834
  },
  {
    id: '2028-07-22',
    date: [2028, 7, 22],
    t0: 3.0,
    deltaT: 69.4,
    x:  [-0.1543000,  0.5449941, -0.0000226, -0.0000095],
    y:  [-0.5863800, -0.1746077, -0.0001022,  0.0000029],
    d:  [20.1823100, -0.0079740, -0.0000050,  0.0],
    l1: [ 0.5352360, -0.0000859, -0.0000123,  0.0],
    l2: [-0.0108470, -0.0000854, -0.0000122,  0.0],
    mu: [223.378660, 15.001018,   0.0,        0.0],
    tanF1: 0.0046016,
    tanF2: 0.0045786
  },
  {
    id: '2024-04-08',
    date: [2024, 4, 8],
    t0: 18.0,
    deltaT: 69.1,
    x:  [-0.3182440,  0.5117116,  0.0000326, -0.0000084],
    y:  [ 0.2197640,  0.2709589, -0.0000595, -0.0000047],
    d:  [ 7.5862002,  0.0148440, -0.0000020,  0.0],
    l1: [ 0.5358140,  0.0000618, -0.0000128,  0.0],
    l2: [-0.0102720,  0.0000615, -0.0000127,  0.0],
    mu: [89.591217,  15.004080,   0.0,        0.0],
    tanF1: 0.0046683,
    tanF2: 0.0046450
  }
];

/* Parses the "Polynomial Besselian Elements" block from a NASA/GSFC eclipse
   page, pasted as plain text. Tolerant of the page's own variations: the
   coefficient table is read as rows n = 0..3 of six numbers in the fixed
   column order x y d l1 l2 mu; t0, tan f1/f2 and ΔT are read off their
   labelled lines; the date comes from the page title. Returns a catalogue
   record, or throws with the first thing it could not find. */
function parseElements(text) {
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
                 jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  var lines = String(text).split(/\r?\n/);

  var date = null;
  var t0 = null, deltaT = null, tanF1 = null, tanF2 = null;
  var rows = [];

  lines.forEach(function (raw) {
    var line = raw.trim();
    if (!line) return;

    var m = line.match(/(\d{4})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2})/);
    if (m && !date && MONTHS[m[2].toLowerCase()]) {
      date = [+m[1], MONTHS[m[2].toLowerCase()], +m[3]];
    }
    m = line.match(/t0\s*=\s*(\d{1,2})(?::(\d{2}))?/i);
    if (m && t0 === null) t0 = +m[1] + (+m[2] || 0) / 60;
    m = line.match(/tan\s*[fƒ]\s*1\s*=?\s*(-?[\d.]+)/i);
    if (m) tanF1 = +m[1];
    m = line.match(/tan\s*[fƒ]\s*2\s*=?\s*(-?[\d.]+)/i);
    if (m) tanF2 = +m[1];
    m = line.match(/(?:ΔT|delta\s*T)\s*=?\s*(-?[\d.]+)/i);
    if (m) deltaT = +m[1];

    // a coefficient row: the order 0-3, then six numbers
    m = line.match(/^([0-3])\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)$/);
    if (m) rows[+m[1]] = [+m[2], +m[3], +m[4], +m[5], +m[6], +m[7]];
  });

  if (!rows[0] || !rows[1]) throw new Error('coefficient rows not found');
  if (t0 === null) throw new Error('t0 not found');
  if (tanF1 === null || tanF2 === null) throw new Error('tan f1/f2 not found');
  if (!date) throw new Error('date not found');
  if (deltaT === null) deltaT = 69 + (date[0] - 2020) * 0.4;  // ΔT drifts ~0.4 s/yr

  function col(i) {
    return [rows[0][i], rows[1][i],
            rows[2] ? rows[2][i] : 0, rows[3] ? rows[3][i] : 0];
  }
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return {
    id: date[0] + '-' + pad(date[1]) + '-' + pad(date[2]),
    date: date, t0: t0, deltaT: deltaT,
    x: col(0), y: col(1), d: col(2), l1: col(3), l2: col(4), mu: col(5),
    tanF1: tanF1, tanF2: tanF2
  };
}

if (typeof module !== 'undefined') {
  module.exports = { ECLIPSES: ECLIPSES, parseElements: parseElements };
}
