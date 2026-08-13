/* The one part of this tool that opens a socket.

   A route drawn as a bare line tells you its shape and nothing else. Printed
   over a map it tells you which of the three roads at the junction is meant,
   and that is the difference between a picture of a route and a sheet somebody
   can navigate from. So the map is worth fetching, and the cost is stated
   plainly rather than buried: switching it on asks tile.openstreetmap.org for
   the squares of map the route crosses. That request carries your IP address
   and, in the tiles it asks for, where you are going. Nothing else is sent,
   the tiles are not stored, and with the control off the page opens no socket
   at all.

   Tiles are fetched at print resolution and at an integer zoom, so a tile
   pixel is a paper pixel and nothing is resampled. */

;(function (Route) {
  "use strict";

  const geo = Route.geo;

  const HOST = "https://tile.openstreetmap.org";
  const ATTRIBUTION = "Map data © OpenStreetMap contributors, openstreetmap.org/copyright";
  const TILE = 256;

  // Standard tile usage asks for a light touch, and a route sheet is a light
  // touch: a few panels, a few dozen squares each, once. The caps make sure a
  // pathological route cannot turn into a crawl by accident.
  const MAX_PER_PANEL = 140;
  const MAX_TOTAL = 700;
  const IN_FLIGHT = 6;
  const MAX_ZOOM = 18;

  // Panels overlap — the overview covers ground every detail page also covers —
  // so the same square is often wanted twice. Held for the life of the page and
  // never written to disk.
  const cache = new Map();
  let spent = 0;

  function reset() { spent = 0; }
  function forget() { cache.clear(); reset(); }

  /* --- the view a tile layer wants ---------------------------------------- */

  /* Two things differ from the drawing view. The zoom is a whole number,
     because a fractional one means every tile is scaled and the type on it
     goes soft. And the size is in device pixels rather than points, chosen so
     the panel lands near 180 dpi when printed — enough that street names are
     legible on paper, not so much that the PDF cannot be mailed. */
  function panelView(box, widthPt, heightPt, padPt, density) {
    const scale = density || 2.5;
    const px = Math.round(widthPt * scale);
    const py = Math.round(heightPt * scale);
    const loose = geo.fit(box, px, py, padPt * scale);
    const zoom = Math.max(0, Math.min(MAX_ZOOM, Math.floor(loose.zoom)));
    return geo.view(box, px, py, padPt * scale, zoom);
  }

  // How many squares a view needs, which the caller wants to know before it
  // commits the reader to a download.
  function tileCount(view) {
    const range = tileRange(view);
    return (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1);
  }

  function tileRange(view) {
    return {
      x0: Math.floor(view.originX / TILE),
      x1: Math.floor((view.originX + view.width - 1) / TILE),
      y0: Math.floor(view.originY / TILE),
      y1: Math.floor((view.originY + view.height - 1) / TILE),
    };
  }

  /* --- fetching ------------------------------------------------------------ */

  async function loadTile(z, x, y, signal) {
    const span = 1 << z;
    // Longitude wraps and latitude does not: a panel crossing the date line
    // asks for the tiles on the other side, and one at the pole has nothing
    // above it to ask for.
    const tx = ((x % span) + span) % span;
    if (y < 0 || y >= span) return null;

    const key = `${z}/${tx}/${y}`;
    if (cache.has(key)) return cache.get(key);
    if (spent >= MAX_TOTAL) return null;
    spent++;

    const promise = (async () => {
      const response = await fetch(`${HOST}/${z}/${tx}/${y}.png`, {
        signal,
        referrerPolicy: "strict-origin-when-cross-origin",
      });
      if (!response.ok) throw new Error(`tile ${key}: ${response.status}`);
      return await createImageBitmap(await response.blob());
    })();

    cache.set(key, promise);
    // A failed square is a hole in the map, not a failed sheet. It is dropped
    // from the cache so a later panel may try again, and the caller counts it.
    promise.catch(() => cache.delete(key));
    return promise;
  }

  /* Draw the squares a view covers onto one canvas. Returns the canvas plus a
     count of what could not be had, because a panel with six holes in it is
     something the reader should be told about rather than left to notice on
     paper. */
  async function drawPanel(view, options) {
    const opts = options || {};
    const range = tileRange(view);
    const wanted = (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1);
    if (wanted > MAX_PER_PANEL) {
      throw new Error(
        `That panel needs ${wanted} map squares, past the ${MAX_PER_PANEL} this ` +
        `tool will ask for at once. Fewer detail pages, or a shorter route.`
      );
    }

    const canvas = document.createElement("canvas");
    canvas.width = view.width;
    canvas.height = view.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const jobs = [];
    for (let x = range.x0; x <= range.x1; x++) {
      for (let y = range.y0; y <= range.y1; y++) jobs.push([x, y]);
    }

    let missing = 0;
    let done = 0;
    const total = jobs.length;
    let next = 0;

    const worker = async () => {
      while (next < jobs.length) {
        const [x, y] = jobs[next++];
        try {
          const bitmap = await loadTile(view.zoom, x, y, opts.signal);
          if (bitmap) {
            ctx.drawImage(bitmap, x * TILE - view.originX, y * TILE - view.originY);
          } else {
            missing++;
          }
        } catch (err) {
          if (opts.signal?.aborted) throw err;
          missing++;
        }
        done++;
        if (opts.onProgress) opts.onProgress(done, total);
      }
    };

    await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, jobs.length) }, worker));
    treat(ctx, canvas, opts.treatment || "grey");
    return { canvas, missing, tiles: total, attribution: ATTRIBUTION };
  }

  /* --- printing treatment --------------------------------------------------- */

  /* A screen map is drawn to be looked at on its own. Under a route line, on
     paper, at whatever a home printer manages, it has to give way: the line is
     the subject and the map is context.

     Fading everything toward white by a fixed fraction is the obvious way to do
     that and it is the wrong one, because it takes the most out of the darkest
     tones — which on a map means the street names, the one thing worth
     fetching a map for. What is wanted is the opposite shape: hold the type
     near black and lift the middle, where the road fill, the parkland and the
     water all live. That is a gamma curve, and the small linear lift after it
     is only there to stop pure black on the map competing with the route.

     Grey also drops the colour, so nothing on the map argues with the one
     coloured thing on the page, and so the sheet prints the same on a laser
     printer as on an inkjet. */

  const CURVE = {
    grey: { gamma: 0.62, lift: 0.92 },
    colour: { gamma: 0.78, lift: 0.95 },
  };

  // 256 entries worked out once, rather than two Math.pow calls per subpixel:
  // a full panel is some millions of them.
  function toneTable(shape) {
    const table = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const curved = 255 * Math.pow(i / 255, shape.gamma);
      table[i] = Math.round(255 - (255 - curved) * shape.lift);
    }
    return table;
  }

  const TABLES = { grey: toneTable(CURVE.grey), colour: toneTable(CURVE.colour) };

  function treat(ctx, canvas, mode) {
    if (mode === "full") return;
    const table = TABLES[mode] || TABLES.grey;
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = image.data;

    for (let i = 0; i < px.length; i += 4) {
      if (mode === "colour") {
        px[i] = table[px[i]];
        px[i + 1] = table[px[i + 1]];
        px[i + 2] = table[px[i + 2]];
      } else {
        // Rec. 601 luma. A map's greens and blues are close in lightness, and
        // this is the weighting that keeps a park distinguishable from water
        // once the colour is gone.
        const lum = table[(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) | 0];
        px[i] = px[i + 1] = px[i + 2] = lum;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  /* --- handing the panel to the PDF ------------------------------------------ */

  // JPEG, because a PDF can carry the compressed bytes as they are: DCTDecode
  // is the filter, the file holds exactly what the encoder produced, and no
  // compressor has to be written here to get a map into a page.
  function toJPEG(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) { reject(new Error("The browser would not encode the map panel.")); return; }
          blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
        },
        "image/jpeg",
        quality || 0.82
      );
    });
  }

  Route.tiles = {
    panelView, drawPanel, tileCount, toJPEG, forget, reset,
    HOST, ATTRIBUTION, MAX_PER_PANEL, MAX_ZOOM,
    get spent() { return spent; },
  };

})(globalThis.Route || (globalThis.Route = {}));
