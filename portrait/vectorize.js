// One bit to outlines.
//
// The boundary between ink and paper is an isoline at a half, so the same
// marching squares that traced the matte traces the ink. Every loop closes on
// itself, and the holes inside a shape come out as their own loops, which is
// why the whole thing can be emitted as one path under the even-odd rule: a
// loop inside another loop is a hole without anyone having to work out nesting.

const CASES = [
  [], [["L", "B"]], [["B", "R"]], [["L", "R"]],
  [["T", "R"]], [["T", "L"], ["B", "R"]], [["T", "B"]], [["T", "L"]],
  [["T", "L"]], [["T", "B"]], [["T", "R"], ["B", "L"]], [["T", "R"]],
  [["L", "R"]], [["B", "R"]], [["L", "B"]], [],
];

function isolines(g, gw, gh, level) {
  const segs = [];
  const pos = new Map();
  const at = (x, y) => g[y * gw + x];
  const cross = (a, b) => (Math.abs(b - a) < 1e-9 ? 0.5 : (level - a) / (b - a));
  const hEdge = (x, y) => {
    const id = "h," + x + "," + y;
    if (!pos.has(id)) pos.set(id, { x: x + cross(at(x, y), at(x + 1, y)), y });
    return id;
  };
  const vEdge = (x, y) => {
    const id = "v," + x + "," + y;
    if (!pos.has(id)) pos.set(id, { x, y: y + cross(at(x, y), at(x, y + 1)) });
    return id;
  };
  for (let y = 0; y < gh - 1; y++) {
    for (let x = 0; x < gw - 1; x++) {
      const code = (at(x, y) < level ? 8 : 0) | (at(x + 1, y) < level ? 4 : 0) |
                   (at(x + 1, y + 1) < level ? 2 : 0) | (at(x, y + 1) < level ? 1 : 0);
      const pairs = CASES[code];
      if (!pairs.length) continue;
      const edge = (w) => (w === "T" ? hEdge(x, y) : w === "B" ? hEdge(x, y + 1)
                        : w === "L" ? vEdge(x, y) : vEdge(x + 1, y));
      for (const [a, b] of pairs) segs.push([edge(a), edge(b)]);
    }
  }
  const links = new Map();
  segs.forEach(([a, b], i) => {
    if (!links.has(a)) links.set(a, []);
    if (!links.has(b)) links.set(b, []);
    links.get(a).push(i); links.get(b).push(i);
  });
  const used = new Array(segs.length).fill(false);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const start = segs[i][0];
    let cur = segs[i][1];
    const ids = [start, cur];
    while (cur !== start) {
      const nx = (links.get(cur) || []).find((j) => !used[j]);
      if (nx === undefined) break;
      used[nx] = true;
      cur = segs[nx][0] === cur ? segs[nx][1] : segs[nx][0];
      ids.push(cur);
    }
    if (ids.length > 6) loops.push(ids.map((id) => pos.get(id)));
  }
  return loops;
}

function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
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

function smooth(pts, passes) {
  let out = pts;
  for (let p = 0; p < passes; p++) {
    if (out.length < 4) break;
    const next = [];
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const a = out[i], b = out[(i + 1) % n];
      next.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      next.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    out = next;
  }
  return out;
}

function area(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return Math.abs(a / 2);
}

export function traceInk(ink, size, opts) {
  const gw = size + 2, gh = size + 2;
  const g = new Float32Array(gw * gh);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) g[(y + 1) * gw + (x + 1)] = ink[y * size + x] ? 1 : 0;
  }
  return isolines(g, gw, gh, 0.5)
    .map((l) => l.map((p) => ({ x: p.x - 1, y: p.y - 1 })))
    .map((l) => smooth(simplify(l, opts.tolerance), opts.smoothing))
    .filter((l) => area(l) >= opts.minArea);
}

export function toSVG(ink, size, out, opts) {
  const loops = traceInk(ink, size, opts);
  const s = out / size;
  const d = loops.map((l) =>
    l.map((p, i) => (i ? "L" : "M") + (p.x * s).toFixed(2) + " " + (p.y * s).toFixed(2)).join(" ") + " Z"
  ).join(" ");
  return {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + out + " " + out +
         '" width="' + out + '" height="' + out + '">\n' +
         '  <rect width="' + out + '" height="' + out + '" fill="#ffffff"/>\n' +
         '  <path d="' + d + '" fill="#000000" fill-rule="evenodd"/>\n</svg>\n',
    loops: loops.length,
  };
}
