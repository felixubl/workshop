/* What the chart claims about the sky, checked against the sky.

   The reference table below is not a copy of this tool's own output. It was
   printed by Skyfield reading JPL DE440s -- the same ephemeris and the same
   method the workshop's eclipse tools use -- and the assertions say how far
   this tool's arithmetic is allowed to sit from it. A check that measured the
   tool against itself would pass forever and mean nothing.

   Two runners, one set of assertions:
     node star-chart/js/selftest.js
     /tools/verify/star-chart.html
*/
(function (root) {
  'use strict';

  var Astro = typeof root.Astro !== 'undefined' ? root.Astro : require('./astro.js');
  var Ephem = typeof root.Ephem !== 'undefined' ? root.Ephem : require('./ephem.js');

  var REF = {"epochs":[{"utc":[1955,6,7,3,0,0],"jdTt":2435265.6254882407,"pos":[[74.374832,22.667436,1.014872186],[272.496678,-22.874705,0.002706652],[88.349215,22.351837,0.587674425],[50.39241,17.082613,1.537672859],[98.660895,24.265092,2.512562219],[121.122217,20.892635,5.98358005],[224.124211,-14.223996,9.012096986],[117.489006,21.563012,19.389227303],[204.476532,-8.298729,29.656627978]]},{"utc":[1980,1,7,3,0,0],"jdTt":2444245.6255924073,"pos":[[287.308718,-22.485819,0.983293664],[161.411647,8.795571,0.002699435],[278.152784,-24.42548,1.414919556],[321.935335,-16.820523,1.314413075],[167.337459,9.039139,0.916344277],[162.004678,8.877002,4.744292473],[178.13631,3.194652,9.055991983],[232.035622,-18.581902,19.321364413],[260.45487,-21.804834,31.16988757]]},{"utc":[2000,6,7,3,0,0],"jdTt":2451702.6257428704,"pos":[[75.52629,22.77102,1.014941223],[143.770647,16.732379,0.002465589],[101.561188,24.659367,0.866236146],[74.268118,22.580093,1.735142553],[83.062799,23.989685,2.567936124],[52.768667,18.176228,5.920748799],[52.035798,16.810855,10.078119811],[323.387079,-15.247838,19.474452447],[308.669717,-18.47479,29.448118146]]},{"utc":[2026,8,23,3,0,0],"jdTt":2461275.625800741,"pos":[[152.115521,11.461615,1.011270383],[273.358578,-27.829808,0.002702742],[148.188826,14.702452,1.325093743],[193.508504,-8.272587,0.623641696],[98.417908,23.615971,1.896577963],[134.421081,17.737748,6.2452428],[14.02064,3.155633,8.694657267],[63.666974,21.076359,19.519470943],[4.111962,0.24676,29.033910728]]},{"utc":[2060,11,7,3,0,0],"jdTt":2473770.625800741,"pos":[[223.00268,-16.468594,0.991050214],[28.31953,11.747388,0.002389517],[206.873541,-8.809614,1.123008558],[194.765108,-4.453665,1.374312178],[163.535272,8.778811,1.817800369],[96.055175,22.949298,4.41697451],[75.10055,20.906144,8.195898012],[216.778004,-14.097238,19.524113094],[79.571778,21.630293,29.044432342]]},{"utc":[2100,6,7,3,0,0],"jdTt":2488226.625800741,"pos":[[75.35507,22.745928,1.014683069],[64.037305,26.335091,0.002678107],[80.562376,20.97931,0.554014732],[42.088361,14.40821,0.375061823],[120.673591,21.818948,2.272694032],[192.800447,-3.952522,4.917778089],[199.565224,-5.403581,9.113976759],[22.947187,8.952311,20.565303527],[166.185893,6.963801,30.227969533]]}],"bodies":["Sun","Moon","Mercury","Venus","Mars","Jupiter","Saturn","Uranus","Neptune"],"stars":[{"hr":2491,"ra0":101.28715533,"dec0":-16.71611586,"pmra":-0.553,"pmdec":-1.205,"at":[[100.794752,-16.655467],[101.071554,-16.690741],[101.283155,-16.718804],[101.578729,-16.74946],[101.958312,-16.799481],[102.388379,-16.863453]]},{"hr":424,"ra0":37.95456067,"dec0":89.26410897,"pmra":0.038,"pmdec":-0.0125,"at":[[27.961786,89.052827],[33.180554,89.176903],[37.731251,89.260283],[46.761617,89.371117],[63.239941,89.484665],[88.047367,89.542946]]},{"hr":7001,"ra0":279.23473479,"dec0":38.78368896,"pmra":0.202,"pmdec":0.287,"at":[[278.866782,38.739888],[279.057228,38.76579],[279.242577,38.783371],[279.466084,38.811889],[279.743716,38.845933],[280.092366,38.881613]]},{"hr":2061,"ra0":88.79293899,"dec0":7.407064,"pmra":0.027,"pmdec":0.011,"at":[[88.188411,7.399764],[88.525877,7.401572],[88.789031,7.405414],[89.153618,7.413409],[89.618787,7.41529],[90.149123,7.414381]]}]};

  /* Tolerances, in arcsec, and each one is a measured figure rather than a
     hopeful one. The Moon's is the loosest because the tool carries only
     ELP2000-82B's main problem, which omits the planetary perturbations. */
  var TOL = {
    Sun: 3, Moon: 40, Mercury: 6, Venus: 6, Mars: 6,
    Jupiter: 6, Saturn: 6, Uranus: 6, Neptune: 6, star: 2
  };

  function sep(ra1, dec1, ra2, dec2) {
    return Astro.angularSeparation(ra1 * Astro.RAD, dec1 * Astro.RAD,
                                   ra2 * Astro.RAD, dec2 * Astro.RAD) * Astro.DEG * 3600;
  }

  function run(report) {
    var results = [];
    function ok(name, pass, detail) { results.push({ name: name, pass: !!pass, detail: detail }); }

    /* ---- the moving bodies against DE440s ---- */
    REF.epochs.forEach(function (e) {
      var bodies = Ephem.all(e.jdTt);
      REF.bodies.forEach(function (name, i) {
        var want = e.pos[i];
        var got = bodies[i];
        var d = sep(got.ra * Astro.DEG, got.dec * Astro.DEG, want[0], want[1]);
        ok(name + ' ' + e.utc[0], d <= TOL[name],
           d.toFixed(2) + '" from DE440s, allowed ' + TOL[name] + '"');
        var dr = Math.abs(got.distance - want[2]) / want[2];
        ok(name + ' ' + e.utc[0] + ' distance', dr < 0.001,
           (dr * 100).toFixed(4) + '% from DE440s');
      });
    });

    /* ---- catalogue stars carried to the equinox of date ---- */
    REF.stars.forEach(function (s) {
      REF.epochs.forEach(function (e, i) {
        var p = Astro.starOfDate(s.ra0, s.dec0, s.pmra, s.pmdec, e.jdTt);
        var d = sep(p.ra * Astro.DEG, p.dec * Astro.DEG, s.at[i][0], s.at[i][1]);
        ok('HR' + s.hr + ' ' + e.utc[0], d <= TOL.star,
           d.toFixed(2) + '" from DE440s, allowed ' + TOL.star + '"');
      });
    });

    /* ---- the transforms, checked on their own terms ---- */
    var jd = Astro.ttFromUt(Astro.julianDay(new Date(Date.UTC(2026, 7, 23, 22, 0, 0))));
    var t = Astro.centuries(jd);
    var eps = Astro.obliquity(t);

    var back = Astro.equatorialToEcliptic.bind(null);
    var e1 = Astro.equatorialToEcliptic(1.2, 0.5, eps);
    var q1 = Astro.eclipticToEquatorial(e1.lon, e1.lat, eps);
    ok('ecliptic round trip', sep(q1.ra * Astro.DEG, q1.dec * Astro.DEG,
                                  1.2 * Astro.DEG, 0.5 * Astro.DEG) < 0.001,
       'there and back lands on the same point');

    /* A star on the meridian has zero hour angle and sits due south for a
       northern observer, which is the one horizontal case with no arithmetic
       in it worth arguing about. */
    var h = Astro.horizontal(0, 20 * Astro.RAD, 48);
    ok('meridian is due south', Math.abs(h.az * Astro.DEG - 180) < 1e-6,
       'azimuth ' + (h.az * Astro.DEG).toFixed(4));
    ok('meridian altitude', Math.abs(h.alt * Astro.DEG - (90 - 48 + 20)) < 1e-6,
       'altitude ' + (h.alt * Astro.DEG).toFixed(4) + ', expected ' + (90 - 48 + 20));

    /* Refraction at the horizon is about half a degree -- the reason the Sun
       is already wholly above the horizon when it looks like it is touching. */
    var r0 = Astro.refraction(0) * Astro.DEG * 60;
    ok('refraction at the horizon', r0 > 25 && r0 < 35, r0.toFixed(1) + ' arcmin');
    ok('refraction falls off', Astro.refraction(45 * Astro.RAD) < Astro.refraction(5 * Astro.RAD),
       'higher up is bent less');

    /* Parallax vanishes overhead and is at its largest on the horizon. */
    var moon = Ephem.moon(jd);
    var lst = Astro.localSidereal(Astro.julianDay(new Date(Date.UTC(2026, 7, 23, 22))), jd, 16.37);
    var topo = Astro.topocentric(moon.ra, moon.dec, moon.distance, lst, 48.2, 170);
    var shift = sep(moon.ra * Astro.DEG, moon.dec * Astro.DEG,
                    topo.ra * Astro.DEG, topo.dec * Astro.DEG) / 60;
    ok('lunar parallax is real', shift > 5 && shift < 62,
       shift.toFixed(1) + ' arcmin between geocentric and topocentric');

    /* The phase has to agree with the elongation: new at conjunction, full at
       opposition. Checked at a known new moon and a known full moon. */
    var newMoon = Ephem.moon(Astro.ttFromUt(Astro.julianDay(new Date(Date.UTC(2026, 0, 18, 19, 52)))));
    var fullMoon = Ephem.moon(Astro.ttFromUt(Astro.julianDay(new Date(Date.UTC(2026, 0, 3, 10, 3)))));
    ok('new moon is dark', newMoon.illuminated < 0.02,
       (newMoon.illuminated * 100).toFixed(2) + '% lit on 2026-01-18');
    ok('full moon is lit', fullMoon.illuminated > 0.98,
       (fullMoon.illuminated * 100).toFixed(2) + '% lit on 2026-01-03');

    /* Sidereal time gains on solar time by just under four minutes a day. */
    var g1 = Astro.gmst(2451545.0), g2 = Astro.gmst(2451546.0);
    var gain = Astro.norm(g2 - g1) * Astro.DEG * 240;
    ok('sidereal day is shorter', gain > 235 && gain < 240,
       'sidereal time gains ' + gain.toFixed(1) + ' s per solar day');

    var pass = results.filter(function (r) { return r.pass; }).length;
    if (report) report(results, pass, results.length);
    return { results: results, pass: pass, total: results.length };
  }

  if (typeof module !== 'undefined') {
    module.exports = run;
    if (require.main === module) {
      var out = run();
      out.results.forEach(function (r) {
        if (!r.pass) console.log('FAIL  ' + r.name + '  ::  ' + r.detail);
      });
      console.log(out.pass + ' pass, ' + (out.total - out.pass) + ' fail');
      process.exit(out.pass === out.total ? 0 : 1);
    }
  } else {
    root.StarChartSelftest = run;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
