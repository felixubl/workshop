/* Eclipse Recon — the page.
   Wiring: Leaflet relief map, the Besselian engine, the terrain reader
   and the weather client. All colour comes off the PREPRINT tokens at draw
   time, so the pull cord restyles the map and charts along with the page:
   the ground is an altitude ramp drawn from elevation data, the shadow is
   printed in black, plate 3 is totality, plate 1 a good verdict, plate 2 a
   bad one, and the citron marker means marginal.

   Nothing about a particular eclipse lives in here. A catalogue record is
   Besselian elements and a date, and everything shown — the name, the
   type, the path, the opening view, every number on every panel — is
   computed from them. Records pasted off a NASA elements page load at
   runtime and persist in localStorage. */

(function () {
  'use strict';

  /* ================= helpers ================= */

  var $ = function (id) { return document.getElementById(id); };
  var RAD = Math.PI / 180;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtUT(date) {
    if (!date) return '—';
    return pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes()) + ':' +
           pad2(date.getUTCSeconds());
  }
  function fmtLocal(date, offSec) {
    if (!date || offSec === null || offSec === undefined) return null;
    var d = new Date(date.getTime() + offSec * 1000);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' +
           pad2(d.getUTCSeconds());
  }
  function fmtOffset(offSec) {
    var oh = offSec / 3600;
    var sign = oh >= 0 ? '+' : '−';
    var abs = Math.abs(oh);
    return 'UTC' + sign + (abs % 1 ? abs.toFixed(1) : abs);
  }
  function fmtDur(sec) {
    if (!sec || sec <= 0) return '—';
    var m = Math.floor(sec / 60), s = Math.round(sec - m * 60);
    if (s === 60) { m += 1; s = 0; }
    return m + 'm ' + pad2(s) + 's';
  }
  function fmtLat(v) {
    return Math.abs(v).toFixed(4) + '°' + (v >= 0 ? 'N' : 'S');
  }
  function fmtLon(v) {
    return Math.abs(v).toFixed(4) + '°' + (v >= 0 ? 'E' : 'W');
  }
  function compass(az) {
    var pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW',
               'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return pts[Math.round(((az % 360) + 360) % 360 / 22.5) % 16];
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function debounce(fn, ms) {
    var t; return function () {
      var a = arguments, self = this;
      clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms);
    };
  }
  /* unwrap longitudes so a polyline never jumps across the antimeridian */
  function unwrap(pts) {
    var out = [], prev = null;
    pts.forEach(function (p) {
      var lon = p.lon;
      if (prev !== null) {
        while (lon - prev > 180) lon -= 360;
        while (lon - prev < -180) lon += 360;
      }
      prev = lon;
      out.push([p.lat, lon]);
    });
    return out;
  }
  /* the live PREPRINT palette — read fresh at draw time so both colour
     modes get their own steps */
  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement)
      .getPropertyValue(name).trim();
    return v || fallback;
  }
  function palette() {
    return {
      ink: cssVar('--pp-ink', '#171716'),
      faint: cssVar('--pp-faint', '#6a6a62'),
      paper: cssVar('--pp-paper', '#fbfbf9'),
      hair: cssVar('--pp-hair', 'rgba(23,23,22,.11)'),
      total: cssVar('--pp-plate-3-text', '#0052cc'),
      totalLine: cssVar('--pp-plate-3', '#0066ff'),
      ok: cssVar('--pp-state-ok', '#017a4e'),
      okFill: cssVar('--pp-plate-1', '#01a368'),
      danger: cssVar('--pp-state-danger', '#c8082f'),
      dangerFill: cssVar('--pp-plate-2', '#ed0a3f'),
      citron: cssVar('--w-mark-fill', '#deee2e')
    };
  }

  /* ================= state ================= */

  var S = {
    ecl: null,            // active eclipse record
    gt: null,             // globalTimes
    path: null,           // centralPath
    type: null,           // central type, derived from the elements
    T: 0,                 // simulation clock, TT hours
    tMin: 0, tMax: 0,     // scrub range
    playing: false,
    tracking: false,      // camera follows the umbra
    layers: {},           // leaflet layers per role
    target: null,         // {lat, lon, elev, circ, wx, terrain}
    sweepCache: {},       // eclipse id -> sweep results
    aborter: null         // AbortController for target fetches
  };

  /* ================= the catalogue, derived ================= */

  var STORE_KEY = 'recon-eclipses';

  function storedEclipses() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function catalogue() {
    var all = ECLIPSES.slice();
    storedEclipses().forEach(function (e) {
      if (!all.some(function (x) { return x.id === e.id; })) all.push(e);
    });
    return all.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
  }

  /* Everything a record used to state is computed off its elements once and
     memoised: global times, and the central type read from the umbral cone
     at greatest eclipse (a positive l2 is an antumbra). No name strings, no
     type flags, no home views in the data. */
  var metaCache = {};
  function metaFor(ecl) {
    if (metaCache[ecl.id]) return metaCache[ecl.id];
    var gt = Bessel.globalTimes(ecl);
    var type = 'partial';
    if (gt.latGE !== null) {
      var lc = Bessel.localCircumstances(ecl, gt.latGE, gt.lonGE, 0);
      if (lc) type = lc.type;
    }
    var m = { gt: gt, type: type, label: ecl.id + ' · ' + type };
    metaCache[ecl.id] = m;
    return m;
  }

  /* A hybrid is total at greatest and annular at the ends (or the reverse);
     only the full path can say, so it refines the cheap label. */
  function refineType(ecl, path, type) {
    if (!path.center.length) return 'partial';
    var ends = [path.center[0], path.center[path.center.length - 1]];
    var flipped = ends.some(function (p) {
      var lc = Bessel.localCircumstances(ecl, p.lat, p.lon, 0);
      return lc && (lc.type === 'total' || lc.type === 'annular') &&
             lc.type !== type;
    });
    return flipped ? 'hybrid' : type;
  }

  /* ================= map ================= */

  var map = L.map('map', {
    zoomControl: false,
    minZoom: 2,
    maxBounds: [[-85, -220], [85, 220]],
    maxBoundsViscosity: 0.7,
    attributionControl: false,
    worldCopyJump: false
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  map.createPane('relief').style.zIndex = 200;
  map.getPane('relief').classList.add('pane-relief');
  map.createPane('heat').style.zIndex = 290;
  map.createPane('suit').style.zIndex = 295;
  map.getPane('suit').style.pointerEvents = 'none';
  map.createPane('night').style.zIndex = 300;
  map.createPane('labels').style.zIndex = 380;
  map.createPane('eclShadow').style.zIndex = 410;
  map.createPane('sweep').style.zIndex = 450;
  map.getPane('labels').style.pointerEvents = 'none';
  map.getPane('night').style.pointerEvents = 'none';
  map.getPane('heat').style.pointerEvents = 'none';
  map.getPane('eclShadow').style.pointerEvents = 'none';

  /* The ground layer is not a photograph. It was — Esri imagery through a
     grayscale() filter — and a photograph turned grey still ranks a forest
     against a desert by how much light each threw at a satellite, which is a
     fact about vegetation and weather, not about the ground. The recon map
     has to answer exactly two questions about the ground: is that water, and
     how high is that. So it is drawn from the answers themselves: the same
     Mapzen terrarium tiles the horizon scan reads, decoded to metres per
     pixel and pressed into altitude bands.

     Water is the palest tone on the map and dead flat; land starts a step
     darker and darkens with height. Lighter than everything = water, darker
     = higher, and the key beside the credits says where the steps fall. The
     bands are steps rather than a smooth ramp because a smooth ramp can only
     be compared ("higher than there"), while a step can be read ("above two
     thousand"), and reading is the point.

     The one lie the data tells: terrarium's zero is the sea. A lake above
     sea level is a positive elevation like the land around it, and the shore
     of a below-sea-level basin (the Dead Sea's, Death Valley's) sits under
     zero like the sea does. No single elevation number can say "wet", and
     this map would rather be simple than pretend otherwise. */
  var HYPSO_WATER = 236;
  var HYPSO_BANDS = [
    { upTo: 200,      shade: 208 },
    { upTo: 500,      shade: 189 },
    { upTo: 1000,     shade: 170 },
    { upTo: 1500,     shade: 150 },
    { upTo: 2000,     shade: 129 },
    { upTo: 3000,     shade: 106 },
    { upTo: 4000,     shade: 82 },
    { upTo: Infinity, shade: 58 }
  ];

  function hypsoShade(h) {
    if (h <= 0) return HYPSO_WATER;
    for (var i = 0; i < HYPSO_BANDS.length; i++) {
      if (h < HYPSO_BANDS[i].upTo) return HYPSO_BANDS[i].shade;
    }
    return HYPSO_BANDS[HYPSO_BANDS.length - 1].shade;
  }

  var ReliefLayer = L.GridLayer.extend({
    createTile: function (coords, done) {
      var tile = document.createElement('canvas');
      tile.width = tile.height = 256;
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          var ctx = tile.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          var id = ctx.getImageData(0, 0, 256, 256);
          var p = id.data;
          for (var i = 0; i < p.length; i += 4) {
            var s = hypsoShade(p[i] * 256 + p[i + 1] + p[i + 2] / 256 - 32768);
            p[i] = p[i + 1] = p[i + 2] = s;
            p[i + 3] = 255;
          }
          ctx.putImageData(id, 0, 0);
        } catch (e) { /* a blank tile is the paper showing through */ }
        done(null, tile);
      };
      img.onerror = function () { done(null, tile); };
      img.src = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/' +
                coords.z + '/' + coords.x + '/' + coords.y + '.png';
      return tile;
    }
  });
  // terrarium stops at z15; past that the bands upscale, which costs a
  // stepped map nothing
  new ReliefLayer({ pane: 'relief', maxNativeZoom: 15, maxZoom: 17 })
    .addTo(map);

  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
    { pane: 'labels', subdomains: 'abcd', maxZoom: 17 }).addTo(map);
  map.getPane('labels').classList.add('pane-labels');

  /* The key, built from the same array that paints the tiles so the two
     cannot drift apart. Each label is the metre line where its band begins. */
  (function buildHypsoKey() {
    var key = $('hypso-key');
    if (!key) return;
    function cell(shade, label) {
      var i = document.createElement('i');
      i.style.background = 'rgb(' + shade + ',' + shade + ',' + shade + ')';
      var b = document.createElement('b');
      b.textContent = label;
      key.appendChild(i);
      key.appendChild(b);
    }
    cell(HYPSO_WATER, 'water');
    var from = 0;
    HYPSO_BANDS.forEach(function (band) {
      cell(band.shade, from >= 1000 ? (from / 1000) + 'k' : String(from));
      from = band.upTo;
    });
    var unit = document.createElement('b');
    unit.textContent = 'm+';
    key.appendChild(unit);
  })();

  /* ================= static geometry per eclipse ================= */

  function clearRole(role) {
    if (S.layers[role]) { map.removeLayer(S.layers[role]); delete S.layers[role]; }
  }

  function buildStatic() {
    ['band', 'center', 'limits', 'ge', 'contours', 'heat', 'sweepDots']
      .forEach(clearRole);

    var P = palette();
    var path = S.path;
    if (path.center.length && path.ring && path.ring.length) {
      // the engine hands over one closed ring: rails where they verifiably
      // sit on the observable boundary, oracle-marched arcs around the ends
      var ring = unwrap(path.ring);
      S.layers.bandPoly = L.polygon(ring, {
        color: P.ink, weight: 1, opacity: 0.6,
        fillColor: '#000', fillOpacity: 0.34, interactive: false
      });
      S.layers.centerLine = L.polyline(unwrap(path.center), {
        color: P.ink, weight: 1.3, opacity: 0.85,
        dashArray: '7 5', interactive: false
      });
      var group = [S.layers.bandPoly, S.layers.centerLine];
      if (S.gt.latGE !== null) {
        group.push(L.marker([S.gt.latGE, S.gt.lonGE], {
          interactive: false,
          icon: L.divIcon({
            className: '', iconSize: [130, 30], iconAnchor: [8, 8],
            html: '<div class="ge-label">× greatest eclipse<br>' +
                  fmtUT(S.gt.dateGE) + ' UT · ' + fmtDur(S.gt.maxDuration) +
                  '</div>'
          })
        }));
      }
      S.layers.band = L.layerGroup(group).addTo(map);
    }
    buildRaster();
  }

  /* obscuration field: computed on a lat/lon grid in idle chunks, then
     warped to a web-mercator overlay + contour lines */
  var rasterRun = 0;
  function buildRaster() {
    var run = ++rasterRun;
    var ecl = S.ecl, tGE = S.gt.tGE;
    var lonStep = 0.75, latStep = 0.6;
    var lats = [], lons = [];
    for (var la = -78; la <= 84; la += latStep) lats.push(la);
    for (var lo = -180; lo < 180; lo += lonStep) lons.push(lo);
    var W = lons.length, H = lats.length;
    var grid = new Float32Array(W * H); grid.fill(NaN);

    var row = 0;
    function chunk() {
      if (run !== rasterRun) return;              // superseded by a new mission
      var t0 = performance.now();
      while (row < H && performance.now() - t0 < 14) {
        for (var i = 0; i < W; i++) {
          var q = Bessel.quickMax(ecl, lats[row], lons[i], tGE);
          if (q) grid[row * W + i] = q.obsc;
        }
        row++;
      }
      if (row < H) { setTimeout(chunk, 0); return; }
      renderRaster(grid, lats, lons, W, H, run);
    }
    setTimeout(chunk, 0);
  }

  function renderRaster(grid, lats, lons, W, H, run) {
    if (run !== rasterRun) return;
    var latTop = lats[H - 1], latBot = lats[0];
    function mercY(lat) {
      var s = Math.sin(lat * RAD);
      return Math.log((1 + s) / (1 - s)) / 2;
    }
    var yTop = mercY(latTop), yBot = mercY(latBot);
    var CW = 1024, CH = 760;
    var cv = document.createElement('canvas');
    cv.width = CW; cv.height = CH;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(CW, CH);
    var px = img.data;
    for (var y = 0; y < CH; y++) {
      var my = yTop - (yTop - yBot) * (y + 0.5) / CH;
      var lat = (2 * Math.atan(Math.exp(my)) - Math.PI / 2) / RAD;
      var gy = (lat - lats[0]) / (lats[H - 1] - lats[0]) * (H - 1);
      var y0 = Math.max(0, Math.min(H - 2, Math.floor(gy)));
      var fy = Math.max(0, Math.min(1, gy - y0));
      for (var x = 0; x < CW; x++) {
        var gx = x / CW * W;
        var x0 = Math.floor(gx) % W;
        var fx = gx - Math.floor(gx);
        var x1 = (x0 + 1) % W;
        var v00 = grid[y0 * W + x0], v10 = grid[y0 * W + x1];
        var v01 = grid[(y0 + 1) * W + x0], v11 = grid[(y0 + 1) * W + x1];
        var v;
        if (isNaN(v00) && isNaN(v10) && isNaN(v01) && isNaN(v11)) { v = NaN; }
        else {
          // treat missing neighbours as 0 so the edge fades instead of tearing
          v = (isNaN(v00) ? 0 : v00) * (1 - fx) * (1 - fy) +
              (isNaN(v10) ? 0 : v10) * fx * (1 - fy) +
              (isNaN(v01) ? 0 : v01) * (1 - fx) * fy +
              (isNaN(v11) ? 0 : v11) * fx * fy;
        }
        var o = (y * CW + x) * 4;
        if (!isNaN(v) && v > 0.02) {
          // the shadow, printed as actual shadow: black, deeper where more
          // of the Sun is gone
          px[o] = 0; px[o + 1] = 0; px[o + 2] = 0;
          px[o + 3] = Math.min(120, v * 125);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    S.layers.heat = L.imageOverlay(cv.toDataURL('image/png'),
      [[latBot, -180], [latTop, 180]],
      { pane: 'heat', opacity: 0.85, interactive: false }).addTo(map);

    buildContours(grid, lats, lons, W, H);
  }

  /* marching-squares contours of the obscuration field */
  function buildContours(grid, lats, lons, W, H) {
    var P = palette();
    var levels = [0.2, 0.4, 0.6, 0.8];
    var layers = [];
    levels.forEach(function (lv) {
      var segs = [];
      for (var y = 0; y < H - 1; y++) {
        for (var x = 0; x < W - 1; x++) {
          var v = [grid[y * W + x], grid[y * W + x + 1],
                   grid[(y + 1) * W + x + 1], grid[(y + 1) * W + x]];
          if (v.some(isNaN)) continue;
          var idx = (v[0] > lv ? 1 : 0) | (v[1] > lv ? 2 : 0) |
                    (v[2] > lv ? 4 : 0) | (v[3] > lv ? 8 : 0);
          if (idx === 0 || idx === 15) continue;
          var pts = cellSegments(idx, v, lv, lats[y], lats[y + 1],
                                 lons[x], lons[x + 1]);
          for (var s = 0; s < pts.length; s += 2) {
            segs.push([pts[s], pts[s + 1]]);
          }
        }
      }
      if (segs.length) {
        layers.push(L.polyline(segs, {
          color: P.ink, weight: 0.7, opacity: 0.4, interactive: false
        }));
        // one label per level, on a segment ~1/3 through the list
        var at = segs[Math.floor(segs.length / 3)][0];
        layers.push(L.marker(at, {
          interactive: false,
          icon: L.divIcon({ className: '', iconSize: [40, 12],
            html: '<div class="ct-label">' + Math.round(lv * 100) + '%</div>' })
        }));
      }
    });
    if (layers.length) S.layers.contours = L.layerGroup(layers).addTo(map);
  }

  function cellSegments(idx, v, lv, latA, latB, lonA, lonB) {
    // edge interpolators: 0 top, 1 right, 2 bottom, 3 left (grid row = latA)
    function lerp(a, b) { return (lv - a) / (b - a); }
    function edge(e) {
      switch (e) {
        case 0: return [latA, lonA + (lonB - lonA) * lerp(v[0], v[1])];
        case 1: return [latA + (latB - latA) * lerp(v[1], v[2]), lonB];
        case 2: return [latB, lonA + (lonB - lonA) * lerp(v[3], v[2])];
        case 3: return [latA + (latB - latA) * lerp(v[0], v[3]), lonA];
      }
    }
    var TABLE = {
      1: [3, 0], 2: [0, 1], 3: [3, 1], 4: [1, 2], 5: [3, 0, 1, 2],
      6: [0, 2], 7: [3, 2], 8: [2, 3], 9: [0, 2] /* mirrored */, 10: [0, 3, 2, 1],
      11: [1, 2] /* … */, 12: [1, 3], 13: [0, 1], 14: [0, 3]
    };
    // note: cases 9/11/13/14 are the complements of 6/4/2/1; the pairs above
    // draw the same geometric crossing, which is all a contour line needs
    var e = TABLE[idx] || [];
    var out = [];
    for (var i = 0; i < e.length; i++) out.push(edge(e[i]));
    return out;
  }

  /* ================= dynamic layers (clock-driven) ================= */

  function updateDynamic() {
    var ecl = S.ecl, t = S.T;
    var P = palette();

    // umbra
    var out = Bessel.shadowOutline(ecl, t, 'umbra', 90);
    if (out) {
      var ll = unwrap(out);
      if (!S.layers.umbra) {
        S.layers.umbra = L.polygon(ll, {
          pane: 'eclShadow', color: P.ink, weight: 1.6, opacity: 0.9,
          fillColor: '#000', fillOpacity: 0.72, interactive: false
        }).addTo(map);
      } else { S.layers.umbra.setLatLngs(ll); }
    } else { clearRole('umbra'); }

    // penumbra
    var pout = Bessel.shadowOutline(ecl, t, 'penumbra', 120);
    if (pout) {
      var pll = unwrap(pout);
      if (!S.layers.penumbra) {
        S.layers.penumbra = L.polygon(pll, {
          pane: 'night', color: P.ink, weight: 0.8, opacity: 0.3,
          dashArray: '3 6', fillColor: '#000', fillOpacity: 0.1,
          interactive: false
        }).addTo(map);
      } else { S.layers.penumbra.setLatLngs(pll); }
    } else { clearRole('penumbra'); }

    // night side
    var ss = Bessel.subsolar(ecl, t);
    var night = [];
    var ghaRad = -ss.lon * RAD, decRad = ss.lat * RAD;
    for (var lon = -180; lon <= 180; lon += 2) {
      var Hh = ghaRad + lon * RAD;
      night.push([Math.atan(-Math.cos(Hh) / Math.tan(decRad)) / RAD, lon]);
    }
    var poleLat = ss.lat > 0 ? -85 : 85;
    night.push([poleLat, 180]); night.push([poleLat, -180]);
    if (!S.layers.night) {
      S.layers.night = L.polygon(night, {
        pane: 'night', stroke: false, fillColor: '#010409', fillOpacity: 0.5,
        interactive: false
      }).addTo(map);
    } else { S.layers.night.setLatLngs(night); }

    // clock + readouts
    $('clock-ut').textContent = fmtUT(Bessel.toDate(ecl, t));
    var c = Bessel.centralPointAt(ecl, t);
    if (c && S.tracking) map.panTo([c.lat, c.lon], { animate: false });
    if (c) {
      var c2 = Bessel.centralPointAt(ecl, t + 30 / 3600);
      var vel = c2 ? Bessel.distKm(c.lat, c.lon, c2.lat, c2.lon) / 30 : null;
      $('ro-shadow').textContent = 'umbra ' + fmtLat(c.lat) + ' ' + fmtLon(c.lon);
      $('ro-vel').textContent = vel ? vel.toFixed(2) + ' km/s' : '—';
      var near = nearestCenter(c.lat, c.lon);
      $('ro-dur').textContent = near ? 'totality ' + fmtDur(near.duration) : '—';
    } else {
      $('ro-shadow').textContent = 'umbra off Earth';
      $('ro-vel').textContent = '—'; $('ro-dur').textContent = '—';
    }

    // scrub position
    var frac = (t - S.tMin) / (S.tMax - S.tMin);
    $('scrub').value = Math.round(frac * 1000);
  }

  function nearestCenter(lat, lon) {
    var best = null, bd = 1e9;
    var cs = S.path.center;
    for (var i = 0; i < cs.length; i += 2) {
      var d = Bessel.distKm(lat, lon, cs[i].lat, cs[i].lon);
      if (d < bd) { bd = d; best = cs[i]; }
    }
    return best;
  }

  /* ================= timeline ================= */

  function setTime(t, fromScrub) {
    S.T = Math.max(S.tMin, Math.min(S.tMax, t));
    updateDynamic();
    if (!fromScrub) { /* scrub already updated in updateDynamic */ }
  }

  var lastFrame = null;
  function frame(ts) {
    if (!S.playing) return;
    if (lastFrame !== null) {
      var speed = +$('speed').value;
      setTime(S.T + (ts - lastFrame) / 1000 * speed / 3600);
      if (S.T >= S.tMax) togglePlay(false);
    }
    lastFrame = ts;
    requestAnimationFrame(frame);
  }
  // drawn glyphs, not characters: iOS renders U+25B6 as an emoji sticker
  var GLYPH_PLAY = '<svg width="13" height="13" viewBox="0 0 16 16" ' +
    'aria-hidden="true"><path d="M4 2.5 13.2 8 4 13.5z" fill="currentColor"/></svg>';
  var GLYPH_PAUSE = '<svg width="13" height="13" viewBox="0 0 16 16" ' +
    'aria-hidden="true"><path d="M4.2 2.5h2.6v11H4.2zM9.2 2.5h2.6v11H9.2z" ' +
    'fill="currentColor"/></svg>';
  function togglePlay(on) {
    S.playing = on === undefined ? !S.playing : on;
    $('play').innerHTML = S.playing ? GLYPH_PAUSE : GLYPH_PLAY;
    if (S.playing) { lastFrame = null; requestAnimationFrame(frame); }
  }
  $('play').addEventListener('click', function () { togglePlay(); });
  $('track').addEventListener('click', function () {
    S.tracking = !S.tracking;
    this.setAttribute('aria-pressed', String(S.tracking));
    if (S.tracking) {
      var c = Bessel.centralPointAt(S.ecl, S.T);
      if (c) map.flyTo([c.lat, c.lon], Math.min(map.getZoom(), 6));
    }
  });
  $('scrub').addEventListener('input', function () {
    togglePlay(false);
    setTime(S.tMin + (S.tMax - S.tMin) * (+this.value / 1000), true);
  });

  function buildTimeline() {
    var g = S.gt;
    S.tMin = (g.p1 !== null ? g.p1 : g.tGE - 2) - 0.15;
    S.tMax = (g.p4 !== null ? g.p4 : g.tGE + 2) + 0.15;
    var marks = $('scrub-marks');
    marks.innerHTML = '';
    var defs = [['P1', g.p1], ['U1', g.u1], ['MAX', g.tGE], ['U4', g.u4], ['P4', g.p4]];
    defs.forEach(function (d) {
      if (d[1] === null) return;
      var f = (d[1] - S.tMin) / (S.tMax - S.tMin) * 100;
      var i = document.createElement('i');
      i.style.left = f + '%';
      marks.appendChild(i);
      var lb = document.createElement('label');
      lb.style.left = f + '%';
      lb.textContent = d[0];
      marks.appendChild(lb);
    });
    var band = $('scrub-band');
    if (g.u1 !== null && g.u4 !== null) {
      band.style.left = ((g.u1 - S.tMin) / (S.tMax - S.tMin) * 100) + '%';
      band.style.width = ((g.u4 - g.u1) / (S.tMax - S.tMin) * 100) + '%';
      band.style.display = '';
    } else { band.style.display = 'none'; }
    setTime(g.u1 !== null ? g.u1 : S.tMin);
  }

  /* ================= mission intel panel ================= */

  function buildIntel() {
    var g = S.gt;
    var pathKm = 0;
    var cs = S.path.center;
    for (var i = 1; i < cs.length; i++) {
      pathKm += Bessel.distKm(cs[i - 1].lat, cs[i - 1].lon, cs[i].lat, cs[i].lon);
    }
    var stats = [
      ['type', S.type],
      ['gamma', g.gamma.toFixed(4)],
      ['ratio', g.ratioGE ? g.ratioGE.toFixed(4) : '—'],
      ['max ' + (S.type === 'annular' ? 'annularity' : 'totality'),
        fmtDur(g.maxDuration)],
      ['path', pathKm ? Math.round(pathKm).toLocaleString() + ' km' : '—'],
      ['greatest', g.latGE !== null ?
        fmtLat(g.latGE) + ' ' + fmtLon(g.lonGE) : '—']
    ];
    $('intel-stats').innerHTML = stats.map(function (s) {
      return '<dt>' + s[0] + '</dt><dd>' + esc(s[1]) + '</dd>';
    }).join('');
    var rows = [
      ['P1', g.p1Date], ['U1', g.u1Date], ['MAX', g.dateGE],
      ['U4', g.u4Date], ['P4', g.p4Date]
    ];
    $('tl-rows').innerHTML = rows.map(function (r, i) {
      return '<div class="tl-row"><b>' + r[0] + '</b><code>' +
             fmtUT(r[1]) + '</code><span></span>' +
             '<button class="btn-ghost" type="button" data-jump="' + i +
             '">go</button></div>';
    }).join('');
    $('tl-rows').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        var g2 = S.gt;
        var ts = [g2.p1, g2.u1, g2.tGE, g2.u4, g2.p4];
        var t = ts[+b.dataset.jump];
        if (t !== null) {
          togglePlay(false); setTime(t);
          var c = Bessel.centralPointAt(S.ecl, S.T);
          // fly out far enough that the umbra is actually in frame
          if (c) map.flyTo([c.lat, c.lon], Math.min(map.getZoom(), 5));
        }
      });
    });
  }

  /* ================= target dossier ================= */

  var reticle = null;

  function setTarget(lat, lon, opts) {
    opts = opts || {};
    if (S.aborter) S.aborter.abort();
    S.aborter = (typeof AbortController !== 'undefined') ?
      new AbortController() : null;
    var signal = S.aborter ? S.aborter.signal : undefined;

    S.target = { lat: lat, lon: lon, elev: null, circ: null, wx: null,
                 terrain: null, offSec: null };
    if (reticle) map.removeLayer(reticle);
    reticle = L.marker([lat, lon], {
      interactive: false,
      icon: L.divIcon({
        className: 'reticle', iconSize: [46, 46], iconAnchor: [23, 23],
        html: '<div class="r-ring"></div><div class="r-cross"></div>'
      })
    }).addTo(map);

    $('dossier').hidden = false;
    $('tgt-name').textContent = '…';
    $('tgt-coords').textContent = fmtLat(lat) + ' ' + fmtLon(lon);
    $('tgt-elev').textContent = 'elev —';
    $('terrain-status').textContent = ''; $('terrain-status').className = 'h-status';
    $('wx-status').textContent = ''; $('wx-status').className = 'h-status';
    $('terrain-body').innerHTML = '<p class="terrain-note">…</p>';
    $('wx-body').innerHTML = '<p class="terrain-note">…</p>';

    // instant: the astronomy
    var circ = Bessel.localCircumstances(S.ecl, lat, lon, 0);
    S.target.circ = circ;
    renderCirc();
    renderVerdict();
    location.hash = S.ecl.id + '/' + lat.toFixed(4) + ',' + lon.toFixed(4);

    // name
    Wx.placeName(lat, lon, signal).then(function (nm) {
      if (S.target && S.target.lat === lat) {
        $('tgt-name').textContent = nm || 'unnamed location';
      }
    });

    // elevation, then refined circumstances
    Terrain.elevationAt(lat, lon, 12).then(function (e) {
      if (!S.target || S.target.lat !== lat) return;
      if (e !== null) {
        S.target.elev = e;
        $('tgt-elev').textContent = 'elev ' + Math.round(e) + ' m';
        S.target.circ = Bessel.localCircumstances(S.ecl, lat, lon, e);
        renderCirc();
      } else {
        $('tgt-elev').textContent = 'elev n/a';
      }
    });

    // weather
    if (circ) {
      Wx.get([{ lat: lat, lon: lon }], circ.dateMax, signal)
        .then(function (res) {
          if (!S.target || S.target.lat !== lat) return;
          S.target.wx = res;
          S.target.offSec = res.data[0].utcOffsetSec;
          $('wx-status').textContent = 'loaded'; $('wx-status').className = 'h-status ok';
          renderCirc();          // now with local clock
          renderWeather();
          renderVerdict();
        })
        .catch(function (err) {
          if (err && err.name === 'AbortError') return;
          $('wx-status').textContent = 'unreachable'; $('wx-status').className = 'h-status err';
          $('wx-body').innerHTML =
            '<p class="terrain-note">sky unreachable</p>';
        });
    } else {
      $('wx-body').innerHTML = '<p class="terrain-note">no eclipse</p>';
    }

    // terrain horizon
    if (circ && circ.visible) {
      var azs = [circ.sunAz];
      [circ.c1, circ.c4].forEach(function (ct) { if (ct) azs.push(ct.az); });
      var lo = Math.min.apply(null, azs), hi = Math.max.apply(null, azs);
      if (hi - lo > 180) { /* wrapped: rare, widen fully */ lo = circ.sunAz - 80; hi = circ.sunAz + 80; }
      var center = (lo + hi) / 2;
      var span = Math.max(90, Math.min(160, hi - lo + 44));
      $('terrain-status').textContent = 'scanning 0%';
      Terrain.horizonScan(lat, lon, {
        azCenter: center, azSpan: span, azStep: 1, maxKm: 120,
        signal: signal,
        onProgress: function (f) {
          $('terrain-status').textContent = 'scanning ' + Math.round(f * 100) + '%';
        }
      }).then(function (scan) {
        if (!S.target || S.target.lat !== lat) return;
        S.target.terrain = scan;
        $('terrain-status').textContent = Terrain.cacheSize() + ' tiles';
        $('terrain-status').className = 'h-status ok';
        renderTerrain();
        renderVerdict();
      }).catch(function (err) {
        if (err && err.message === 'aborted') return;
        $('terrain-status').textContent = 'scan failed';
        $('terrain-status').className = 'h-status err';
        $('terrain-body').innerHTML =
          '<p class="terrain-note">no elevation data</p>';
      });
    } else {
      $('terrain-body').innerHTML = '<p class="terrain-note">' +
        (circ ? 'below horizon' : 'no eclipse') + '</p>';
    }

    if (!opts.keepView && !map.getBounds().contains([lat, lon])) {
      map.panTo([lat, lon]);
    }
  }

  $('dossier-close').addEventListener('click', function () {
    $('dossier').hidden = true;
    if (reticle) { map.removeLayer(reticle); reticle = null; }
    S.target = null;
    location.hash = S.ecl.id;
  });

  map.on('click', function (ev) {
    setTarget(ev.latlng.lat, ((ev.latlng.lng + 540) % 360) - 180,
              { keepView: true });
  });

  /* ---- local circumstances table ---- */

  function renderCirc() {
    var t = S.target;
    if (!t) return;
    var c = t.circ;
    if (!c) {
      $('circ-body').innerHTML = '<p class="terrain-note">outside the penumbra</p>';
      return;
    }
    var off = t.offSec;
    var typeWord = c.type === 'partial' ?
        'partial · ' + Math.round(c.obscuration * 100) + '%' :
        c.type + ' · ' + fmtDur(c.duration);
    var typeCls = c.type === 'total' ? 'total' : 'partial';
    var html = '<div class="circ-type"><b class="' + typeCls + '">' +
               typeWord + '</b></div>';
    if (!c.visible) {
      html += '<p class="terrain-note">below horizon throughout</p>';
    }
    var rows = [
      ['C1', c.c1, 'partial begins'],
      ['C2', c.c2, 'totality begins'],
      ['MAX', { date: c.dateMax, alt: c.sunAlt, az: c.sunAz }, 'maximum eclipse'],
      ['C3', c.c3, 'totality ends'],
      ['C4', c.c4, 'partial ends']
    ];
    html += '<table class="circ"><tr><th></th><th>UT</th>' +
            (off !== null ? '<th>site ' + fmtOffset(off) + '</th>' : '') +
            '<th>alt</th><th>az</th></tr>';
    rows.forEach(function (r) {
      if (!r[1]) return;
      var hl = r[0] === 'C2' || r[0] === 'C3';
      html += '<tr' + (hl ? ' class="hl"' : '') + '><th>' + r[0] + '</th>' +
        '<td>' + fmtUT(r[1].date) + '</td>' +
        (off !== null ? '<td>' + (fmtLocal(r[1].date, off) || '—') + '</td>' : '') +
        '<td' + (r[1].alt < 0 ? ' class="dim"' : '') + '>' +
        r[1].alt.toFixed(1) + '°</td>' +
        '<td>' + compass(r[1].az) + '</td></tr>';
    });
    html += '</table>';
    html += '<div class="circ-facts">' +
      fact('magnitude', c.magnitude.toFixed(3)) +
      fact('obscuration', (c.obscuration * 100).toFixed(1) + '%') +
      fact('sun at max', c.sunAlt.toFixed(1) + '° ' + compass(c.sunAz)) +
      fact('refracted alt', c.sunAltApparent.toFixed(1) + '°');
    if (c.type !== 'total' && S.path.center.length) {
      var near = nearestPathKm(t.lat, t.lon);
      html += fact('centreline dist', Math.round(near.d) + ' km ' + near.dir);
    }
    html += '</div>';
    $('circ-body').innerHTML = html;
  }
  function fact(k, v) {
    return '<div><span>' + k + '</span><code>' + esc(v) + '</code></div>';
  }
  function nearestPathKm(lat, lon) {
    var best = 1e9, bp = null;
    S.path.center.forEach(function (p) {
      var d = Bessel.distKm(lat, lon, p.lat, p.lon);
      if (d < best) { best = d; bp = p; }
    });
    var brg = bp ? (Bessel.bearing(lat, lon, bp.lat, bp.lon) / RAD + 360) % 360 : 0;
    return { d: best, dir: bp ? compass(brg) : '' };
  }

  /* ---- terrain mask chart ---- */

  function sunTrackSamples() {
    var t = S.target, c = t.circ;
    var t1 = c.c1 ? c.c1.tTT : c.tMax - 1, t2 = c.c4 ? c.c4.tTT : c.tMax + 1;
    var out = [];
    var n = 56;
    for (var i = 0; i <= n; i++) {
      var tt = t1 + (t2 - t1) * i / n;
      var sun = Bessel.sunAltAz(S.ecl, tt, t.lat, t.lon);
      out.push({
        t: tt, az: sun.az,
        alt: sun.alt + Bessel.refraction(sun.alt),
        phase: (c.c2 && c.c3 && tt >= c.c2.tTT && tt <= c.c3.tTT) ? 'total' : 'partial'
      });
    }
    return out;
  }

  function horizonAngleAt(profile, az) {
    var n = profile.length;
    if (!n) return -0.6;
    var a0 = profile[0].az;
    // profile azimuths ascend by construction (deg, possibly through 360)
    var rel = ((az - a0) % 360 + 360) % 360;
    var step = ((profile[n - 1].az - a0) % 360 + 360) % 360 / (n - 1 || 1);
    var idx = step > 0 ? rel / step : 0;
    if (idx <= 0) return profile[0].ang;
    if (idx >= n - 1) return profile[n - 1].ang;
    var i0 = Math.floor(idx), f = idx - i0;
    return profile[i0].ang * (1 - f) + profile[i0 + 1].ang * f;
  }

  function renderTerrain() {
    var t = S.target;
    var scan = t.terrain, c = t.circ;
    if (!scan || !c) return;
    var P = palette();
    var track = sunTrackSamples();
    var prof = scan.profile;

    var W = 336, H = 168, mL = 30, mR = 8, mT = 10, mB = 22;
    var azMin = prof[0].az, n = prof.length;
    var azSpanTotal = ((prof[n - 1].az - azMin) % 360 + 360) % 360 || 1;
    var maxAng = Math.max(6,
      Math.max.apply(null, prof.map(function (p) { return p.ang; })) + 2,
      Math.max.apply(null, track.map(function (p) { return p.alt; })) + 3);
    var minAng = -1.5;
    function X(az) {
      var rel = ((az - azMin) % 360 + 360) % 360;
      if (rel > azSpanTotal) rel = rel - 360 < 0 ? 0 : azSpanTotal;
      return mL + rel / azSpanTotal * (W - mL - mR);
    }
    function Y(ang) {
      return mT + (maxAng - ang) / (maxAng - minAng) * (H - mT - mB);
    }

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
      'aria-label="Horizon profile with the Sun’s eclipse track">';
    // gridlines
    for (var g = 0; g <= maxAng; g += 5) {
      svg += '<line x1="' + mL + '" x2="' + (W - mR) + '" y1="' + Y(g) +
        '" y2="' + Y(g) + '" stroke="' + P.hair + '" stroke-width="0.6"/>' +
        '<text x="' + (mL - 4) + '" y="' + (Y(g) + 3) + '" text-anchor="end" ' +
        'font-size="7.5" fill="' + P.faint + '">' + g + '°</text>';
    }
    // horizon zero line
    svg += '<line x1="' + mL + '" x2="' + (W - mR) + '" y1="' + Y(0) + '" y2="' +
      Y(0) + '" stroke="' + P.faint + '" stroke-width="0.7" stroke-dasharray="2 3"/>';
    // terrain silhouette, printed solid
    var d = 'M' + X(prof[0].az) + ',' + Y(Math.max(minAng, prof[0].ang));
    prof.forEach(function (p) {
      d += 'L' + X(p.az).toFixed(1) + ',' + Y(Math.max(minAng, p.ang)).toFixed(1);
    });
    d += 'L' + X(prof[n - 1].az) + ',' + Y(minAng) + 'L' + X(prof[0].az) + ',' +
         Y(minAng) + 'Z';
    svg += '<path d="' + d + '" fill="' + P.ink + '" fill-opacity="0.85"/>';
    // sun track segments: grey partial, plate-3 totality, plate-2 hidden
    for (var i = 1; i < track.length; i++) {
      var a = track[i - 1], b = track[i];
      var blocked = b.alt < horizonAngleAt(prof, b.az);
      var col = blocked ? P.danger : (b.phase === 'total' ? P.totalLine : P.faint);
      var wd = b.phase === 'total' ? 3 : 1.8;
      svg += '<line x1="' + X(a.az).toFixed(1) + '" y1="' + Y(a.alt).toFixed(1) +
        '" x2="' + X(b.az).toFixed(1) + '" y2="' + Y(b.alt).toFixed(1) +
        '" stroke="' + col + '" stroke-width="' + wd + '"' +
        (blocked ? ' stroke-dasharray="3 2"' : '') + '/>';
    }
    // max-eclipse sun disc
    var sunMax = { az: c.sunAz, alt: c.sunAltApparent };
    svg += '<circle cx="' + X(sunMax.az).toFixed(1) + '" cy="' +
      Y(sunMax.alt).toFixed(1) + '" r="4" fill="none" stroke="' + P.ink +
      '" stroke-width="1.3"/>';
    // contact labels
    [['C2', c.c2], ['C3', c.c3]].forEach(function (ct) {
      if (!ct[1]) return;
      svg += '<text x="' + X(ct[1].az).toFixed(1) + '" y="' +
        (Y(ct[1].alt + Bessel.refraction(ct[1].alt)) - 6).toFixed(1) +
        '" text-anchor="middle" font-size="7.5" fill="' + P.total + '">' +
        ct[0] + '</text>';
    });
    // x axis: compass ticks every 15 deg
    for (var az = Math.ceil(azMin / 15) * 15; ; az += 15) {
      var rel = ((az - azMin) % 360 + 360) % 360;
      if (rel > azSpanTotal) break;
      svg += '<text x="' + X(az).toFixed(1) + '" y="' + (H - 8) +
        '" text-anchor="middle" font-size="7.5" fill="' + P.faint + '">' +
        compass(az) + '</text>';
      if (az > azMin + 720) break;    // safety
    }
    // legend (direct labels, small)
    svg += '<text x="' + (W - mR) + '" y="' + (mT + 2) + '" text-anchor="end" ' +
      'font-size="7.5" fill="' + P.faint + '">partial</text>' +
      '<text x="' + (W - mR) + '" y="' + (mT + 12) + '" text-anchor="end" ' +
      'font-size="7.5" fill="' + P.total + '">totality</text>' +
      '<text x="' + (W - mR) + '" y="' + (mT + 22) + '" text-anchor="end" ' +
      'font-size="7.5" fill="' + P.danger + '">hidden</text>';
    svg += '</svg>';

    // verdict text
    var v = terrainVerdict();
    var note = '<p class="terrain-note">r 120 km · obs ' +
      Math.round(scan.siteElev) + ' m + 2 m · curvature + refraction k 0.13</p>';
    $('terrain-body').innerHTML =
      '<div class="hz-wrap">' + svg + '<div class="hz-tip"></div></div>' +
      '<div class="terrain-verdict">' + v.html + '</div>' + note;
    attachHzTip(prof, track);
  }

  function terrainVerdict() {
    var t = S.target, c = t.circ, scan = t.terrain;
    if (!scan || !c) return { code: 'unknown', html: '' };
    var prof = scan.profile;
    function blockedAt(tt) {
      var sun = Bessel.sunAltAz(S.ecl, tt, t.lat, t.lon);
      var alt = sun.alt + Bessel.refraction(sun.alt);
      return alt < horizonAngleAt(prof, sun.az);
    }
    if (c.type === 'total' && c.c2 && c.c3) {
      var nb = 24, blocked = 0, margins = [];
      for (var i = 0; i <= nb; i++) {
        var tt = c.c2.tTT + (c.c3.tTT - c.c2.tTT) * i / nb;
        var sun = Bessel.sunAltAz(S.ecl, tt, t.lat, t.lon);
        var alt = sun.alt + Bessel.refraction(sun.alt);
        var hz = horizonAngleAt(prof, sun.az);
        margins.push(alt - hz);
        if (alt < hz) blocked++;
      }
      var minMargin = Math.min.apply(null, margins);
      var frac = 1 - blocked / (nb + 1);   // of the central phase, visible
      if (blocked === 0) {
        return { code: 'clear', margin: minMargin, frac: 1, html:
          '<b class="ok">clear</b> <code>+' + minMargin.toFixed(1) +
          '° min</code>' };
      }
      if (blocked > nb - 2) {
        return { code: 'blocked', margin: minMargin, frac: 0, html:
          '<b class="bad">blocked</b> <code>' + minMargin.toFixed(1) +
          '°</code>' };
      }
      return { code: 'partial', margin: minMargin, frac: frac, html:
        '<b class="part">partial</b> <code>' +
        Math.round((1 - frac) * 100) + '% behind terrain</code>' };
    }
    // partial-phase site: how much of the show clears the ridge?
    var nb2 = 30, seen = 0;
    var t1 = c.c1 ? c.c1.tTT : c.tMax - 1, t2 = c.c4 ? c.c4.tTT : c.tMax + 1;
    for (var j = 0; j <= nb2; j++) {
      if (!blockedAt(t1 + (t2 - t1) * j / nb2)) seen++;
    }
    var pct = Math.round(seen / (nb2 + 1) * 100);
    return { code: pct > 80 ? 'clear' : pct > 20 ? 'partial' : 'blocked',
      frac: pct / 100,
      html: '<b class="' + (pct > 80 ? 'ok' : pct > 20 ? 'part' : 'bad') +
        '">' + (pct > 80 ? 'clear' : pct > 20 ? 'partial' : 'blocked') +
        '</b> <code>' + pct + '% above terrain</code>' };
  }

  function attachHzTip(prof, track) {
    var wrap = document.querySelector('.hz-wrap');
    var tip = wrap.querySelector('.hz-tip');
    var svg = wrap.querySelector('svg');
    var azMin = prof[0].az;
    var azSpanTotal = ((prof[prof.length - 1].az - azMin) % 360 + 360) % 360 || 1;
    wrap.addEventListener('mousemove', function (ev) {
      var r = svg.getBoundingClientRect();
      var fx = (ev.clientX - r.left) / r.width * 336;
      if (fx < 30 || fx > 328) { tip.style.display = 'none'; return; }
      var az = azMin + (fx - 30) / (328 - 30) * azSpanTotal;
      var hz = horizonAngleAt(prof, az);
      // nearest profile entry for ridge distance
      var pi = Math.round(((az - azMin) % 360 + 360) % 360 /
        (azSpanTotal / (prof.length - 1)));
      var p = prof[Math.max(0, Math.min(prof.length - 1, pi))];
      tip.innerHTML = 'AZ ' + Math.round(az) + '° ' + compass(az) +
        ' · horizon ' + hz.toFixed(1) + '°' +
        (p && p.ang > 0.2 ? ' · ridge ' + p.distKm.toFixed(0) + ' km' : '');
      tip.style.display = 'block';
      tip.style.left = Math.min(r.width - 130, ev.clientX - r.left + 10) + 'px';
      tip.style.top = (ev.clientY - r.top - 26) + 'px';
    });
    wrap.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
  }

  /* ---- weather panel ---- */

  function renderWeather() {
    var t = S.target;
    if (!t || !t.wx || !t.circ) return;
    var mode = t.wx.mode;
    var pdata = t.wx.data[0];
    var c = Wx.atTime(pdata, t.circ.dateMax);
    var score = Wx.skyScore(c);
    var v = Wx.verdictFor(score);
    var vCls = v.code === 'GO' ? 'go' : v.code === 'COND' ? 'cond' : 'nogo';

    var modeLine = mode === 'forecast' ? '<b>forecast</b>' :
      mode === 'archive' ? '<b>archive</b> era5' :
        '<b>climatology</b> era5 × ' + (pdata.years || 8) + ' y';

    var html = '<div class="wx-mode">' + modeLine + '</div>';
    if (score !== null) {
      html += '<div class="wx-hero"><div class="wx-score ' + vCls + '">' +
        Math.round(score) + '</div><div><div class="lbl">sky / 100</div>' +
        '<div class="word ' + vCls + '">' + v.word + '</div></div></div>';
      html += '<div class="cloudbars">' +
        cbar('low', c.low) + cbar('mid', c.mid) + cbar('high', c.high) +
        cbar('total', c.total) + '</div>';
      html += '<div class="wx-extra">' +
        wxCell('precip', c.precipProb !== null && c.precipProb !== undefined ?
          Math.round(c.precipProb) + '%' :
          (c.precip !== null ? (c.precip || 0).toFixed(1) + ' mm' : '—')) +
        wxCell('wind', c.wind !== null ? Math.round(c.wind) + ' km/h' : '—') +
        wxCell('temp', c.temp !== null ? Math.round(c.temp) + '°C' : '—') +
        '</div>';
      html += wxStrip(pdata, t.circ);
    } else {
      html += '<p class="terrain-note">no data</p>';
    }
    $('wx-body').innerHTML = html;
  }
  function cbar(label, v) {
    var val = v === null || v === undefined ? 0 : v;
    return '<div class="cbar"><span class="t">' + label + '</span>' +
      '<span class="rail"><i style="width:' + Math.round(val) + '%"></i></span>' +
      '<span class="v">' + Math.round(val) + '%</span></div>';
  }
  function wxCell(k, v) {
    return '<div><span>' + k + '</span><code>' + v + '</code></div>';
  }
  /* small strip: total cloud through the day with the eclipse window shaded */
  function wxStrip(pdata, circ) {
    var hs = pdata.hours.filter(function (h) { return h.total !== null; });
    if (hs.length < 3) return '';
    var P = palette();
    var W = 336, H = 66, mL = 26, mR = 6, mT = 6, mB = 14;
    var t0 = hs[0].tUTCms, t1 = hs[hs.length - 1].tUTCms;
    function X(ms) { return mL + (ms - t0) / (t1 - t0) * (W - mL - mR); }
    function Y(v) { return mT + (100 - v) / 100 * (H - mT - mB); }
    var svg = '<div class="wx-strip"><svg viewBox="0 0 ' + W + ' ' + H +
      '" role="img" aria-label="Cloud cover through the day">';
    [0, 50, 100].forEach(function (g) {
      svg += '<line x1="' + mL + '" x2="' + (W - mR) + '" y1="' + Y(g) +
        '" y2="' + Y(g) + '" stroke="' + P.hair + '" stroke-width="0.6"/>' +
        '<text x="' + (mL - 3) + '" y="' + (Y(g) + 2.5) + '" text-anchor="end" ' +
        'font-size="7" fill="' + P.faint + '">' + g + '</text>';
    });
    // eclipse window, washed in the totality plate
    var w1 = circ.c1 ? circ.c1.date.getTime() : circ.dateMax.getTime();
    var w2 = circ.c4 ? circ.c4.date.getTime() : circ.dateMax.getTime();
    svg += '<rect x="' + X(w1).toFixed(1) + '" y="' + mT + '" width="' +
      Math.max(2, X(w2) - X(w1)).toFixed(1) + '" height="' + (H - mT - mB) +
      '" fill="' + P.totalLine + '" fill-opacity="0.12"/>';
    var mx = X(circ.dateMax.getTime());
    svg += '<line x1="' + mx.toFixed(1) + '" x2="' + mx.toFixed(1) + '" y1="' + mT +
      '" y2="' + (H - mB) + '" stroke="' + P.total +
      '" stroke-width="1" stroke-dasharray="2 2"/>';
    // cloud line
    var d = '';
    hs.forEach(function (h, i) {
      d += (i ? 'L' : 'M') + X(h.tUTCms).toFixed(1) + ',' + Y(h.total).toFixed(1);
    });
    svg += '<path d="' + d + '" fill="none" stroke="' + P.ink +
      '" stroke-width="1.5"/>';
    // time labels every 6 hours (site clock if known)
    var off = pdata.utcOffsetSec || 0;
    for (var ms = t0; ms <= t1; ms += 6 * 3600000) {
      var dd = new Date(ms + off * 1000);
      svg += '<text x="' + X(ms).toFixed(1) + '" y="' + (H - 3) +
        '" text-anchor="middle" font-size="7" fill="' + P.faint + '">' +
        pad2(dd.getUTCHours()) + 'h</text>';
    }
    svg += '<text x="' + (W - mR) + '" y="' + (mT + 6) + '" text-anchor="end" ' +
      'font-size="7" fill="' + P.faint + '">total cloud %</text>';
    return svg + '</svg></div>';
  }

  /* ---- assessment ---- */

  /* One suitability number, 0..100, and it is the same arithmetic the
     heatmap paints. Three factors, weighted by how certain each one is:

     TERRAIN, squared. The horizon is surveyed fact, not a forecast — a
     ridge does not clear up on the day. So the visible fraction of the
     central phase counts twice over: 90% visible costs a fifth, half
     visible costs three quarters, a quarter visible is nearly worthless,
     and fully blocked is the hard 0 it always was.

     SKY, softened. A forecast (or a climatology) is a probability, so a
     middling number must not kill a site the way a middling horizon does
     — the 0.75 power lifts the middle of the curve. It still runs to 0:
     a sky that is certainly storm is a site where the eclipse cannot be
     seen, and scores like one.

     DURATION, square-rooted. Half the maximum is still most of the show
     — any totality is the event — so duration separates sites gently
     rather than dominating them.

     The gates stay absolute — below the horizon, outside the central
     band, or fully behind terrain is 0 whatever the weather says. A null
     sky (service unreachable) drops the factor rather than the score,
     and the display says which. */
  function suitabilityOf(dur, visFrac, sky) {
    var durN = S.gt.maxDuration > 0 ? Math.min(1, dur / S.gt.maxDuration) : 0;
    var s = 100 * Math.sqrt(durN) * visFrac * visFrac *
            (sky === null ? 1 : Math.pow(sky / 100, 0.75));
    return Math.max(0, Math.min(100, s));
  }

  function renderVerdict() {
    var t = S.target;
    if (!t) return;
    var c = t.circ;
    var code, stamp;
    var rows = [];
    var central = c && c.type !== 'partial' && c.c2 && c.c3 &&
                  c.centralVisible !== false;

    var tv = t.terrain ? terrainVerdict() : null;
    var visFrac = tv ? tv.frac : null;     // null = terrain unknown
    var sky = t.wx ? Wx.skyScore(Wx.atTime(t.wx.data[0], c ? c.dateMax : 0)) : null;

    if (!c) { code = 'nogo'; stamp = 'no eclipse'; }
    else if (!c.visible) { code = 'nogo'; stamp = 'below horizon'; }
    else if (!central) { code = 'nogo'; stamp = 'outside path'; }
    else if (tv && tv.code === 'blocked') { code = 'nogo'; stamp = 'blocked'; }
    else {
      var wv = Wx.verdictFor(sky);
      var risky = (tv && tv.code === 'partial') ||
                  (tv && tv.margin !== undefined && tv.margin < 1.5) ||
                  wv.code === 'COND' || c.sunAlt < 3;
      code = wv.code === 'NOGO' ? 'nogo' : risky ? 'cond' : 'go';
      stamp = code === 'nogo' ? 'unsuitable' :
              code === 'cond' ? 'marginal' : 'suitable';
    }

    if (c) {
      rows.push(['phase', c.type === 'partial' ?
        'partial · ' + Math.round(c.obscuration * 100) + '%' :
        c.type + ' · ' + fmtDur(c.duration)]);
      rows.push(['sun', c.sunAlt.toFixed(1) + '° ' + compass(c.sunAz)]);
      if (!central) {
        var near = nearestPathKm(t.lat, t.lon);
        rows.push(['centreline', Math.round(near.d) + ' km ' + near.dir]);
      }
      rows.push(['horizon', tv ?
        (tv.code === 'clear' ? '+' + tv.margin.toFixed(1) + '°' :
         tv.code === 'blocked' ? 'blocked' :
         Math.round((1 - visFrac) * 100) + '% behind') : '…']);
      rows.push(['sky', sky === null ? (t.wx ? '—' : '…') :
        Math.round(sky) + ' · ' + t.wx.mode]);
      var suit = (!c.visible || !central) ? 0 :
        (visFrac === null ? null :
          suitabilityOf(c.duration, visFrac, sky));
      rows.push(['suitability', suit === null ? '…' :
        Math.round(suit) + (sky === null ? ' · no sky' : '')]);
    }

    $('verdict-body').innerHTML = '<div class="verdict ' + code + '">' +
      '<span class="stamp">' + stamp + '</span>' +
      '<div class="v-facts">' + rows.map(function (r) {
        return '<div><span>' + r[0] + '</span><code>' + esc(r[1]) +
               '</code></div>';
      }).join('') + '</div></div>';
  }

  /* ================= recon sweep ================= */

  $('sweep-btn').addEventListener('click', runSweep);

  function runSweep() {
    var ecl = S.ecl;
    var centers = S.path.center;
    if (!centers.length) return;
    var btn = $('sweep-btn');
    btn.disabled = true;
    $('sweep-progress').hidden = false;
    setProgress(0.05, 'sampling centreline');

    // every nth centre point, at most 72 probes
    var step = Math.max(1, Math.ceil(centers.length / 72));
    var pts = [];
    for (var i = 0; i < centers.length; i += step) pts.push(centers[i]);

    setProgress(0.15, 'retrieving sky data');
    Wx.get(pts.map(function (p) { return { lat: p.lat, lon: p.lon }; }),
           S.gt.dateGE)
      .then(function (res) {
        setProgress(0.8, 'scoring');
        var rows = pts.map(function (p, i) {
          var cond = Wx.atTime(res.data[i], p.date);
          var score = Wx.skyScore(cond);
          return {
            lat: p.lat, lon: p.lon, tTT: p.tTT, date: p.date,
            duration: p.duration, sunAlt: p.sunAlt,
            offSec: res.data[i].utcOffsetSec,
            cond: cond, score: score, v: Wx.verdictFor(score)
          };
        });
        drawSweep(rows, res.mode);
        return rankSweep(rows, res.mode);
      })
      .catch(function (e) {
        $('sweep-list').hidden = false;
        $('sweep-list').innerHTML =
          '<li><span class="meta">sky unreachable · ' + esc(e.message) +
          '</span></li>';
      })
      .then(function () {
        btn.disabled = false;
        $('sweep-progress').hidden = true;
      });
  }
  function setProgress(f, word) {
    $('sweep-progress').querySelector('i').style.width = (f * 100) + '%';
    $('sweep-progress').querySelector('span').textContent =
      (word || 'survey') + ' ' + Math.round(f * 100) + '%';
  }

  function sweepDotStyle(vCode) {
    var P = palette();
    return {
      pane: 'sweep', radius: 5, color: P.ink, weight: 1.5,
      fillColor: vCode === 'GO' ? P.okFill :
                 vCode === 'COND' ? P.citron : P.dangerFill,
      fillOpacity: 0.95
    };
  }
  function drawSweep(rows, mode) {
    clearRole('sweepDots');
    var marks = rows.map(function (r) {
      var mk = L.circleMarker([r.lat, r.lon], sweepDotStyle(r.v.code));
      mk._sweepV = r.v.code;
      return mk.bindTooltip(
        r.v.word + ' · ' + fmtUT(r.date) + ' UT · totality ' +
        fmtDur(r.duration) + ' · sun ' + r.sunAlt.toFixed(0) + '° · sky ' +
        (r.score === null ? '—' : Math.round(r.score)),
        { className: 'sweep-dot-tip', direction: 'top', offset: [0, -6] }
      ).on('click', function () { setTarget(r.lat, r.lon); });
    });
    S.layers.sweepDots = L.layerGroup(marks).addTo(map);
  }

  function rankSweep(rows, mode) {
    var ranked = rows.filter(function (r) { return r.score !== null; })
      .sort(function (a, b) {
        return (b.score - a.score) || (b.duration - a.duration);
      }).slice(0, 12);
    var list = $('sweep-list');
    list.hidden = false;
    list.innerHTML = '<li><span class="meta">sky · ' + mode + '</span></li>';
    return Promise.all(ranked.map(function (r) {
      return Wx.placeName(r.lat, r.lon).catch(function () { return null; });
    })).then(function (names) {
      ranked.forEach(function (r, i) {
        var li = document.createElement('li');
        var vCls = r.v.code === 'GO' ? 'go' : r.v.code === 'COND' ? 'cond' : 'nogo';
        li.innerHTML = '<span class="rk">' + pad2(i + 1) + '</span>' +
          '<span class="nm">' + esc(names[i] || 'unnamed location') + '</span>' +
          '<span class="sc ' + vCls + '">' +
          Math.round(r.score) + '</span>' +
          '<span class="meta">' + fmtLat(r.lat) + ' ' + fmtLon(r.lon) +
          ' · ' + fmtUT(r.date) + ' UT · ' + fmtDur(r.duration) +
          ' · sun ' + r.sunAlt.toFixed(0) + '°</span>';
        li.addEventListener('click', function () {
          map.flyTo([r.lat, r.lon], Math.max(map.getZoom(), 8));
          setTarget(r.lat, r.lon, { keepView: true });
        });
        list.appendChild(li);
      });
    });
  }

  /* ================= suitability field ================= */

  /* The verdict, as a place instead of a point: the dossier's suitability
     number computed for every cell of a grid over the current view and
     printed as a wash of plate 1, denser where the number is higher. Same
     arithmetic (suitabilityOf above), same gates — a cell whose Sun sits
     behind terrain for the whole central phase is 0 however clear the sky,
     a cell outside the central band is 0, and 0 is not painted at all.

     The grid trades exactness for coverage and says so by its coarseness:
     ~26 × 17 cells, each one judged at its centre. Terrain is the expensive
     part, so a cell is only scanned when it can matter — a central phase
     riding higher than 30° cannot be blocked by anything the cell itself
     would not resolve (that is a 3 km wall within 5 km), and the scan
     radius shrinks as the Sun climbs, since a ridge must subtend the Sun's
     own altitude to reach it. Sky comes batched from the weather desk on a
     coarser subgrid; if the desk is unreachable the wash simply drops that
     factor and the chip says sky —. */

  var SUIT = { on: false, run: 0, grid: null, aborter: null, wx: {} };

  function suitStart() {
    SUIT.on = true;
    $('suit-btn').setAttribute('aria-pressed', 'true');
    // the field paints inside the band, so the band's own dark wash steps
    // back while the field is up and returns when it goes
    if (S.layers.bandPoly) S.layers.bandPoly.setStyle({ fillOpacity: 0.08 });
    map.on('moveend', suitMoved);
    computeSuit();
  }
  function suitStop() {
    SUIT.on = false;
    SUIT.run++;
    if (SUIT.aborter) { SUIT.aborter.abort(); SUIT.aborter = null; }
    $('suit-btn').setAttribute('aria-pressed', 'false');
    if (S.layers.bandPoly) S.layers.bandPoly.setStyle({ fillOpacity: 0.34 });
    map.off('moveend', suitMoved);
    clearRole('suit');
    $('suit-legend').hidden = true;
    $('suit-prog').hidden = true;
    SUIT.grid = null;
  }
  var suitMoved = debounce(function () { if (SUIT.on) computeSuit(); }, 450);
  $('suit-btn').addEventListener('click', function () {
    if (SUIT.on) suitStop(); else suitStart();
  });

  function suitProg(f) {
    $('suit-prog').hidden = f >= 1;
    $('suit-prog').querySelector('i').style.width = (f * 100) + '%';
  }

  /* The field is sampled in the band's own frame, not the viewport's: rows
     across the umbral band (edge to edge, where the duration falls to
     nothing), columns along the visible stretch of centreline. That keeps
     the wash continuous at every zoom — a viewport grid at world zoom has
     cells wider than the band is, and paints noise.

     Each sample is judged exactly like the dossier judges a site: real
     local circumstances, the terrain gate, the sky. Along-track samples are
     spent on what the view can see, so zooming in buys resolution. */

  var ALONG = 44, ACROSS = 7;

  function computeSuit() {
    var run = ++SUIT.run;
    if (SUIT.aborter) SUIT.aborter.abort();
    SUIT.aborter = typeof AbortController !== 'undefined' ?
      new AbortController() : null;
    var signal = SUIT.aborter ? SUIT.aborter.signal : undefined;
    var dead = function () { return run !== SUIT.run; };

    var path = S.path;
    var nC = path.center.length;
    if (!nC || !path.north.length || !path.south.length) {
      SUIT.grid = { samples: [], sky: null };
      renderSuit(); suitProg(1);
      return;
    }
    suitProg(0.03);

    // the stretch of centreline the view can see, padded; all of it when
    // the view sees none (the map is elsewhere — still show the field)
    var b = map.getBounds().pad(0.25);
    var idx = [];
    for (var i = 0; i < nC; i++) {
      var pt = path.center[i];
      if (b.contains([pt.lat, pt.lon]) ||
          b.contains([pt.lat, pt.lon + 360]) ||
          b.contains([pt.lat, pt.lon - 360])) idx.push(i);
    }
    if (!idx.length) idx = path.center.map(function (_, i) { return i; });
    var step = Math.max(1, Math.floor(idx.length / ALONG));
    var cols = [];
    for (i = idx[0]; i <= idx[idx.length - 1]; i += step) cols.push(i);

    // band edges per column, longitudes unwrapped into one running frame
    var nN = path.north.length, nS = path.south.length;
    function edge(arr, n, i) {
      var j = Math.round(i / (nC - 1) * (n - 1));
      return arr[Math.max(0, Math.min(n - 1, j))];
    }
    var frame = null;
    function unwrapLon(lon) {
      if (frame === null) { frame = lon; return lon; }
      while (lon - frame > 180) lon -= 360;
      while (lon - frame < -180) lon += 360;
      frame = (frame * 3 + lon) / 4;
      return lon;
    }
    var rails = cols.map(function (ci) {
      var N = edge(path.north, nN, ci), Sd = edge(path.south, nS, ci);
      var nLon = unwrapLon(N.lon);
      var sLon = Sd.lon;
      while (sLon - nLon > 180) sLon -= 360;
      while (sLon - nLon < -180) sLon += 360;
      return { n: [N.lat, nLon], s: [Sd.lat, sLon] };
    });
    function railAt(k, f) {
      var r = rails[Math.max(0, Math.min(rails.length - 1, k))];
      return [r.n[0] + (r.s[0] - r.n[0]) * f, r.n[1] + (r.s[1] - r.n[1]) * f];
    }
    function railMid(k, f) {
      var a = railAt(k, f), c = railAt(k + 1, f);
      return [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
    }

    // the samples, with their quad corners
    var samples = [];
    for (var k = 0; k < cols.length; k++) {
      for (var j = 0; j < ACROSS; j++) {
        var f = (j + 0.5) / ACROSS;
        var at = railAt(k, f);
        var f0 = j / ACROSS, f1 = (j + 1) / ACROSS;
        samples.push({
          lat: at[0], lon: at[1],
          quad: [railMid(k - 1, f0), railMid(k - 1, f1),
                 railMid(k, f1), railMid(k, f0)],
          central: false, dur: 0, vis: null, sky: null, score: 0
        });
      }
    }

    // 1 · astronomy, cheap and exact
    samples.forEach(function (c) {
      var lon = ((c.lon + 540) % 360) - 180;
      var lc = Bessel.localCircumstances(S.ecl, c.lat, lon, 0);
      if (!lc || lc.type === 'partial' || !lc.c2 || !lc.c3 ||
          !lc.visible || !lc.centralVisible) return;
      var minAlt = Infinity, azs = [];
      for (var i = 0; i <= 6; i++) {
        var tt = lc.c2.tTT + (lc.c3.tTT - lc.c2.tTT) * i / 6;
        var sun = Bessel.sunAltAz(S.ecl, tt, c.lat, lon);
        var alt = sun.alt + Bessel.refraction(sun.alt);
        if (alt < minAlt) minAlt = alt;
        azs.push(sun.az);
      }
      if (minAlt <= -0.3) return;      // the Sun sets inside the central phase
      c.central = true; c.lc = lc; c.lonN = lon;
      c.minAlt = minAlt; c.azs = azs; c.dur = lc.duration;
      if (minAlt >= 30) c.vis = 1;     // nothing at sample scale blocks 30°
    });
    var central = samples.filter(function (c) { return c.central; });
    if (!central.length) {
      SUIT.grid = { samples: samples, sky: null };
      renderSuit(); suitProg(1);
      return;
    }

    // 2 · sky, batched on a coarse subgrid and shared by nearest sample
    var wxDone = fetchSuitSky(central, signal).catch(function () { return null; });

    // 3 · terrain, pooled, only where it can matter
    var scans = central.filter(function (c) { return c.vis === null; });
    var done = 0;
    function scanCell(c) {
      var lo = Math.min.apply(null, c.azs), hi = Math.max.apply(null, c.azs);
      if (hi - lo > 180) { lo = c.lc.sunAz - 12; hi = c.lc.sunAz + 12; }
      var maxKm = Math.min(120, Math.max(8,
        5.0 / Math.tan(Math.max(1, c.minAlt) * RAD)));
      return Terrain.horizonScan(c.lat, c.lonN, {
        azCenter: (lo + hi) / 2, azSpan: Math.min(60, hi - lo + 8),
        azStep: 3, maxKm: maxKm, eyeM: 2, signal: signal
      }).then(function (scan) {
        var n = 12, seen = 0;
        for (var i = 0; i <= n; i++) {
          var tt = c.lc.c2.tTT + (c.lc.c3.tTT - c.lc.c2.tTT) * i / n;
          var sun = Bessel.sunAltAz(S.ecl, tt, c.lat, c.lonN);
          var alt = sun.alt + Bessel.refraction(sun.alt);
          if (alt >= horizonAngleAt(scan.profile, sun.az)) seen++;
        }
        c.vis = seen / (n + 1);
      }).catch(function () {
        // no elevation data is the sea or a dead tile: an open horizon
        c.vis = 1;
      }).then(function () {
        done++;
        suitProg(0.1 + 0.8 * done / (scans.length || 1));
      });
    }
    var terrainDone = new Promise(function (resolve) {
      var i = 0, active = 0, LIMIT = 4;
      (function next() {
        if (dead()) { resolve(); return; }
        if (i >= scans.length && active === 0) { resolve(); return; }
        while (active < LIMIT && i < scans.length) {
          active++;
          scanCell(scans[i++]).then(function () { active--; next(); });
        }
      })();
    });

    Promise.all([wxDone, terrainDone]).then(function (res) {
      if (dead()) return;
      samples.forEach(function (c) {
        if (!c.central || c.vis === null) return;
        c.score = suitabilityOf(c.dur, c.vis, c.sky);
      });
      SUIT.grid = { samples: samples, sky: res[0] };
      renderSuit();
      suitProg(1);
    });
  }

  /* Sky for the field: one batched request on a ≤ 24-point subgrid over the
     central samples' bbox, cached per half-degree so panning does not
     refetch the world. Each sample reads the nearest subgrid point. */
  function fetchSuitSky(central, signal) {
    var la = central.map(function (c) { return c.lat; });
    var lo = central.map(function (c) { return c.lonN; });
    var la0 = Math.min.apply(null, la), la1 = Math.max.apply(null, la);
    var lo0 = Math.min.apply(null, lo), lo1 = Math.max.apply(null, lo);
    var pts = [];
    for (var r = 0; r < 4; r++) {
      for (var q = 0; q < 6; q++) {
        pts.push({ lat: la0 + (la1 - la0) * (r + 0.5) / 4,
                   lon: lo0 + (lo1 - lo0) * (q + 0.5) / 6 });
      }
    }
    var key = function (p) {
      return S.ecl.id + '|' + (Math.round(p.lat * 2) / 2) + '|' +
             (Math.round(p.lon * 2) / 2);
    };
    var need = pts.filter(function (p) { return !SUIT.wx[key(p)]; });
    var fetched = need.length ?
      Wx.get(need, S.gt.dateGE, signal).then(function (res) {
        need.forEach(function (p, i) { SUIT.wx[key(p)] = res.data[i]; });
        return res.mode;
      }) : Promise.resolve(Wx.modeFor(S.gt.dateGE));
    return fetched.then(function (mode) {
      central.forEach(function (c) {
        var best = null, bd = Infinity;
        pts.forEach(function (p) {
          var d = (p.lat - c.lat) * (p.lat - c.lat) +
                  (p.lon - c.lonN) * (p.lon - c.lonN);
          if (d < bd && SUIT.wx[key(p)]) { bd = d; best = SUIT.wx[key(p)]; }
        });
        c.sky = best ? Wx.skyScore(Wx.atTime(best, c.lc.dateMax)) : null;
      });
      return mode;
    });
  }

  /* Painted as one quad per sample in the band's own frame: plate 1,
     denser where the number is higher, nothing at all at 0. */
  function renderSuit() {
    clearRole('suit');
    var g = SUIT.grid;
    if (!g) return;
    var P = palette();
    var quads = [];
    g.samples.forEach(function (c) {
      if (c.score <= 0.5) return;
      quads.push(L.polygon(c.quad, {
        pane: 'suit', stroke: false, interactive: false,
        fillColor: P.okFill, fillOpacity: 0.06 + c.score / 100 * 0.66
      }));
    });
    if (quads.length) S.layers.suit = L.layerGroup(quads).addTo(map);
    $('suit-legend').hidden = false;
    $('suit-mode').textContent = 'sky · ' + (g.sky || '—');
  }


  /* ================= search ================= */

  /* Coordinates are a first-class query, tried before the geocoder ever
     sees the string. Two grammars: signed decimal ("46.62, 13.85",
     "-33.92 18.42") and degrees-minutes-seconds with hemisphere letters
     ("46°37'12"N 13°51'E", "46 37 N 13 51 E"), in either order — the
     letters say which number is which. */
  function parseCoords(q) {
    var m = q.match(
      /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
    if (m) {
      var lat = +m[1], lon = +m[2];
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat: lat, lon: lon };
      return null;
    }
    var re = /(\d{1,3}(?:\.\d+)?)(?:\s*[°\s]\s*(\d{1,2}(?:\.\d+)?))?(?:\s*['\s]\s*(\d{1,2}(?:\.\d+)?))?\s*(?:["'′″]*)\s*([NSEW])/gi;
    var lat2 = null, lon2 = null, mm;
    while ((mm = re.exec(q))) {
      var v = +mm[1] + (+mm[2] || 0) / 60 + (+mm[3] || 0) / 3600;
      var h = mm[4].toUpperCase();
      if (h === 'N' || h === 'S') lat2 = v * (h === 'S' ? -1 : 1);
      else lon2 = v * (h === 'W' ? -1 : 1);
    }
    if (lat2 !== null && lon2 !== null &&
        Math.abs(lat2) <= 90 && Math.abs(lon2) <= 180) {
      return { lat: lat2, lon: lon2 };
    }
    return null;
  }

  function goTo(lat, lon, zoom) {
    $('search-results').hidden = true;
    map.flyTo([lat, lon], Math.max(map.getZoom(), zoom || 9));
    setTarget(lat, lon, { keepView: true });
  }

  $('search').addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var co = parseCoords(this.value.trim());
    if (co) { ev.preventDefault(); goTo(co.lat, co.lon); }
  });

  $('search').addEventListener('input', debounce(function () {
    var q = this.value.trim();
    var ul = $('search-results');
    if (q.length < 2) { ul.hidden = true; return; }

    var co = parseCoords(q);
    if (co) {
      ul.innerHTML = '<li data-co><code>' + fmtLat(co.lat) + ' ' +
        fmtLon(co.lon) + '</code></li>';
      ul.hidden = false;
      ul.querySelector('li').addEventListener('click', function () {
        goTo(co.lat, co.lon);
      });
      return;
    }

    Wx.search(q).then(function (results) {
      ul.innerHTML = results.map(function (r, i) {
        return '<li data-i="' + i + '">' + esc(r.name) +
          ' <small>' + esc([r.admin1, r.country_code].filter(Boolean).join(', ')) +
          '</small></li>';
      }).join('') || '<li><small>no match</small></li>';
      ul.hidden = false;
      ul.querySelectorAll('li[data-i]').forEach(function (li) {
        li.addEventListener('click', function () {
          var r = results[+li.dataset.i];
          goTo(r.latitude, r.longitude);
        });
      });
    }).catch(function () {
      ul.innerHTML = '<li><small>search unreachable</small></li>';
      ul.hidden = false;
    });
  }, 350));

  /* ================= eclipse switching ================= */

  /* The opening view is the path itself: the bounds of the umbral track,
     fitted. A partial eclipse has no track, so it opens on the point under
     the shadow axis at greatest, wide. */
  function homeView(path, gt) {
    var pts = [];
    ['north', 'south'].forEach(function (k) {
      unwrap(path[k]).forEach(function (p) { pts.push(p); });
    });
    if (pts.length) {
      map.fitBounds(L.latLngBounds(pts), { padding: [36, 36], maxZoom: 6 });
    } else if (gt.latGE !== null) {
      map.setView([gt.latGE, gt.lonGE], 3);
    } else {
      map.setView([Bessel.subsolar(S.ecl, gt.tGE).lat, 0], 2);
    }
  }

  function loadEclipse(id, targetSpec) {
    var all = catalogue();
    // the default is the next eclipse to happen, not the first on the list
    var today = new Date().toISOString().slice(0, 10);
    var fallback = all.find(function (e) { return e.id >= today; }) ||
                   all[all.length - 1];
    var ecl = all.find(function (e) { return e.id === id; }) || fallback;
    S.ecl = ecl;
    $('eclipse-select').value = ecl.id;

    // teardown
    togglePlay(false);
    suitStop();
    Object.keys(S.layers).forEach(clearRole);
    if (reticle) { map.removeLayer(reticle); reticle = null; }
    S.target = null;
    $('dossier').hidden = true;
    $('sweep-list').hidden = true; $('sweep-list').innerHTML = '';

    var meta = metaFor(ecl);
    S.gt = meta.gt;
    S.path = Bessel.centralPath(ecl, 45);
    S.type = refineType(ecl, S.path, meta.type);
    buildIntel();
    buildTimeline();
    buildStatic();
    homeView(S.path, S.gt);
    location.hash = ecl.id;

    if (targetSpec) {
      setTarget(targetSpec[0], targetSpec[1]);
      map.setView(targetSpec, 8);
    }
  }

  var sel = $('eclipse-select');
  function buildSelect() {
    sel.innerHTML = '';
    catalogue().forEach(function (e) {
      var o = document.createElement('option');
      o.value = e.id; o.textContent = metaFor(e).label;
      sel.appendChild(o);
    });
  }
  buildSelect();
  sel.addEventListener('change', function () { loadEclipse(this.value); });

  /* Any other eclipse: paste the "Polynomial Besselian Elements" block off
     its NASA/GSFC page. Parsed, kept in localStorage, loaded at once. */
  var dlg = $('add-dlg');
  $('ecl-add').addEventListener('click', function () {
    $('add-err').textContent = '';
    $('add-text').value = '';
    dlg.showModal();
  });
  $('add-cancel').addEventListener('click', function () { dlg.close(); });
  $('add-load').addEventListener('click', function () {
    try {
      var rec = parseElements($('add-text').value);
      var stored = storedEclipses().filter(function (e) { return e.id !== rec.id; });
      stored.push(rec);
      localStorage.setItem(STORE_KEY, JSON.stringify(stored));
      delete metaCache[rec.id];
      buildSelect();
      dlg.close();
      loadEclipse(rec.id);
    } catch (e) {
      $('add-err').textContent = e.message;
    }
  });

  /* fold buttons; on a phone the event panel starts folded — the map is
     the page, and the panel is a drawer you pull open */
  document.querySelectorAll('.sheet-fold[data-fold]').forEach(function (b) {
    b.addEventListener('click', function () {
      $(b.dataset.fold).classList.toggle('folded');
    });
  });
  if (window.matchMedia && matchMedia('(max-width: 900px)').matches) {
    $('intel').classList.add('folded');
  }

  /* keyboard */
  document.addEventListener('keydown', function (ev) {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
    if (ev.key === ' ') { ev.preventDefault(); togglePlay(); }
    else if (ev.key === 'ArrowRight') { setTime(S.T + (ev.shiftKey ? 10 : 1) / 60); }
    else if (ev.key === 'ArrowLeft') { setTime(S.T - (ev.shiftKey ? 10 : 1) / 60); }
    else if (ev.key === 'Escape' && !$('dossier').hidden) {
      $('dossier-close').click();
    }
  });

  /* ================= colour mode ================= */

  /* the pull cord flips data-mode on <html>; everything drawn in JS —
     leaflet vectors, the SVG charts — re-reads the tokens and follows */
  function applyMode() {
    var P = palette();
    if (S.layers.bandPoly) S.layers.bandPoly.setStyle({ color: P.ink });
    if (S.layers.centerLine) S.layers.centerLine.setStyle({ color: P.ink });
    if (S.layers.umbra) S.layers.umbra.setStyle({ color: P.ink });
    if (S.layers.penumbra) S.layers.penumbra.setStyle({ color: P.ink });
    if (S.layers.contours) {
      S.layers.contours.eachLayer(function (l) {
        if (l.setStyle) l.setStyle({ color: P.ink });
      });
    }
    if (S.layers.sweepDots) {
      S.layers.sweepDots.eachLayer(function (l) {
        if (l._sweepV) l.setStyle(sweepDotStyle(l._sweepV));
      });
    }
    if (S.target) {
      if (S.target.terrain) renderTerrain();
      if (S.target.wx) renderWeather();
    }
    if (SUIT.grid) renderSuit();
  }
  new MutationObserver(applyMode).observe(document.documentElement,
    { attributes: true, attributeFilter: ['data-mode'] });

  /* ================= go ================= */

  function start() {
    var hash = decodeURIComponent(location.hash.slice(1));
    var id = null, tgt = null;
    if (hash) {
      var parts = hash.split('/');
      id = parts[0];
      if (parts[1]) {
        var ll = parts[1].split(',').map(Number);
        if (ll.length === 2 && ll.every(isFinite)) tgt = ll;
      }
    }
    loadEclipse(id || ECLIPSES[0].id, tgt);
  }

  start();

})();
