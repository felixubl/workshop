/* Eclipse Recon — the page.
   Wiring: Leaflet satellite map, the Besselian engine, the terrain reader
   and the weather client. All colour comes off the PREPRINT tokens at draw
   time, so the pull cord restyles the map and charts along with the page:
   the photograph is greyscale, the shadow is printed in black, plate 3 is
   totality, plate 1 a good verdict, plate 2 a bad one, and the citron
   marker means marginal. */

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
    T: 0,                 // simulation clock, TT hours
    tMin: 0, tMax: 0,     // scrub range
    playing: false,
    tracking: false,      // camera follows the umbra
    layers: {},           // leaflet layers per role
    target: null,         // {lat, lon, elev, circ, wx, terrain}
    sweepCache: {},       // eclipse id -> sweep results
    aborter: null         // AbortController for target fetches
  };

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

  map.createPane('imagery').style.zIndex = 200;
  map.getPane('imagery').classList.add('pane-imagery');
  map.createPane('heat').style.zIndex = 290;
  map.createPane('night').style.zIndex = 300;
  map.createPane('labels').style.zIndex = 380;
  map.createPane('eclShadow').style.zIndex = 410;
  map.createPane('sweep').style.zIndex = 450;
  map.getPane('labels').style.pointerEvents = 'none';
  map.getPane('night').style.pointerEvents = 'none';
  map.getPane('heat').style.pointerEvents = 'none';
  map.getPane('eclShadow').style.pointerEvents = 'none';

  L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { pane: 'imagery', maxZoom: 17 }).addTo(map);
  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
    { pane: 'labels', subdomains: 'abcd', maxZoom: 17 }).addTo(map);
  map.getPane('labels').classList.add('pane-labels');

  /* ================= static geometry per eclipse ================= */

  function clearRole(role) {
    if (S.layers[role]) { map.removeLayer(S.layers[role]); delete S.layers[role]; }
  }

  function buildStatic() {
    ['band', 'center', 'limits', 'ge', 'contours', 'heat', 'sweepDots']
      .forEach(clearRole);

    var P = palette();
    var path = S.path;
    if (path.center.length) {
      var north = unwrap(path.north), south = unwrap(path.south);
      // keep both edges in the same unwrap frame as the band polygon
      S.layers.bandPoly = L.polygon(north.concat(south.slice().reverse()), {
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
  function togglePlay(on) {
    S.playing = on === undefined ? !S.playing : on;
    $('play').textContent = S.playing ? '❚❚' : '▶';
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
    var e = S.ecl, g = S.gt;
    $('intel-brief').textContent = e.brief;
    var stats = [
      ['type', e.type],
      ['gamma', g.gamma.toFixed(4)],
      ['max totality', fmtDur(g.maxDuration)],
      ['diameter ratio', g.ratioGE ? g.ratioGE.toFixed(4) : '—'],
      ['greatest eclipse', g.latGE !== null ?
        fmtLat(g.latGE) + ' ' + fmtLon(g.lonGE) : '—']
    ];
    $('intel-stats').innerHTML = stats.map(function (s) {
      return '<dt>' + s[0] + '</dt><dd>' + esc(s[1]) + '</dd>';
    }).join('');
    var rows = [
      ['P1', g.p1Date, 'partial eclipse begins'],
      ['U1', g.u1Date, 'umbral path begins'],
      ['MAX', g.dateGE, 'greatest eclipse'],
      ['U4', g.u4Date, 'umbral path ends'],
      ['P4', g.p4Date, 'partial eclipse ends']
    ];
    $('tl-rows').innerHTML = rows.map(function (r, i) {
      return '<div class="tl-row"><b>' + r[0] + '</b><code>' +
             fmtUT(r[1]) + '</code><span>' + r[2] + '</span>' +
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
    $('tgt-name').textContent = 'resolving name…';
    $('tgt-coords').textContent = fmtLat(lat) + ' ' + fmtLon(lon);
    $('tgt-elev').textContent = 'elev —';
    $('terrain-status').textContent = ''; $('terrain-status').className = 'h-status';
    $('wx-status').textContent = ''; $('wx-status').className = 'h-status';
    $('terrain-body').innerHTML = '<p class="terrain-note">loading elevation data…</p>';
    $('wx-body').innerHTML = '<p class="terrain-note">loading sky data…</p>';

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
            '<p class="terrain-note">Weather service unavailable; sky omitted from the assessment.</p>';
        });
    } else {
      $('wx-body').innerHTML = '<p class="terrain-note">No eclipse at this location.</p>';
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
          '<p class="terrain-note">Elevation data unavailable; horizon unknown.</p>';
      });
    } else {
      $('terrain-body').innerHTML = '<p class="terrain-note">' +
        (circ ? 'Event below the local horizon; no profile computed.'
              : 'No eclipse at this location.') + '</p>';
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
      $('circ-body').innerHTML = '<p class="terrain-note">the Moon’s shadow ' +
        'misses this point entirely. Select a point inside the shaded region.</p>';
      return;
    }
    var off = t.offSec;
    var typeWord = c.type === 'total' ?
        'total — ' + fmtDur(c.duration) + ' of totality' :
      c.type === 'annular' ? 'annular' :
        'partial — ' + Math.round(c.obscuration * 100) + '% of the Sun covered';
    var typeCls = c.type === 'total' ? 'total' : 'partial';
    var html = '<div class="circ-type">Type: <b class="' + typeCls + '">' +
               typeWord + '</b></div>';
    if (!c.visible) {
      html += '<p class="terrain-note">The entire event occurs below the local horizon.</p>';
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
    var note = '<p class="terrain-note">Scan radius 120 km; observer ' +
      Math.round(scan.siteElev) + ' m ASL + 2 m; Earth curvature and ' +
      'standard refraction applied.</p>';
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
      if (blocked === 0) {
        return { code: 'clear', margin: minMargin, html:
          '<b class="ok">horizon clear</b> — minimum clearance ' +
          minMargin.toFixed(1) + '° during totality.' };
      }
      if (blocked > nb - 2) {
        return { code: 'blocked', margin: minMargin, html:
          '<b class="bad">terrain obstructs totality</b> — the horizon exceeds ' +
          'solar altitude by ' + (-minMargin).toFixed(1) + '° throughout.' };
      }
      return { code: 'partial', margin: minMargin, html:
        '<b class="part">partial obstruction</b> — ' +
        Math.round(blocked / (nb + 1) * 100) +
        '% of totality is behind terrain.' };
    }
    // partial-phase site: how much of the show clears the ridge?
    var nb2 = 30, seen = 0;
    var t1 = c.c1 ? c.c1.tTT : c.tMax - 1, t2 = c.c4 ? c.c4.tTT : c.tMax + 1;
    for (var j = 0; j <= nb2; j++) {
      if (!blockedAt(t1 + (t2 - t1) * j / nb2)) seen++;
    }
    var pct = Math.round(seen / (nb2 + 1) * 100);
    return { code: pct > 80 ? 'clear' : pct > 20 ? 'partial' : 'blocked',
      html: pct > 80 ?
        '<b class="ok">horizon clear</b> — ' + pct + '% of the event is above the terrain.' :
        pct > 20 ?
        '<b class="part">partial obstruction</b> — ' + pct + '% of the event clears the terrain.' :
        '<b class="bad">obstructed</b> — the event is almost entirely behind terrain.' };
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

    var modeLine = mode === 'forecast' ?
        '<b>Forecast</b> (Open-Meteo), interpolated to mid-eclipse' :
      mode === 'archive' ?
        '<b>Archive</b> (ERA5 reanalysis) — observed conditions' :
        '<b>Climatology</b> (ERA5) — same date, mean of the last ' +
        (pdata.years || 8) + ' years';

    var html = '<div class="wx-mode">' + modeLine + '</div>';
    if (score !== null) {
      html += '<div class="wx-hero"><div class="wx-score ' + vCls + '">' +
        Math.round(score) + '</div><div><div class="lbl">sky score / 100</div>' +
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
      html += '<p class="terrain-note">no usable sky data for this hour.</p>';
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

  function renderVerdict() {
    var t = S.target;
    if (!t) return;
    var c = t.circ;
    var reasons = [], code = 'go', stamp = 'suitable';

    if (!c) {
      code = 'nogo'; stamp = 'no eclipse';
      reasons.push('No eclipse at this location.');
    } else if (!c.visible) {
      code = 'nogo'; stamp = 'below horizon';
      reasons.push('The event occurs below the local horizon.');
    } else {
      if (c.type === 'total') {
        reasons.push('Total eclipse; totality ' + fmtDur(c.duration) +
          '; Sun at ' + c.sunAlt.toFixed(1) + '°.');
      } else {
        var near = nearestPathKm(t.lat, t.lon);
        code = 'cond'; stamp = 'outside path';
        reasons.push('Partial eclipse only (' + Math.round(c.obscuration * 100) +
          '% obscuration); centreline ' + Math.round(near.d) + ' km ' +
          near.dir + '.');
      }
      if (c.sunAlt < 3) {
        code = code === 'nogo' ? 'nogo' : 'cond';
        reasons.push('Sun below 3°; an unobstructed ' + compass(c.sunAz) +
          ' horizon is required.');
      } else if (c.sunAlt < 12) {
        reasons.push('Low Sun (' + c.sunAlt.toFixed(1) + '° ' +
          compass(c.sunAz) + '); horizon obstruction is the dominant risk.');
      }
      // terrain
      if (t.terrain) {
        var tv = terrainVerdict();
        if (tv.code === 'blocked') { code = 'nogo'; stamp = 'unsuitable'; }
        else if (tv.code === 'partial' && code !== 'nogo') { code = 'cond'; if (stamp === 'suitable') stamp = 'marginal'; }
        else if (tv.code === 'clear' && tv.margin !== undefined && tv.margin < 1.5 && c.type === 'total') {
          if (code === 'go') { code = 'cond'; stamp = 'marginal'; }
          reasons.push('Horizon clearance only ' + tv.margin.toFixed(1) +
            '°; verify the exact site locally.');
        }
        var tvText = tv.html.replace(/<[^>]+>/g, '');
        reasons.push(tvText.charAt(0).toUpperCase() + tvText.slice(1));
      } else {
        reasons.push('Horizon profile pending or unavailable.');
      }
      // sky
      if (t.wx) {
        var cond = Wx.atTime(t.wx.data[0], c.dateMax);
        var score = Wx.skyScore(cond);
        var wv = Wx.verdictFor(score);
        if (wv.code === 'NOGO') { if (code !== 'nogo') { code = 'nogo'; stamp = 'unsuitable'; } }
        else if (wv.code === 'COND' && code === 'go') { code = 'cond'; stamp = 'marginal'; }
        var lead = cond && cond.low > 40 ? 'low cloud ' + Math.round(cond.low) + '%' :
          cond && cond.mid > 40 ? 'mid cloud ' + Math.round(cond.mid) + '%' :
          cond && cond.high > 50 ? 'cirrus ' + Math.round(cond.high) + '%' : null;
        reasons.push('Sky score ' + (score === null ? '—' : Math.round(score)) +
          '/100 (' + t.wx.mode + ')' + (lead ? '; ' + lead : '') + '.');
      } else {
        reasons.push('Sky data pending.');
      }
    }
    if (code === 'go' && c && c.type === 'total') {
      reasons.unshift('All available checks pass.');
    }
    $('verdict-body').innerHTML = '<div class="verdict ' + code + '">' +
      '<span class="stamp">' + stamp + '</span><ul>' +
      reasons.map(function (r) { return '<li>' + r + '</li>'; }).join('') +
      '</ul></div>';
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
          '<li><span class="meta">Survey failed; weather service unavailable (' +
          esc(e.message) + ').</span></li>';
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
    list.innerHTML = '<li><span class="meta">' +
      (mode === 'climatology' ?
        'Ranked by climatological mean for the calendar date.' :
        mode === 'archive' ? 'Ranked by observed conditions (archive).' :
        'Ranked by forecast sky at each point’s mid-eclipse.') +
      '</span></li>';
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

  /* ================= search ================= */

  $('search').addEventListener('input', debounce(function () {
    var q = this.value.trim();
    var ul = $('search-results');
    if (q.length < 2) { ul.hidden = true; return; }
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
          ul.hidden = true;
          map.flyTo([r.latitude, r.longitude], 9);
          setTarget(r.latitude, r.longitude, { keepView: true });
        });
      });
    }).catch(function () {
      ul.innerHTML = '<li><small>search unreachable</small></li>';
      ul.hidden = false;
    });
  }, 350));

  /* ================= eclipse switching ================= */

  function loadEclipse(id, targetSpec) {
    var ecl = ECLIPSES.find(function (e) { return e.id === id; }) || ECLIPSES[0];
    S.ecl = ecl;
    $('eclipse-select').value = ecl.id;

    // teardown
    togglePlay(false);
    Object.keys(S.layers).forEach(clearRole);
    if (reticle) { map.removeLayer(reticle); reticle = null; }
    S.target = null;
    $('dossier').hidden = true;
    $('sweep-list').hidden = true; $('sweep-list').innerHTML = '';

    S.gt = Bessel.globalTimes(ecl);
    S.path = Bessel.centralPath(ecl, 45);
    buildIntel();
    buildTimeline();
    buildStatic();
    map.setView([ecl.home.lat, ecl.home.lon], ecl.home.zoom);
    location.hash = ecl.id;

    if (targetSpec) {
      setTarget(targetSpec[0], targetSpec[1]);
      map.setView(targetSpec, 8);
    }
  }

  var sel = $('eclipse-select');
  ECLIPSES.forEach(function (e) {
    var o = document.createElement('option');
    o.value = e.id; o.textContent = e.name;
    sel.appendChild(o);
  });
  sel.addEventListener('change', function () { loadEclipse(this.value); });

  /* fold buttons */
  document.querySelectorAll('.sheet-fold[data-fold]').forEach(function (b) {
    b.addEventListener('click', function () {
      $(b.dataset.fold).classList.toggle('folded');
    });
  });

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
