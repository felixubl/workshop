/* Eclipse Recon — terrain interrogation.
   Elevation from the AWS Open Data terrain tiles (Mapzen "terrarium"
   encoding: height = R*256 + G + B/256 - 32768, metres). Used to build a
   horizon profile around the Sun's azimuth: for a low eclipse, the mountain
   ridge 40 km west of you is as much a part of the prediction as the Moon.

   All requests go to s3.amazonaws.com/elevation-tiles-prod — nothing else. */

var Terrain = (function () {
  'use strict';

  var TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/';
  var R_EARTH_M = 6371000;
  var REFRACTION_K = 0.13;          // standard terrestrial refraction coefficient
  var cache = new Map();            // "z/x/y" -> Promise<ImageData|null>

  /* The horizon is surveyed fact: it never changes, so a scan once made is
     kept — in IndexedDB, across visits. The key is the exact question asked
     (site to ~11 m, azimuth window, step, reach, eye height); ask it again
     and the answer comes back without a single tile fetch. Weather is never
     stored this way: a forecast is stale in hours, a ridge is not. SCAN_V
     bumps when the scan algorithm changes, orphaning old answers. */
  var SCAN_V = 1;
  var dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (resolve) {
      try {
        var req = indexedDB.open('recon-terrain', 1);
        req.onupgradeneeded = function () {
          req.result.createObjectStore('scans');
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
    return dbP;
  }
  function scanKey(lat, lon, o) {
    return SCAN_V + '|' + lat.toFixed(4) + ',' + lon.toFixed(4) + '|' +
      Math.round(o.azCenter) + 'w' + Math.round(o.azSpan) + 's' + o.azStep +
      '|' + Math.round(o.maxKm) + 'k' + o.eyeM;
  }
  function storedScan(key) {
    if (putQ.has(key)) return Promise.resolve(putQ.get(key));
    return db().then(function (d) {
      if (!d) return undefined;
      return new Promise(function (resolve) {
        try {
          var rq = d.transaction('scans').objectStore('scans').get(key);
          rq.onsuccess = function () { resolve(rq.result); };
          rq.onerror = function () { resolve(undefined); };
        } catch (e) { resolve(undefined); }
      });
    });
  }
  /* Writes are batched: a fine survey stores tens of thousands of scans,
     and one transaction each would trail the survey by minutes. A tab
     closed mid-survey loses at most the last few hundred milliseconds. */
  var putQ = new Map(), putTimer = null;
  function storeScan(key, val) {
    putQ.set(key, val);
    if (!putTimer) putTimer = setTimeout(flushScans, 400);
  }
  function flushScans() {
    putTimer = null;
    var batch = putQ;
    putQ = new Map();
    db().then(function (d) {
      if (!d) return;
      try {
        var st = d.transaction('scans', 'readwrite').objectStore('scans');
        batch.forEach(function (v, k) { st.put(v, k); });
      } catch (e) { /* full or private-mode storage: the scans still ran */ }
    });
  }

  function tileKey(z, x, y) { return z + '/' + x + '/' + y; }

  function fetchTile(z, x, y) {
    var key = tileKey(z, x, y);
    if (cache.has(key)) return cache.get(key);
    var p = new Promise(function (resolve) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      var done = false;
      var finish = function (data) {
        if (done) return;
        done = true;
        // a failed load is a moment, not a fact: drop it from the cache
        // so the next asker retries instead of inheriting the hiccup
        if (data === null) cache.delete(key);
        resolve(data);
      };
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          c.width = 256; c.height = 256;
          var ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          finish(ctx.getImageData(0, 0, 256, 256));
        } catch (e) { finish(null); }
      };
      img.onerror = function () { finish(null); };
      setTimeout(function () { finish(null); }, 15000);
      img.src = TILE_URL + z + '/' + x + '/' + y + '.png';
    });
    cache.set(key, p);
    return p;
  }

  function tileCoords(lat, lon, z) {
    var n = Math.pow(2, z);
    var latR = lat * Math.PI / 180;
    var xt = (lon + 180) / 360 * n;
    var yt = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
    return { x: xt, y: yt, n: n };
  }

  function decode(px, i) {
    return px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768;
  }

  /* Bilinear elevation from an already-fetched tile set. Returns metres or
     null when the tile is missing. Ocean tiles carry bathymetry; anything
     below sea level reads as 0 because water makes its own horizon. */
  function sampleSync(tiles, lat, lon, z) {
    var tc = tileCoords(lat, lon, z);
    var tx = Math.floor(tc.x), ty = Math.floor(tc.y);
    if (ty < 0 || ty >= tc.n) return null;
    var data = tiles.get(tileKey(z, ((tx % tc.n) + tc.n) % tc.n, ty));
    if (!data) return null;
    var fx = (tc.x - tx) * 256 - 0.5, fy = (tc.y - ty) * 256 - 0.5;
    var x0 = Math.max(0, Math.min(255, Math.floor(fx)));
    var y0 = Math.max(0, Math.min(255, Math.floor(fy)));
    var x1 = Math.min(255, x0 + 1), y1 = Math.min(255, y0 + 1);
    var ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
    var p = data.data;
    var h00 = decode(p, (y0 * 256 + x0) * 4), h10 = decode(p, (y0 * 256 + x1) * 4);
    var h01 = decode(p, (y1 * 256 + x0) * 4), h11 = decode(p, (y1 * 256 + x1) * 4);
    var h = h00 * (1 - ax) * (1 - ay) + h10 * ax * (1 - ay) +
            h01 * (1 - ax) * ay + h11 * ax * ay;
    return Math.max(0, h);
  }

  function zoomFor(distKm, lat) {
    // enough resolution to catch a ridge at that distance, no more
    if (distKm < 8) return 11;
    if (distKm < 25) return 10;
    if (distKm < 60) return 9;
    return 8;
  }

  /* One elevation, fetching what it needs (site spot-checks). */
  function elevationAt(lat, lon, z) {
    z = z || 12;
    var tc = tileCoords(lat, lon, z);
    var tx = Math.floor(tc.x), ty = Math.floor(tc.y);
    return fetchTile(z, ((tx % tc.n) + tc.n) % tc.n, ty).then(function (data) {
      if (!data) return null;
      var tiles = new Map();
      tiles.set(tileKey(z, ((tx % tc.n) + tc.n) % tc.n, ty), data);
      return sampleSync(tiles, lat, lon, z);
    });
  }

  /* The horizon scan. Sweeps azCenter ± azSpan/2 in azStep steps; along each
     bearing walks geometrically spaced ranges out to maxKm, converts each
     terrain sample to an elevation angle with Earth curvature and standard
     refraction, and keeps the maximum: that is the horizon in that direction.

     opts: { azCenter, azSpan=110, azStep=1, maxKm=120, eyeM=2,
             onProgress(frac), signal }
     resolves { h0, siteElev, profile: [{az, ang, distKm, elevM}] }        */
  function horizonScan(lat, lon, opts) {
    opts = opts || {};
    var o = {
      azCenter: opts.azCenter != null ? opts.azCenter : 270,
      azSpan: opts.azSpan || 110,
      azStep: opts.azStep || 1,
      maxKm: opts.maxKm || 120,
      eyeM: opts.eyeM != null ? opts.eyeM : 2
    };
    var key = scanKey(lat, lon, o);
    return storedScan(key).then(function (hit) {
      if (hit && hit.profile) {
        if (opts.onProgress) opts.onProgress(1);
        return hit;
      }
      return scanFresh(lat, lon, o, opts).then(function (res) {
        storeScan(key, res);
        return res;
      });
    });
  }

  function scanFresh(lat, lon, o, opts) {
    var azCenter = o.azCenter;
    var azSpan = o.azSpan;
    var azStep = o.azStep;
    var maxKm = o.maxKm;
    var eyeM = o.eyeM;

    // ranges: 150 m to maxKm, ~9% growth per step
    var ranges = [];
    for (var d = 0.15; d < maxKm; d *= 1.09) ranges.push(d);
    ranges.push(maxKm);

    var azs = [];
    for (var a = azCenter - azSpan / 2; a <= azCenter + azSpan / 2 + 1e-9; a += azStep) {
      azs.push(((a % 360) + 360) % 360);
    }

    // plan every sample point, collect the tile set
    var samples = [];        // {az index, distKm, lat, lon, z}
    var need = new Map();    // key -> {z,x,y}
    function planPoint(la, lo, z) {
      var tc = tileCoords(la, lo, z);
      var tx = Math.floor(tc.x), ty = Math.floor(tc.y);
      if (ty < 0 || ty >= tc.n) return;
      var key = tileKey(z, ((tx % tc.n) + tc.n) % tc.n, ty);
      if (!need.has(key)) {
        need.set(key, { z: z, x: ((tx % tc.n) + tc.n) % tc.n, y: ty });
      }
    }
    azs.forEach(function (az, ai) {
      ranges.forEach(function (dKm) {
        var p = Bessel.destination(lat, lon, az, dKm);
        var z = zoomFor(dKm, p.lat);
        samples.push({ ai: ai, dKm: dKm, lat: p.lat, lon: p.lon, z: z });
        planPoint(p.lat, p.lon, z);
      });
    });
    planPoint(lat, lon, 12);   // the site itself

    var keys = Array.from(need.keys());
    var tiles = new Map();
    var fetched = 0;

    function pump() {
      // fetch with limited concurrency, reporting progress
      var idx = 0, active = 0, LIMIT = 6;
      return new Promise(function (resolve, reject) {
        function next() {
          if (opts.signal && opts.signal.aborted) { reject(new Error('aborted')); return; }
          if (idx >= keys.length && active === 0) { resolve(); return; }
          while (active < LIMIT && idx < keys.length) {
            (function (key) {
              var t = need.get(key);
              active++;
              fetchTile(t.z, t.x, t.y).then(function (data) {
                tiles.set(key, data);
                active--; fetched++;
                if (opts.onProgress) opts.onProgress(fetched / keys.length * 0.9);
                next();
              });
            })(keys[idx++]);
          }
        }
        next();
      });
    }

    return pump().then(function () {
      var siteElev = sampleSync(tiles, lat, lon, 12);
      if (siteElev === null) siteElev = 0;
      var h0 = siteElev + eyeM;
      var profile = azs.map(function (az) {
        return { az: az, ang: -0.6, distKm: maxKm, elevM: 0 };
      });
      samples.forEach(function (s) {
        var e = sampleSync(tiles, s.lat, s.lon, s.z);
        if (e === null) return;
        var dM = s.dKm * 1000;
        var drop = dM * dM / (2 * R_EARTH_M) * (1 - REFRACTION_K);
        var ang = Math.atan2(e - h0 - drop, dM) * 180 / Math.PI;
        var slot = profile[s.ai];
        if (ang > slot.ang) {
          slot.ang = ang; slot.distKm = s.dKm; slot.elevM = e;
        }
      });
      if (opts.onProgress) opts.onProgress(1);
      return { h0: h0, siteElev: siteElev, profile: profile };
    });
  }

  return {
    elevationAt: elevationAt,
    horizonScan: horizonScan,
    /* one terrarium tile as ImageData (null on failure), promise-cached —
       the suitability wash reads these to ink the coastline above itself */
    tile: fetchTile,
    cacheSize: function () { return cache.size; }
  };
})();
