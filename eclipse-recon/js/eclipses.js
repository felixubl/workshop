/* Eclipse Recon — the catalogue.
   Polynomial Besselian elements, transcribed from NASA/GSFC eclipse
   predictions by Fred Espenak (VSOP87/ELP2000-82 ephemerides). Each element
   a(t) = a0 + a1*t + a2*t^2 + a3*t^3 with t = TT hours since t0.
   x, y      shadow-axis intersection with the fundamental plane, Earth radii
   d, mu     declination and ephemeris hour angle of the shadow axis, degrees
   l1, l2    penumbral / umbral cone radii in the fundamental plane
   tanF1/2   cone half-angle tangents
   deltaT    TT - UT1 in seconds. The NASA pages carry the value predicted at
             publication time; the values here are the observed/modern ones,
             which land the path within ~1 km of the NASA plot and put the
             contact clocks on real UTC. */

var ECLIPSES = [
  {
    id: '2026-08-12',
    name: 'Total · 2026 Aug 12',
    short: '2026 Aug 12',
    type: 'total',
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
    tanF2: 0.0045911,
    // initial view, and one line of context
    home: { lat: 55, lon: -20, zoom: 3 },
    brief: 'Path: Arctic Ocean, Greenland, Iceland, northern Spain. Over ' +
           'Iberia the Sun stands below 12° and setting; western horizon ' +
           'obstruction is often decisive.'
  },
  {
    id: '2027-08-02',
    name: 'Total · 2027 Aug 02',
    short: '2027 Aug 02',
    type: 'total',
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
    tanF2: 0.0045834,
    home: { lat: 27, lon: 15, zoom: 4 },
    brief: 'Path: southern Spain, North Africa, Egypt, Arabian peninsula. ' +
           'Maximum totality 6 m 23 s near Luxor; high Sun; dry-season ' +
           'climatology.'
  },
  {
    id: '2028-07-22',
    name: 'Total · 2028 Jul 22',
    short: '2028 Jul 22',
    type: 'total',
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
    tanF2: 0.0045786,
    home: { lat: -25, lon: 133, zoom: 4 },
    brief: 'Path: Indian Ocean, northwest and central Australia, Sydney, ' +
           'New Zealand at dusk. Totality up to 5 m 10 s over the Kimberley ' +
           'in the dry season.'
  },
  {
    id: '2024-04-08',
    name: 'Total · 2024 Apr 08 (replay)',
    short: '2024 Apr 08',
    type: 'total',
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
    tanF2: 0.0046450,
    home: { lat: 35, lon: -95, zoom: 4 },
    brief: 'Replay: Mazatlan, Texas, the Ohio valley, Newfoundland ' +
           '(2024 Apr 8). Retained for calibration; the archive shows ' +
           'observed conditions.'
  }
];

if (typeof module !== 'undefined') module.exports = ECLIPSES;
