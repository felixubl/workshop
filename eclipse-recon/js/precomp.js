/* Eclipse Recon — the pre-surveyed band.
   The workshop's crawler (tools/crawl-vis.mjs, run by a scheduled GitHub
   Action) walks the umbral band with no hurry and precomputes, for every
   ~60-80 m pixel, the fraction of totality the local horizon lets
   through — the expensive, eternal factor of the score. What it has
   settled is committed to the repo and served by Pages as static files:
   a manifest and a grayscale PNG per map tile.

   This module is the reader. scanVis asks it first; a hit costs one
   cached PNG fetch instead of a full terrain scan, and a miss falls back
   to scanning locally, so the map is always right — the crawl only makes
   it faster, further along every week. The tiling (z by latitude, so a
   pixel stays 60-80 m) MIRRORS the crawler; change one, change both. */

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

  function load(eclId) {
    M.ecl = eclId; M.man = null; M.imgs = {}; M.order = [];
    return fetch('data/' + encodeURIComponent(eclId) + '/manifest.json',
                 { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (M.ecl === eclId) M.man = j; return j; })
      .catch(function () { return null; });
  }

  function progress() {
    return M.man && M.man.counts && M.man.counts.total ? M.man.counts : null;
  }

  function image(key) {
    if (key in M.imgs) return Promise.resolve(M.imgs[key]);
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
      img.src = 'data/' + encodeURIComponent(M.ecl) + '/vis/' + key + '.png';
    }).then(function (data) {
      M.imgs[key] = data;
      M.order.push(key);
      if (M.order.length > 240) delete M.imgs[M.order.shift()];
      return data;
    });
    M.imgs[key] = p;
    return p;
  }

  /* The visible fraction at a point, or null when the crawl has not
     settled that ground yet (then the caller scans locally). */
  function visAt(lat, lon) {
    if (!M.man || !M.man.tiles) return Promise.resolve(null);
    var t = tileOf(lat, lon);
    var key = t.z + '/' + t.x + '/' + t.y;
    var st = M.man.tiles[key];
    if (st === 'f') { M.hits++; return Promise.resolve(1); }
    if (st !== 'd') return Promise.resolve(null);
    return image(key).then(function (data) {
      if (!data) return null;
      var fx = (((lon + 180) / 360 * t.n) - t.x) * data.width;
      var latR = lat * Math.PI / 180;
      var fy = (((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * t.n) - t.y) * data.height;
      var px = Math.max(0, Math.min(data.width - 1, Math.floor(fx)));
      var py = Math.max(0, Math.min(data.height - 1, Math.floor(fy)));
      M.hits++;
      return data.data[(py * data.width + px) * 4] / 255;
    });
  }

  return { load: load, visAt: visAt, progress: progress,
           get hits() { return M.hits; } };
})();
