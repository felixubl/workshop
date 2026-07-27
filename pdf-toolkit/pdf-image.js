// Images, and the page-rendering entry point.
//
// This is the one asynchronous corner of the engine. A JPEG inside a PDF is
// best decoded by the browser, and that means createImageBitmap and a Promise.
// Rather than let that leak into the interpreter, everything drawable is
// resolved up front: walk the page's resources (and the resources of any form
// it draws), decode every image, and hand the interpreter a finished map.

;(function (PDF) {
  'use strict';

  const { Name, Ref, Dict, PDFStream } = PDF;

  function makeCanvas(w, h) {
    const width = Math.max(1, Math.min(w | 0, 8192));
    const height = Math.max(1, Math.min(h | 0, 8192));
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    return c;
  }

  // Pulls `count` samples of `bpc` bits each out of a packed row.
  function unpackRow(data, byteOffset, bpc, count, out) {
    if (bpc === 8) {
      for (let i = 0; i < count; i++) out[i] = data[byteOffset + i] || 0;
      return;
    }
    if (bpc === 16) {
      for (let i = 0; i < count; i++) out[i] = data[byteOffset + i * 2] || 0;
      return;
    }
    const perByte = 8 / bpc;
    const mask = (1 << bpc) - 1;
    for (let i = 0; i < count; i++) {
      const byte = data[byteOffset + ((i / perByte) | 0)] || 0;
      const shift = 8 - bpc - (i % perByte) * bpc;
      out[i] = (byte >> shift) & mask;
    }
  }

  // Builds RGBA pixels from decoded samples in whatever colour space the image
  // declares. Returns null when the data is too short to be usable.
  function samplesToRGBA(doc, bytes, width, height, bpc, cs, decode, renderer) {
    const comps = cs.n || 1;
    const rowBytes = Math.ceil(width * comps * bpc / 8);
    if (rowBytes <= 0 || bytes.length < rowBytes) return null;

    const rgba = new Uint8ClampedArray(width * height * 4);
    const row = new Uint16Array(width * comps);
    const maxVal = (1 << bpc) - 1;
    const scale16 = bpc === 16 ? 255 / 255 : 1;

    // /Decode [1 0] inverts, which is common on 1-bit scans.
    const inverted = Array.isArray(decode) && decode.length >= 2 &&
      doc.resolve(decode[0]) === 1 && doc.resolve(decode[1]) === 0;

    // Indexed palettes are looked up once into a direct RGB table.
    let palette = null;
    if (cs.kind === 'Indexed' && cs.table) {
      const base = cs.base || { kind: 'DeviceRGB', n: 3 };
      const bn = base.n || 3;
      const entries = Math.min(cs.hival + 1 || 256, 256);
      palette = new Uint8ClampedArray(entries * 3);
      for (let i = 0; i < entries; i++) {
        const c = [];
        for (let k = 0; k < bn; k++) c.push((cs.table[i * bn + k] || 0) / 255);
        let r, g, b;
        if (base.kind === 'DeviceCMYK') {
          const v = PDF.cmykToRgb(c[0] || 0, c[1] || 0, c[2] || 0, c[3] || 0);
          r = v[0]; g = v[1]; b = v[2];
        } else if (base.kind === 'DeviceGray') {
          r = g = b = c[0] || 0;
        } else {
          r = c[0] || 0; g = c[1] || 0; b = c[2] || 0;
        }
        palette[i * 3] = r * 255;
        palette[i * 3 + 1] = g * 255;
        palette[i * 3 + 2] = b * 255;
      }
    }

    for (let y = 0; y < height; y++) {
      const off = y * rowBytes;
      if (off >= bytes.length) break;
      unpackRow(bytes, off, bpc, width * comps, row);
      let o = y * width * 4;
      for (let x = 0; x < width; x++) {
        const at = x * comps;
        let r = 0, g = 0, b = 0;
        switch (cs.kind) {
          case 'DeviceGray': {
            let v = row[at] / maxVal;
            if (inverted) v = 1 - v;
            r = g = b = v;
            break;
          }
          case 'DeviceRGB':
            r = row[at] / maxVal; g = row[at + 1] / maxVal; b = row[at + 2] / maxVal;
            break;
          case 'DeviceCMYK': {
            const v = PDF.cmykToRgb(row[at] / maxVal, row[at + 1] / maxVal,
                                    row[at + 2] / maxVal, row[at + 3] / maxVal);
            r = v[0]; g = v[1]; b = v[2];
            break;
          }
          case 'Indexed': {
            const i = Math.min(row[at], 255);
            if (palette) {
              rgba[o++] = palette[i * 3];
              rgba[o++] = palette[i * 3 + 1];
              rgba[o++] = palette[i * 3 + 2];
              rgba[o++] = 255;
              continue;
            }
            r = g = b = i / maxVal;
            break;
          }
          case 'Separation': {
            const tint = row[at] / maxVal;
            r = g = b = 1 - tint;
            break;
          }
          default:
            r = g = b = row[at] / maxVal;
        }
        rgba[o++] = r * 255;
        rgba[o++] = g * 255;
        rgba[o++] = b * 255;
        rgba[o++] = 255;
      }
    }
    return rgba;
  }

  async function decodeImageStream(doc, ref, stream, renderer, res) {
    const dict = stream.dict;
    const width = doc.get(dict, 'Width', 'W') | 0;
    const height = doc.get(dict, 'Height', 'H') | 0;
    if (width <= 0 || height <= 0 || width * height > 40000000) return null;

    const isMask = doc.get(dict, 'ImageMask', 'IM') === true;
    let bpc = doc.get(dict, 'BitsPerComponent', 'BPC') | 0;
    if (isMask) bpc = 1;
    if (!bpc) bpc = 8;

    let bytes;
    try { bytes = doc.decodeStreamBytes(stream, ref instanceof Ref ? ref.num : undefined); }
    catch { return null; }

    const filter = stream.imageFilter;
    const decode = doc.get(dict, 'Decode', 'D');

    // JPEG and JPEG 2000 go to the browser's decoder.
    if (filter === 'DCTDecode' || filter === 'JPXDecode') {
      const mime = filter === 'DCTDecode' ? 'image/jpeg' : 'image/jp2';
      try {
        const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
        const canvas = makeCanvas(bitmap.width, bitmap.height);
        const c = canvas.getContext('2d');
        c.drawImage(bitmap, 0, 0);
        await applySoftMask(doc, dict, canvas, c, renderer, res);
        if (typeof bitmap.close === 'function') bitmap.close();
        return { canvas, width: canvas.width, height: canvas.height, isMask: false };
      } catch {
        return null;                      // CMYK JPEGs the browser refuses
      }
    }
    // Fax and JBIG2 are not decoded; skipping beats drawing noise.
    if (filter === 'CCITTFaxDecode' || filter === 'JBIG2Decode') return null;

    const canvas = makeCanvas(width, height);
    const c = canvas.getContext('2d');
    const img = c.createImageData(canvas.width, canvas.height);

    if (isMask) {
      // A stencil mask: sample 0 paints, 1 leaves alone (unless /Decode flips
      // it). Painted pixels become opaque black, which is what almost every
      // stencil in the wild is used for.
      const rowBytes = Math.ceil(width / 8);
      const flip = Array.isArray(decode) && doc.resolve(decode[0]) === 1;
      const row = new Uint16Array(width);
      for (let y = 0; y < height; y++) {
        unpackRow(bytes, y * rowBytes, 1, width, row);
        let o = y * width * 4;
        for (let x = 0; x < width; x++) {
          let on = row[x] === 0;
          if (flip) on = !on;
          img.data[o++] = 0;
          img.data[o++] = 0;
          img.data[o++] = 0;
          img.data[o++] = on ? 255 : 0;
        }
      }
      c.putImageData(img, 0, 0);
      return { canvas, width, height, isMask: true };
    }

    // Through colorSpace, not parseColorSpace: an image's /ColorSpace is very
    // often a name like /Cs6 that only the page's resource dictionary can
    // resolve, and the low-level parser answers DeviceGray for anything it does
    // not recognise, which silently reads a third of each RGB row.
    const cs = renderer.colorSpace(dict.get('ColorSpace', 'CS'), res);
    const rgba = samplesToRGBA(doc, bytes, width, height, bpc, cs, decode, renderer);
    if (!rgba) return null;
    img.data.set(rgba);
    c.putImageData(img, 0, 0);
    await applySoftMask(doc, dict, canvas, c, renderer, res);
    return { canvas, width, height, isMask: false };
  }

  // An /SMask is a greyscale image whose samples are the alpha channel.
  async function applySoftMask(doc, dict, canvas, ctx, renderer, res) {
    const smaskRef = dict.get('SMask');
    const smask = doc.resolve(smaskRef);
    if (!(smask instanceof PDFStream)) return;

    const mw = doc.get(smask.dict, 'Width') | 0;
    const mh = doc.get(smask.dict, 'Height') | 0;
    if (mw <= 0 || mh <= 0) return;

    const mask = await decodeImageStream(doc, smaskRef, smask, renderer, res);
    if (!mask) return;

    try {
      // Scale the mask onto the image's own grid, then multiply into alpha.
      const scaled = makeCanvas(canvas.width, canvas.height);
      const sc = scaled.getContext('2d');
      sc.drawImage(mask.canvas, 0, 0, canvas.width, canvas.height);
      const maskData = sc.getImageData(0, 0, canvas.width, canvas.height);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < imgData.data.length; i += 4) {
        imgData.data[i + 3] = maskData.data[i];   // grey level is the alpha
      }
      ctx.putImageData(imgData, 0, 0);
    } catch { /* tainted or oversized canvas */ }
  }

  // Walks resources for image XObjects, following form XObjects, and decodes
  // each one exactly once.
  async function collectImages(doc, resources, renderer, images, seen, depth) {
    if (!(resources instanceof Dict) || depth > 8) return;

    const xobjs = doc.get(resources, 'XObject');
    if (xobjs instanceof Dict) {
      for (const key of xobjs.keys()) {
        const ref = xobjs.get(key);
        const id = ref instanceof Ref ? 'i' + ref.num : 'k' + key;
        if (seen.has(id)) continue;
        seen.add(id);

        const xo = doc.resolve(ref);
        if (!(xo instanceof PDFStream)) continue;
        const subtype = doc.get(xo.dict, 'Subtype');
        const kind = subtype instanceof Name ? subtype.name : '';

        if (kind === 'Image') {
          const drawable = await decodeImageStream(doc, ref, xo, renderer, resources);
          if (drawable) images.set(id, drawable);
        } else if (kind === 'Form') {
          const sub = doc.get(xo.dict, 'Resources');
          await collectImages(doc, sub, renderer, images, seen, depth + 1);
        }
      }
    }

    // Patterns and Type 3 glyphs carry their own resources.
    for (const category of ['Pattern', 'Font']) {
      const d = doc.get(resources, category);
      if (!(d instanceof Dict)) continue;
      for (const key of d.keys()) {
        const v = doc.resolve(d.get(key));
        const vd = v instanceof PDFStream ? v.dict : v;
        if (!(vd instanceof Dict)) continue;
        const sub = doc.get(vd, 'Resources');
        if (sub instanceof Dict) await collectImages(doc, sub, renderer, images, seen, depth + 1);
      }
    }
  }

  // --- the public entry point ------------------------------------------------

  // Renders a page onto a canvas. `scale` is CSS pixels per PDF point; the
  // canvas is sized to the page's crop box with its rotation applied.
  async function renderPageToCanvas(doc, page, canvas, options) {
    const opts = options || {};
    const scale = opts.scale || 1;
    const box = page.cropBox;
    const rotate = page.rotate;

    const boxW = box[2] - box[0];
    const boxH = box[3] - box[1];
    const swap = rotate === 90 || rotate === 270;
    const width = Math.max(1, Math.round((swap ? boxH : boxW) * scale));
    const height = Math.max(1, Math.round((swap ? boxW : boxH) * scale));

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    ctx.save();
    ctx.fillStyle = opts.background || '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    // PDF space has y running up from the bottom left of the crop box; canvas
    // has y running down from the top left. This matrix reconciles the two and
    // folds in the page's own /Rotate.
    let base;
    switch (rotate) {
      case 90:  base = [0, 1, -1, 0, boxH, 0]; break;
      case 180: base = [-1, 0, 0, -1, boxW, boxH]; break;
      case 270: base = [0, -1, 1, 0, 0, boxW]; break;
      default:  base = [1, 0, 0, 1, 0, 0];
    }
    // Move the crop box origin to zero, rotate, then flip y and scale up.
    let m = PDF.mat.mul([1, 0, 0, 1, -box[0], -box[1]], base);
    m = PDF.mat.mul(m, [scale, 0, 0, -scale, 0, height]);

    const renderer = new PDF.Renderer(doc, ctx, {
      width, height,
      fontCache: opts.fontCache,
      maxOps: opts.maxOps,
    });

    const images = new Map();
    try {
      await collectImages(doc, page.resources, renderer, images, new Set(), 0);
    } catch { /* carry on without the images that failed */ }
    renderer.images = images;

    renderer.renderPage(page, m);
    return canvas;
  }

  PDF.renderPageToCanvas = renderPageToCanvas;
  PDF.collectImages = collectImages;
  PDF.decodeImageStream = decodeImageStream;
  PDF.makeCanvas = makeCanvas;

})(globalThis.PDF || (globalThis.PDF = {}));
