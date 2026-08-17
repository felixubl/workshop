/* Eclipse Recon: the pre-surveyed band. The crawler (tools/crawl-vis.mjs, run
   by hand) walks the umbral band and precomputes, for every 60-80 m pixel, the
   fraction of totality the local horizon allows. This module reads those tiles
   so the browser does not repeat the work, and computes anything the crawler
   has not reached, so a partial survey is a speed-up rather than a dependency. */

var Precomp = (function () {
  'use strict';

  var M = { ecl: null, man: null, imgs: {}, order: [], hits: 0 };

  function zFor(lat) { var a = Math.abs(lat); return a < 52 ? 12 : a < 68 ? 11 : 10; }

  function tileOf(lat, lon) {
    var z = zFor(lat), n = 1 << z;
    var x = Math.floor((((lon + 180) / 360 * n) % n + n) % n);
    var latR = lat * Math.PI / 180;
    var y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n);
    return { z: z, x: x, y: y, n: n };
  }

  /* Which overview tiles exist is derivable rather than fetched: a parent
     exists exactly when at least one of its children has settled, and the
     manifest lists every child's status. */
  function buildCover() {
    M.ovA = {}; M.ovB = {};
    if (!M.man || !M.man.tiles) return;
    for (var k in M.man.tiles) {
      var st = M.man.tiles[k];
      if (!(typeof st === 'number' || st === 'f' || st === 'd')) continue;
      var p = k.split('/');
      var z = +p[0], x = +p[1], y = +p[2];
      M.ovA[(z - 3) + '/' + (x >> 3) + '/' + (y >> 3)] = 1;
      M.ovB[(z - 6) + '/' + (x >> 6) + '/' + (y >> 6)] = 1;
    }
  }

  function load(eclId) {
    M.ecl = eclId; M.man = null; M.imgs = {}; M.order = [];
    M.ovA = {}; M.ovB = {};
    return fetch('data/' + encodeURIComponent(eclId) + '/manifest.json',
                 { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (M.ecl === eclId) { M.man = j; buildCover(); }
        return j;
      })
      .catch(function () { return null; });
  }

  function progress() {
    return M.man && M.man.counts && M.man.counts.total ? M.man.counts : null;
  }

  /* rel is a path under data/<ecl>/ — 'vis/12/x/y' or 'ov/9/x/y' */
  function image(rel) {
    if (rel in M.imgs) return Promise.resolve(M.imgs[rel]);
    var p = new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          c.width = img.width; c.height = img.height;
          var g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0);
          resolve(g.getImageData(0, 0, img.width, img.height));
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = 'data/' + encodeURIComponent(M.ecl) + '/' + rel + '.png';
    }).then(function (data) {
      M.imgs[rel] = data;
      M.order.push(rel);
      // room for a whole wide-view prefetch (~600 tiles) plus slack;
      // a decoded tile is 64 KB, so the ceiling is ~45 MB
      if (M.order.length > 700) delete M.imgs[M.order.shift()];
      return data;
    });
    M.imgs[rel] = p;
    return p;
  }

  // a scanned tile's manifest entry is its mean vis as a number 0-255
  // ('d' from earlier crawler versions means the same, mean unknown)
  function scanned(st) { return typeof st === 'number' || st === 'd'; }

  function samplePx(data, t, lat, lon) {
    var fx = (((lon + 180) / 360 * t.n) - t.x) * data.width;
    var latR = lat * Math.PI / 180;
    var fy = (((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * t.n) - t.y) * data.height;
    var px = Math.max(0, Math.min(data.width - 1, Math.floor(fx)));
    var py = Math.max(0, Math.min(data.height - 1, Math.floor(fy)));
    return data.data[(py * data.width + px) * 4] / 255;
  }

  /* Manifest status of the ground under a point, without any fetch. */
  function statusAt(lat, lon) {
    if (!M.man || !M.man.tiles) return null;
    var t = tileOf(lat, lon);
    var key = t.z + '/' + t.x + '/' + t.y;
    return { key: key, st: M.man.tiles[key], t: t };
  }

  /* Warm the decoded-tile cache for a set of keys (the field renderer
     prefetches its viewport before painting). */
  function prefetch(keys) {
    return Promise.all(keys.map(function (k) {
      return Promise.resolve(image('vis/' + k));
    }));
  }

  /* Synchronous pixel read — only answers from already-decoded tiles;
     call prefetch first. Null means not decoded or not scanned ground. */
  function visSync(lat, lon) {
    var s = statusAt(lat, lon);
    if (!s) return null;
    if (s.st === 'f') return 1;
    if (!scanned(s.st)) return null;
    var data = M.imgs['vis/' + s.key];
    if (!data || typeof data.then === 'function' || !data.data) return null;
    return samplePx(data, s.t, lat, lon);
  }

  /* The visible fraction at a point, or null when the crawl has not
     settled that ground yet (then the caller scans locally). */
  function visAt(lat, lon) {
    var s = statusAt(lat, lon);
    if (!s) return Promise.resolve(null);
    if (s.st === 'f') { M.hits++; return Promise.resolve(1); }
    if (!scanned(s.st)) return Promise.resolve(null);
    return image('vis/' + s.key).then(function (data) {
      if (!data) return null;
      M.hits++;
      return samplePx(data, s.t, lat, lon);
    });
  }

  /* ---- the overview pyramid, read side. dz is 3 (≈0.5 km px) or 6
     (≈4 km px); the crawler writes value into R and COVERAGE into
     alpha, so an aggregate never blurs "mean is zero" into "not
     surveyed yet". */
  function ovKeyAt(lat, lon, dz) {
    var t = tileOf(lat, lon);
    var k = (t.z - dz) + '/' + (t.x >> dz) + '/' + (t.y >> dz);
    return (dz === 3 ? M.ovA : M.ovB)[k] ? k : null;
  }
  function ovPrefetch(keys) {
    return Promise.all(keys.map(function (k) {
      return Promise.resolve(image('ov/' + k));
    }));
  }
  /* number = settled aggregate; null = surveyed area, this ground not
     settled; undefined = no overview here or not fetched yet */
  function ovSync(lat, lon, dz) {
    var k = ovKeyAt(lat, lon, dz);
    if (!k) return undefined;
    var data = M.imgs['ov/' + k];
    if (!data || typeof data.then === 'function' || !data.data) return undefined;
    var parts = k.split('/');
    var pz = +parts[0], px = +parts[1], py = +parts[2];
    var n = 1 << pz;
    var fx = (((lon + 180) / 360 * n) - px) * data.width;
    var latR = lat * Math.PI / 180;
    var fy = (((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n) - py) * data.height;
    var ix = Math.max(0, Math.min(data.width - 1, Math.floor(fx)));
    var iy = Math.max(0, Math.min(data.height - 1, Math.floor(fy)));
    var o = (iy * data.width + ix) * 4;
    if (data.data[o + 3] < 128) return null;
    M.hits++;
    return data.data[o] / 255;
  }

  return { load: load, visAt: visAt, visSync: visSync, statusAt: statusAt,
           prefetch: prefetch, progress: progress,
           ovKeyAt: ovKeyAt, ovPrefetch: ovPrefetch, ovSync: ovSync,
           get hits() { return M.hits; } };
})();
