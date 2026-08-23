// Reading an SVG, and turning whatever it holds into ONE closed curve.
//
// No path parser is written here. The browser already knows how to evaluate a
// `d` attribute — arcs, relative commands, every curve type — so each shape is
// walked with getPointAtLength and read off as points. That also means a file
// this tool has never seen a command from still works.

const GEOMETRY = "path, circle, ellipse, line, polyline, polygon, rect";

function transformPoint(m, p) {
  return m ? { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f } : p;
}

// A path holding several subpaths reports one length, because a moveto covers
// no distance. Walking it therefore steps from the end of one subpath straight
// to the start of the next, and that jump is far larger than the step. Cutting
// the walk wherever that happens recovers the subpaths without reading the `d`
// string at all.
function splitOnJumps(el, step, matrix, out) {
  const total = el.getTotalLength();
  if (!(total > 0)) return;
  const n = Math.max(8, Math.min(400000, Math.ceil(total / step)));
  const dl = total / n;
  let run = [];
  let prev = null;
  for (let i = 0; i <= n; i++) {
    const raw = el.getPointAtLength(i * dl);
    const p = transformPoint(matrix, { x: raw.x, y: raw.y });
    if (prev) {
      const d = Math.hypot(p.x - prev.x, p.y - prev.y);
      if (d > dl * 6 + 1e-6) { if (run.length > 2) out.push(run); run = []; }
    }
    run.push(p);
    prev = p;
  }
  if (run.length > 2) out.push(run);
}

// getPointAtLength walks the path from its start on every call, so on a file
// whose whole drawing is one `d` with thousands of subpaths the cost is
// quadratic — measured at three minutes for a portrait. Giving each subpath its
// own element makes every call walk only that subpath, which is linear.
//
// The `d` is cut at each moveto rather than parsed. A subpath that begins with
// a relative `m` is rewritten to an absolute `M`, which needs the point the
// previous subpath ended on — and that is read back off the element just built,
// so no arithmetic on curves happens here either.
const MOVE = /^\s*([Mm])\s*(-?[\d.]+(?:e[-+]?\d+)?)[\s,]+(-?[\d.]+(?:e[-+]?\d+)?)/;

function walkPathElement(el, step, matrix, out) {
  const d = el.getAttribute("d");
  if (!d) return;
  const chunks = d.split(/(?=[Mm])/).filter((c) => c.trim());
  if (chunks.length < 2) { splitOnJumps(el, step, matrix, out); return; }

  const owner = el.ownerSVGElement || el.parentNode;
  const probe = document.createElementNS("http://www.w3.org/2000/svg", "path");
  owner.appendChild(probe);
  let cur = { x: 0, y: 0 };
  try {
    for (const chunk of chunks) {
      const m = chunk.match(MOVE);
      let piece = chunk;
      if (m && m[1] === "m") {
        const ax = cur.x + parseFloat(m[2]), ay = cur.y + parseFloat(m[3]);
        piece = "M" + ax + " " + ay + chunk.slice(m[0].length);
      }
      probe.setAttribute("d", piece);
      const len = probe.getTotalLength();
      if (!(len > 0)) continue;
      splitOnJumps(probe, step, matrix, out);
      const end = probe.getPointAtLength(len);
      cur = { x: end.x, y: end.y };
    }
  } finally {
    probe.remove();
  }
}

function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / d;
}

function simplify(pts, tol) {
  if (tol <= 0 || pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let far = -1, best = tol;
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(pts[i], pts[a], pts[b]);
      if (d > best) { best = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function length(pts) {
  let t = 0;
  for (let i = 1; i < pts.length; i++) t += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return t;
}

// A file often carries a shape that is not part of the drawing: the white
// rectangle sitting behind it. Traced like anything else it becomes the longest
// loop in the file, so the pen starts on it and draws a border round the
// picture. It is told apart by being both as big as the whole drawing and no
// longer than its own bounding box — a real shape that spans the page wanders
// far more than its perimeter, a background rectangle does not.
function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

function looksLikeBackground(loop, whole) {
  const b = bbox(loop);
  const area = b.w * b.h, all = whole.w * whole.h;
  if (!(all > 0) || area < all * 0.95) return false;
  return length(loop) <= 2 * (b.w + b.h) * 1.15;
}

export function readSVG(text, opts) {
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden";
  host.innerHTML = text;
  const svg = host.querySelector("svg");
  if (!svg) throw new Error("no <svg> element in that file");
  document.body.appendChild(host);
  let loops = [];
  try {
    const root = svg.getScreenCTM && svg.getScreenCTM();
    for (const el of svg.querySelectorAll(GEOMETRY)) {
      if (typeof el.getTotalLength !== "function") continue;
      let m = null;
      try {
        const ctm = el.getScreenCTM && el.getScreenCTM();
        if (ctm && root) m = root.inverse().multiply(ctm);
      } catch (e) { m = null; }
      if (el.tagName.toLowerCase() === "path") walkPathElement(el, opts.step, m, loops);
      else splitOnJumps(el, opts.step, m, loops);
    }
  } finally {
    host.remove();
  }
  loops = loops
    .map((l) => simplify(l, opts.tolerance))
    .filter((l) => l.length > 3 && length(l) >= opts.minLength);
  let dropped = 0;
  if (opts.dropBackground && loops.length > 1) {
    const whole = bbox(loops.flat());
    const kept = loops.filter((l) => !looksLikeBackground(l, whole));
    dropped = loops.length - kept.length;
    if (kept.length) loops = kept;
  }
  loops.sort((a, b) => length(b) - length(a));
  if (opts.maxLoops > 0) loops = loops.slice(0, opts.maxLoops);
  loops.dropped = dropped;
  return loops;
}

// ── One curve out of many ───────────────────────────────────────────────────
//
// A chain of circles can only ever draw ONE closed curve, so the loops have to
// be joined before the transform sees them. They are joined along a minimum
// spanning tree, walked depth first, and every bridge is travelled out and back
// again. Travelling a bridge twice is what makes it invisible: the pen retraces
// its own line exactly, so what shows is the shapes, joined by nothing. It is
// also what closes the curve — a depth-first walk that retraces every edge
// finishes where it started.

function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

// The closest pair of points between two loops. Every pair against every pair
// is far too much at a thousand loops, so a coarse pass on a stride finds the
// neighbourhood and a second pass searches only around the winner.
function nearestPair(a, b) {
  const sa = Math.max(1, Math.floor(a.length / 24));
  const sb = Math.max(1, Math.floor(b.length / 24));
  let bi = 0, bj = 0, bd = Infinity;
  for (let i = 0; i < a.length; i += sa) {
    for (let j = 0; j < b.length; j += sb) {
      const d = (a[i].x - b[j].x) ** 2 + (a[i].y - b[j].y) ** 2;
      if (d < bd) { bd = d; bi = i; bj = j; }
    }
  }
  const i0 = bi - sa, i1 = bi + sa, j0 = bj - sb, j1 = bj + sb;
  for (let i = i0; i <= i1; i++) {
    const ia = ((i % a.length) + a.length) % a.length;
    for (let j = j0; j <= j1; j++) {
      const jb = ((j % b.length) + b.length) % b.length;
      const d = (a[ia].x - b[jb].x) ** 2 + (a[ia].y - b[jb].y) ** 2;
      if (d < bd) { bd = d; bi = ia; bj = jb; }
    }
  }
  return { i: bi, j: bj, d: Math.sqrt(bd) };
}

// Candidate joins: each loop against its nearest neighbours, plus the edges of
// a centre-based spanning tree so the graph is certainly connected. The winner
// among them is chosen on the real gap between outlines, which is what a join
// actually has to cross.
//
// Neighbours are found through a grid rather than by sorting every loop against
// every other. At a couple of thousand loops the sorting version allocates
// millions of throwaway objects and takes minutes; bucketing the centres and
// growing a ring of cells until enough candidates turn up is the same answer in
// a fraction of the time.
function neighbourhood(centres, k) {
  const n = centres.length;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of centres) {
    x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x); y1 = Math.max(y1, c.y);
  }
  const w = Math.max(x1 - x0, 1e-6), h = Math.max(y1 - y0, 1e-6);
  const cell = Math.max(Math.sqrt((w * h) / Math.max(1, n)) * 1.5, 1e-6);
  const cols = Math.max(1, Math.ceil(w / cell)), rows = Math.max(1, Math.ceil(h / cell));
  const cx = (c) => Math.min(cols - 1, Math.max(0, Math.floor((c.x - x0) / cell)));
  const cy = (c) => Math.min(rows - 1, Math.max(0, Math.floor((c.y - y0) / cell)));
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const key = cy(centres[i]) * cols + cx(centres[i]);
    let b = buckets.get(key);
    if (!b) { b = []; buckets.set(key, b); }
    b.push(i);
  }
  return (u) => {
    const gx = cx(centres[u]), gy = cy(centres[u]);
    const found = [];
    for (let r = 0; r <= Math.max(cols, rows); r++) {
      for (let y = gy - r; y <= gy + r; y++) {
        if (y < 0 || y >= rows) continue;
        for (let x = gx - r; x <= gx + r; x++) {
          if (x < 0 || x >= cols) continue;
          if (r > 0 && Math.abs(y - gy) !== r && Math.abs(x - gx) !== r) continue;
          const b = buckets.get(y * cols + x);
          if (b) for (const v of b) if (v !== u) found.push(v);
        }
      }
      if (found.length >= k * 3) break;
    }
    found.sort((a, b) =>
      ((centres[a].x - centres[u].x) ** 2 + (centres[a].y - centres[u].y) ** 2) -
      ((centres[b].x - centres[u].x) ** 2 + (centres[b].y - centres[u].y) ** 2));
    return found.slice(0, k);
  };
}

function candidateEdges(loops, centres, k) {
  const n = loops.length;
  const seen = new Set();
  const edges = [];
  const add = (u, v) => {
    const key = u < v ? u + ":" + v : v + ":" + u;
    if (seen.has(key)) return;
    seen.add(key);
    const np = nearestPair(loops[u], loops[v]);
    edges.push({ u, v, w: np.d, iu: np.i, iv: np.j });
  };

  const near = neighbourhood(centres, k);
  for (let u = 0; u < n; u++) for (const v of near(u)) add(u, v);

  const inTree = new Uint8Array(n);
  const best = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  best[0] = 0;
  for (let it = 0; it < n; it++) {
    let v = -1;
    for (let i = 0; i < n; i++) if (!inTree[i] && (v < 0 || best[i] < best[v])) v = i;
    inTree[v] = 1;
    if (parent[v] >= 0) add(parent[v], v);
    for (let u = 0; u < n; u++) {
      if (inTree[u]) continue;
      const d = (centres[u].x - centres[v].x) ** 2 + (centres[u].y - centres[v].y) ** 2;
      if (d < best[u]) { best[u] = d; parent[u] = v; }
    }
  }
  return edges;
}

function kruskal(n, edges) {
  edges.sort((a, b) => a.w - b.w);
  const up = new Int32Array(n).map((_, i) => i);
  const find = (x) => { while (up[x] !== x) { up[x] = up[up[x]]; x = up[x]; } return x; };
  const adj = Array.from({ length: n }, () => []);
  let total = 0, used = 0;
  for (const e of edges) {
    const a = find(e.u), b = find(e.v);
    if (a === b) continue;
    up[a] = b;
    adj[e.u].push({ to: e.v, here: e.iu, there: e.iv, w: e.w });
    adj[e.v].push({ to: e.u, here: e.iv, there: e.iu, w: e.w });
    total += e.w;
    if (++used === n - 1) break;
  }
  return { adj, total };
}

export function stitch(loops) {
  if (!loops.length) return [];
  if (loops.length === 1) {
    const one = loops[0].concat([loops[0][0]]);
    one.bridge = 0;
    one.total = length(one);
    return one;
  }

  const centres = loops.map(centroid);
  const { adj, total } = kruskal(loops.length, candidateEdges(loops, centres, 10));

  const out = [];
  const seen = new Uint8Array(loops.length);

  // Walk a loop's own outline and drop off to each child as the pen passes the
  // point nearest to it, rather than making every child leave from the one place
  // the loop was entered. Sorting the departures into walk order is what stops
  // the joins from fanning out across the picture and crossing each other.
  const visit = (i, enterAt) => {
    seen[i] = 1;
    const pts = loops[i];
    const n = pts.length;
    // Step 0 means the child hangs off the very point the loop was entered at.
    // The walk below runs from step 1 to step n, so such a child is served on
    // the last step, when the pen comes back round to where it started —
    // otherwise it and everything below it is never visited at all.
    const kids = adj[i]
      .filter((e) => !seen[e.to])
      .map((e) => {
        const raw = ((e.here - enterAt) % n + n) % n;
        return { ...e, step: raw === 0 ? n : raw };
      })
      .sort((a, b) => a.step - b.step);

    out.push(pts[enterAt]);
    let k = 0;
    for (let step = 1; step <= n; step++) {
      const idx = (enterAt + step) % n;
      out.push(pts[idx]);
      while (k < kids.length && kids[k].step === step) {
        const kid = kids[k++];
        if (seen[kid.to]) continue;
        visit(kid.to, kid.there);
        out.push(pts[idx]);           // back onto this outline where we left it
      }
    }
  };

  visit(0, 0);
  let visited = 0;
  for (let i = 0; i < loops.length; i++) if (seen[i]) visited++;
  out.visited = visited;
  out.push(out[0]);
  // Reported against the whole line rather than in the file's own units, so the
  // number means the same thing whatever the drawing was measured in.
  out.bridge = total;
  out.total = length(out);
  return out;
}

// Uniform steps along the curve, because the transform assumes its samples are
// evenly spaced in the parameter. Feeding it points bunched at the corners
// would put circles where the drawing is dense rather than where it turns.
export function resample(pts, n) {
  const cum = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    cum.push(total);
  }
  if (!(total > 0)) return null;
  const out = new Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    while (j < cum.length - 2 && cum[j + 1] < target) j++;
    const span = cum[j + 1] - cum[j];
    const t = span > 1e-12 ? (target - cum[j]) / span : 0;
    const a = pts[j], b = pts[j + 1];
    out[k] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  return out;
}
