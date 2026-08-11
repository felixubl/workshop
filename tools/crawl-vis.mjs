#!/usr/bin/env node
/* The band crawler. Walks an eclipse's umbral band tile by tile and
   precomputes, for every ~60-80 m pixel, the fraction of totality the
   local horizon lets through — the one factor of the suitability score
   that is both expensive (a terrain scan per point) and eternal (a ridge
   does not change). Results land in eclipse-recon/data/<eclipse>/ as
   tiny grayscale PNGs plus a manifest, which GitHub Pages serves as
   static files: computed once, readable by everyone, no server.

   The mathematics here MIRRORS the client exactly — assessPoint and
   scanVis in js/app.js, horizonScan in js/terrain.js — so a crawled
   pixel is byte-for-byte what the visitor's browser would have computed.
   Change one and you must change the other.

       tools/crawl-vis.mjs [--minutes N] [--ecl 2026-08-12]
                           [--near lat,lon] [--max-tiles N]

   Ocean tiles (no land within scan reach) and high-sun tiles (Sun over
   30° through totality everywhere) resolve to "flat" — vis = 1 — without
   a single scan; tiles with no totality at all are marked outside. Only
   mountainous land under a low Sun costs real work, which is the point:
   that is exactly where the answer is interesting. */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { ECLIPSES } = require(path.join(ROOT, 'eclipse-recon/js/eclipses.js'));
const Bessel = require(path.join(ROOT, 'eclipse-recon/js/bessel.js'));
const { PNG } = require('pngjs');

const RAD = Math.PI / 180;
const CELL = 128;                    // raster is CELL x CELL per map tile
const R_EARTH_M = 6371000;
const REFRACTION_K = 0.13;

/* ---- arguments ---- */
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const MINUTES = +arg('minutes', 50);
const MAX_TILES = +arg('max-tiles', Infinity);
const NEAR = (arg('near', '') || '').split(',').map(Number);
const today = new Date().toISOString().slice(0, 10);
const ECL_ID = arg('ecl',
  (ECLIPSES.find(e => e.id >= today) || ECLIPSES[ECLIPSES.length - 1]).id);
const ecl = ECLIPSES.find(e => e.id === ECL_ID);
if (!ecl) { console.error('unknown eclipse ' + ECL_ID); process.exit(1); }

const DATA = path.join(ROOT, 'eclipse-recon/data', ECL_ID);
const DEM_CACHE = path.join(ROOT, '.dem-cache');
fs.mkdirSync(path.join(DATA, 'vis'), { recursive: true });
fs.mkdirSync(DEM_CACHE, { recursive: true });
const DEADLINE = Date.now() + MINUTES * 60 * 1000;

/* ---- mercator tiling; the z rule keeps a pixel at 60-80 m at any
   latitude, and the client (js/precomp.js) applies the same rule ---- */
const zFor = lat => { const a = Math.abs(lat); return a < 52 ? 12 : a < 68 ? 11 : 10; };
function tileOf(lat, lon) {
  const z = zFor(lat), n = 1 << z;
  const x = Math.floor(((lon + 180) / 360 * n % n + n) % n);
  const latR = lat * RAD;
  const y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n);
  return { z, x, y };
}
function tileBounds(z, x, y) {
  const n = 1 << z;
  const lon0 = x / n * 360 - 180, lon1 = (x + 1) / n * 360 - 180;
  const mercLat = f => Math.atan(Math.sinh(Math.PI * (1 - 2 * f / n))) / RAD;
  return { lat0: mercLat(y + 1), lat1: mercLat(y), lon0, lon1 };
}

/* ---- DEM: terrarium tiles, disk-cached across runs ---- */
const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/';
const dem = new Map();               // "z/x/y" -> {data,width} | null
function fetchBytes(url) {
  // curl honours proxy environments that Node's fetch does not
  try { return execFileSync('curl', ['-sf', '--max-time', '30', url], { maxBuffer: 1 << 25 }); }
  catch (e) { return null; }
}
function demTile(z, x, y) {
  const key = z + '/' + x + '/' + y;
  if (dem.has(key)) return dem.get(key);
  const file = path.join(DEM_CACHE, z + '-' + x + '-' + y + '.png');
  let bytes = null;
  if (fs.existsSync(file)) bytes = fs.readFileSync(file);
  else {
    bytes = fetchBytes(TILE_URL + key + '.png');
    if (bytes) fs.writeFileSync(file, bytes);
  }
  let out = null;
  if (bytes) {
    try { const p = PNG.sync.read(bytes); out = { data: p.data, width: p.width }; }
    catch (e) { out = null; }
  }
  dem.set(key, out);
  return out;
}
const decode = (px, i) => px[i] * 256 + px[i + 1] + px[i + 2] / 256 - 32768;
function elevAt(lat, lon, z) {          // bilinear, ocean floors to 0 (terrain.js)
  const n = 1 << z;
  const xt = (lon + 180) / 360 * n;
  const latR = lat * RAD;
  const yt = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
  const tx = Math.floor(xt), ty = Math.floor(yt);
  if (ty < 0 || ty >= n) return null;
  const t = demTile(z, ((tx % n) + n) % n, ty);
  if (!t) return null;
  const W = t.width;
  const fx = (xt - tx) * W - 0.5, fy = (yt - ty) * W - 0.5;
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(W - 1, Math.floor(fy)));
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(W - 1, y0 + 1);
  const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
  const p = t.data;
  const h = decode(p, (y0 * W + x0) * 4) * (1 - ax) * (1 - ay) +
            decode(p, (y0 * W + x1) * 4) * ax * (1 - ay) +
            decode(p, (y1 * W + x0) * 4) * (1 - ax) * ay +
            decode(p, (y1 * W + x1) * 4) * ax * ay;
  return Math.max(0, h);
}
const zoomFor = d => d < 8 ? 11 : d < 25 ? 10 : d < 60 ? 9 : 8;

/* ---- the client's astronomy, verbatim (app.js assessPoint) ---- */
function assessPoint(lat, lon) {
  const lonN = ((lon + 540) % 360) - 180;
  const lc = Bessel.localCircumstances(ecl, lat, lonN, 0);
  if (!lc || lc.type === 'partial' || !lc.c2 || !lc.c3 ||
      !lc.visible || !lc.centralVisible) return null;
  let minAlt = Infinity; const azs = [];
  for (let i = 0; i <= 6; i++) {
    const tt = lc.c2.tTT + (lc.c3.tTT - lc.c2.tTT) * i / 6;
    const sun = Bessel.sunAltAz(ecl, tt, lat, lonN);
    const alt = sun.alt + Bessel.refraction(sun.alt);
    if (alt < minAlt) minAlt = alt;
    azs.push(sun.az);
  }
  if (minAlt <= -0.3) return null;
  return { lc, lonN, minAlt, azs };
}

/* ---- the client's horizon scan, verbatim (terrain.js + scanVis) ---- */
function horizonAngleAt(profile, az) {
  const n = profile.length;
  if (!n) return -0.6;
  const a0 = profile[0].az;
  const rel = ((az - a0) % 360 + 360) % 360;
  const step = ((profile[n - 1].az - a0) % 360 + 360) % 360 / (n - 1 || 1);
  const idx = step > 0 ? rel / step : 0;
  if (idx <= 0) return profile[0].ang;
  if (idx >= n - 1) return profile[n - 1].ang;
  const i0 = Math.floor(idx), f = idx - i0;
  return profile[i0].ang * (1 - f) + profile[i0 + 1].ang * f;
}
function visOf(a) {
  const lo0 = Math.min(...a.azs), hi0 = Math.max(...a.azs);
  let lo = lo0, hi = hi0;
  if (hi - lo > 180) { lo = a.lc.sunAz - 12; hi = a.lc.sunAz + 12; }
  const maxKm = Math.min(120, Math.max(8, 5.0 / Math.tan(Math.max(1, a.minAlt) * RAD)));
  const azCenter = (lo + hi) / 2, azSpan = Math.min(60, hi - lo + 8), azStep = 3;
  const ranges = [];
  for (let d = 0.15; d < maxKm; d *= 1.09) ranges.push(d);
  ranges.push(maxKm);
  const azList = [];
  for (let az = azCenter - azSpan / 2; az <= azCenter + azSpan / 2 + 1e-9; az += azStep) {
    azList.push(((az % 360) + 360) % 360);
  }
  const siteElev = elevAt(a.lat, a.lonN, 12);
  const h0 = (siteElev === null ? 0 : siteElev) + 2;
  const profile = azList.map(az => ({ az, ang: -0.6 }));
  let sawData = false;
  for (let ai = 0; ai < azList.length; ai++) {
    for (const dKm of ranges) {
      const p = Bessel.destination(a.lat, a.lonN, azList[ai], dKm);
      const e = elevAt(p.lat, p.lon, zoomFor(dKm));
      if (e === null) continue;
      sawData = true;
      const dM = dKm * 1000;
      const drop = dM * dM / (2 * R_EARTH_M) * (1 - REFRACTION_K);
      const ang = Math.atan2(e - h0 - drop, dM) / RAD;
      if (ang > profile[ai].ang) profile[ai].ang = ang;
    }
  }
  if (!sawData) return 1;            // no elevation data: the open sea rule
  let seen = 0;
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const tt = a.lc.c2.tTT + (a.lc.c3.tTT - a.lc.c2.tTT) * i / n;
    const sun = Bessel.sunAltAz(ecl, tt, a.lat, a.lonN);
    const alt = sun.alt + Bessel.refraction(sun.alt);
    if (alt >= horizonAngleAt(profile, sun.az)) seen++;
  }
  return seen / (n + 1);
}

/* ---- state ---- */
const manFile = path.join(DATA, 'manifest.json');
const queueFile = path.join(DATA, 'queue.json');
let man = fs.existsSync(manFile)
  ? JSON.parse(fs.readFileSync(manFile, 'utf8'))
  : { v: 1, ecl: ECL_ID, cell: CELL, counts: { total: 0, done: 0, flat: 0, out: 0 }, tiles: {} };
let queue = fs.existsSync(queueFile)
  ? JSON.parse(fs.readFileSync(queueFile, 'utf8'))
  : null;

function save() {
  fs.writeFileSync(manFile, JSON.stringify(man));
  fs.writeFileSync(queueFile, JSON.stringify(queue));
}

/* ---- bootstrap: enumerate every tile the band touches, in path order ---- */
if (!queue) {
  console.log('bootstrap: enumerating band tiles for ' + ECL_ID);
  const cp = Bessel.centralPath(ecl, 45);
  const seen = new Set();
  const list = [];
  const mark = (lat, lon) => {
    if (Math.abs(lat) > 84) return;      // outside web-mercator, and the map clips there too
    const t = tileOf(lat, lon);
    const key = t.z + '/' + t.x + '/' + t.y;
    if (!seen.has(key)) { seen.add(key); list.push(key); }
  };
  const cs = cp.center;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const next = cs[i + 1] || c;
    const segKm = Math.max(1, Bessel.distKm(c.lat, c.lon, next.lat, next.lon));
    const heading = Bessel.bearing(c.lat, c.lon, next.lat, next.lon) / RAD;
    const half = (c.widthKm || 200) / 2 + 12;
    for (let s = 0; s < segKm; s += 4) {
      const p = Bessel.destination(c.lat, c.lon, heading, s);
      for (let off = -half; off <= half; off += 4) {
        const q = Bessel.destination(p.lat, p.lon, heading + 90, off);
        mark(q.lat, q.lon);
      }
    }
  }
  queue = { v: 1, pending: list };
  man.counts.total = list.length;
  save();
  console.log('bootstrap: ' + list.length + ' tiles queued');
}

/* --near reorders the queue around a point, for testing and for biting
   into the interesting ground first when asked */
if (NEAR.length === 2 && isFinite(NEAR[0]) && isFinite(NEAR[1])) {
  const d = key => {
    const [z, x, y] = key.split('/').map(Number);
    const b = tileBounds(z, x, y);
    return Bessel.distKm(NEAR[0], NEAR[1], (b.lat0 + b.lat1) / 2, (b.lon0 + b.lon1) / 2);
  };
  queue.pending.sort((a, b) => d(a) - d(b));
}

/* ---- classification: cheap answers first ---- */
function classify(key) {
  const [z, x, y] = key.split('/').map(Number);
  const b = tileBounds(z, x, y);
  const probes = [];
  for (let r = 0; r < 3; r++) {
    for (let q = 0; q < 3; q++) {
      probes.push(assessPoint(
        b.lat0 + (b.lat1 - b.lat0) * (r + 0.5) / 3,
        b.lon0 + (b.lon1 - b.lon0) * (q + 0.5) / 3));
    }
  }
  const central = probes.filter(Boolean);
  if (!central.length) return 'o';
  const minAlt = Math.min(...central.map(p => p.minAlt));
  if (central.length === 9 && minAlt >= 31) return 'f';   // sun too high to block
  // all ocean within scan reach? one coarse DEM sweep answers it
  const maxKm = Math.min(120, Math.max(8, 5.0 / Math.tan(Math.max(1, minAlt) * RAD)));
  const dLat = maxKm / 111, dLon = maxKm / (111 * Math.max(0.2, Math.cos(b.lat0 * RAD)));
  let maxElev = 0;
  outer:
  for (let la = b.lat0 - dLat; la <= b.lat1 + dLat; la += (b.lat1 - b.lat0 + 2 * dLat) / 9) {
    for (let lo = b.lon0 - dLon; lo <= b.lon1 + dLon; lo += (b.lon1 - b.lon0 + 2 * dLon) / 9) {
      const t = tileOf(Math.max(-84, Math.min(84, la)), lo);
      const dt = demTile(8, t.x >> (t.z - 8), t.y >> (t.z - 8));
      if (!dt) continue;
      // scan the whole coarse tile once; the set is tiny at z8
      for (let i = 0; i < dt.width * dt.width * 4; i += 16) {
        const h = decode(dt.data, i);
        if (h > maxElev) { maxElev = h; if (maxElev > 2) break outer; }
      }
    }
  }
  return maxElev <= 2 ? 'f' : 'hard';
}

/* ---- the dense pass ---- */
function crawlTile(key) {
  const [z, x, y] = key.split('/').map(Number);
  const b = tileBounds(z, x, y);
  const png = new PNG({ width: CELL, height: CELL, colorType: 0, inputColorType: 0, inputHasAlpha: false });
  const buf = Buffer.alloc(CELL * CELL);
  for (let r = 0; r < CELL; r++) {
    const lat = b.lat1 + (b.lat0 - b.lat1) * (r + 0.5) / CELL;   // top row first
    for (let q = 0; q < CELL; q++) {
      const lon = b.lon0 + (b.lon1 - b.lon0) * (q + 0.5) / CELL;
      const a = assessPoint(lat, lon);
      let v = 0;
      if (a) v = a.minAlt >= 30 ? 1 : visOf({ ...a, lat, lonN: a.lonN });
      buf[r * CELL + q] = Math.round(v * 255);
    }
  }
  png.data = buf;
  const dir = path.join(DATA, 'vis', String(z), String(x));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, y + '.png'), PNG.sync.write(png, { colorType: 0, inputColorType: 0 }));
}

/* ---- run ---- */
let didTiles = 0, didFlat = 0, didOut = 0, didDense = 0;
const todo = queue.pending.slice();
const settledKeys = new Set();
const checkpoint = () => {
  queue.pending = todo.filter(k => !settledKeys.has(k));
  save();
};
for (const key of todo) {
  if (Date.now() > DEADLINE || didTiles >= MAX_TILES) break;
  const cls = classify(key);
  if (cls === 'o' || cls === 'f') {
    man.tiles[key] = cls;
    man.counts[cls === 'o' ? 'out' : 'flat']++;
    cls === 'o' ? didOut++ : didFlat++;
    settledKeys.add(key); didTiles++;
    continue;
  }
  // hard ground: the real work — leave slack for the write and the commit
  if (Date.now() > DEADLINE - 90 * 1000) break;
  crawlTile(key);
  man.tiles[key] = 'd';
  man.counts.done++;
  settledKeys.add(key);
  didDense++; didTiles++;
  if (didTiles % 25 === 0) checkpoint();
}
checkpoint();

const c = man.counts;
const settled = c.done + c.flat + c.out;
const pct = c.total ? Math.round(settled / c.total * 1000) / 10 : 0;
const summary = 'vis crawl ' + ECL_ID + ': +' + didDense + ' scanned, +' + didFlat +
  ' flat, +' + didOut + ' outside — ' + settled + '/' + c.total + ' tiles (' + pct + '%)';
fs.writeFileSync(path.join(ROOT, '.crawl-summary.txt'), summary + '\n');
console.log(summary);
