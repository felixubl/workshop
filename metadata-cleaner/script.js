/* Image Metadata Cleaner. Reads a JPEG, PNG or WebP as bytes, decodes the
   metadata the container carries alongside the picture, and writes the file
   back with the chosen fields removed. Two rules govern the whole tool.
   Lossless: the pixels are never decoded or re-encoded, only the container
   around them is rewritten. Local: nothing is uploaded, and no library is
   used. */

(function () {
  "use strict";

  /* Bytes. Everything below reads from a Uint8Array with an explicit byte
     order. No DataView state is kept: every read names its own endianness,
     because a TIFF inside a JPEG inside a page involves three of them. */

  const UTF8 = new TextDecoder("utf-8");
  const LATIN1 = new TextDecoder("windows-1252");

  const u16 = (b, i, le) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const u32 = (b, i, le) =>
    (le
      ? b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)
      : (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const i32 = (b, i, le) => u32(b, i, le) | 0;

  function put16(b, i, v, le) {
    if (le) { b[i] = v & 0xff; b[i + 1] = (v >>> 8) & 0xff; }
    else { b[i] = (v >>> 8) & 0xff; b[i + 1] = v & 0xff; }
  }
  function put32(b, i, v, le) {
    if (le) {
      b[i] = v & 0xff; b[i + 1] = (v >>> 8) & 0xff;
      b[i + 2] = (v >>> 16) & 0xff; b[i + 3] = (v >>> 24) & 0xff;
    } else {
      b[i] = (v >>> 24) & 0xff; b[i + 1] = (v >>> 16) & 0xff;
      b[i + 2] = (v >>> 8) & 0xff; b[i + 3] = v & 0xff;
    }
  }

  // ASCII compare against a signature, used for every format sniff in the file.
  function sigAt(bytes, off, sig) {
    if (off + sig.length > bytes.length) return false;
    for (let i = 0; i < sig.length; i++) {
      if (bytes[off + i] !== sig.charCodeAt(i)) return false;
    }
    return true;
  }

  function asciiAt(bytes, off, len) {
    let s = "";
    for (let i = 0; i < len && off + i < bytes.length; i++) {
      s += String.fromCharCode(bytes[off + i]);
    }
    return s;
  }

  function concat(list) {
    let n = 0;
    for (const part of list) n += part.length;
    const out = new Uint8Array(n);
    let at = 0;
    for (const part of list) { out.set(part, at); at += part.length; }
    return out;
  }

  // Trailing NULs and spaces are padding in every string format here, and no
  // format means them as content.
  const trimNul = (s) => s.replace(/[\0\s]+$/, "");

  function fileSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
  }

  function hexPreview(bytes, limit = 12) {
    const parts = [];
    for (let i = 0; i < Math.min(limit, bytes.length); i++) {
      parts.push(bytes[i].toString(16).padStart(2, "0"));
    }
    return parts.join(" ") + (bytes.length > limit ? " …" : "");
  }

  // An opaque blob is worth showing as text when it plainly is text — a lot of
  // unlabelled vendor fields turn out to hold a path or a name, and that is
  // exactly where the surprises are.
  function looksLikeText(bytes) {
    if (!bytes.length) return false;
    let printable = 0;
    const n = Math.min(bytes.length, 256);
    for (let i = 0; i < n; i++) {
      const c = bytes[i];
      if (c === 0 || c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
    }
    return printable / n >= 0.9;
  }

  /* CRC32. PNG chunks and ZIP entries use the same reflected polynomial, so
     one table serves both. That is what lets the batch download build a .zip
     without a dependency. */

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /* Inflate. PNG's zTXt, iTXt and iCCP are zlib-wrapped deflate, which is the
     browser's "deflate" format; the raw variety is "deflate-raw" and fails on
     the two-byte zlib header. This is the only asynchronous step in the tool
     and the reason reading a file returns a promise. Output is capped, because
     a tool accepting arbitrary uploads is a decompression-bomb target. */

  const INFLATE_CAP = 32 << 20;

  async function inflate(bytes) {
    if (typeof DecompressionStream !== "function") return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
      const reader = stream.getReader();
      const parts = [];
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > INFLATE_CAP) { await reader.cancel(); return null; }
        parts.push(value);
      }
      return concat(parts);
    } catch (err) {
      return null;
    }
  }

  /* ZIP. Stored, never deflated: the payloads are already-compressed images,
     so compressing them again gains nothing, and STORE keeps the writer short.
     The timestamp is pinned to the DOS epoch, because a tool that strips
     metadata should not stamp the archive with the reader's clock. */

  const DOS_DATE = 0x0021; // 1980-01-01
  const DOS_TIME = 0x0000;

  function zipSafeName(name) {
    return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "_") || "image";
  }

  function buildZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;
    const enc = new TextEncoder();

    for (const entry of entries) {
      const nameBytes = enc.encode(entry.name);
      let utf8Flag = 0;
      for (const b of nameBytes) if (b > 0x7f) { utf8Flag = 0x0800; break; }
      const crc = crc32(entry.bytes);
      const size = entry.bytes.length;

      const local = new Uint8Array(30 + nameBytes.length);
      put32(local, 0, 0x04034b50, true);
      put16(local, 4, 20, true);
      put16(local, 6, utf8Flag, true);
      put16(local, 8, 0, true); // stored
      put16(local, 10, DOS_TIME, true);
      put16(local, 12, DOS_DATE, true);
      put32(local, 14, crc, true);
      put32(local, 18, size, true);
      put32(local, 22, size, true);
      put16(local, 26, nameBytes.length, true);
      put16(local, 28, 0, true);
      local.set(nameBytes, 30);

      parts.push(local, entry.bytes);

      const cd = new Uint8Array(46 + nameBytes.length);
      put32(cd, 0, 0x02014b50, true);
      put16(cd, 4, 0x031e, true); // made by UNIX, 3.0
      put16(cd, 6, 20, true);
      put16(cd, 8, utf8Flag, true);
      put16(cd, 10, 0, true);
      put16(cd, 12, DOS_TIME, true);
      put16(cd, 14, DOS_DATE, true);
      put32(cd, 16, crc, true);
      put32(cd, 20, size, true);
      put32(cd, 24, size, true);
      put16(cd, 28, nameBytes.length, true);
      put16(cd, 30, 0, true);
      put16(cd, 32, 0, true);
      put16(cd, 34, 0, true);
      put16(cd, 36, 0, true);
      put32(cd, 38, 0x81a40000, true); // regular file, 0644
      put32(cd, 42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += local.length + size;
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const cd of central) { parts.push(cd); cdSize += cd.length; }

    const eocd = new Uint8Array(22);
    put32(eocd, 0, 0x06054b50, true);
    put16(eocd, 4, 0, true);
    put16(eocd, 6, 0, true);
    put16(eocd, 8, entries.length, true);
    put16(eocd, 10, entries.length, true);
    put32(eocd, 12, cdSize, true);
    put32(eocd, 16, cdOffset, true);
    put16(eocd, 20, 0, true);
    parts.push(eocd);

    return new Blob(parts, { type: "application/zip" });
  }

  /* Groups. Fields are grouped by what they disclose rather than by where the
     format stores them. A GPS tag and an IPTC city are the same disclosure and
     belong on the same line, though one lives in a TIFF IFD and the other in a
     Photoshop resource block. */

  const GROUPS = [
    ["location", "Location", "where the picture was taken"],
    ["people", "People", "names, bylines, ownership"],
    ["device", "Device", "which camera, phone or program"],
    ["dates", "Dates", "when it was taken and edited"],
    ["capture", "Capture", "how the exposure was made"],
    ["text", "Text", "captions, comments, embedded notes"],
    ["thumbnail", "Preview", "a second, smaller copy of the picture"],
    ["render", "Rendering", "what a viewer needs to draw it correctly"],
    ["other", "Other", "unrecognised or opaque"],
  ];

  const HIGH = "high";
  const MED = "med";
  const LOW = "low";

  /* The tag dictionary: [label, group, risk, formatter]. A tag is listed here
     if it names a person, a place or a specific device; if a photographer
     would recognise it in an info panel; or if it is unreadable without a
     formatter. Everything else falls through to the name-only list below, then
     to its own tag number. */

  const TAGS_IFD0 = {
    0x0100: ["Image width", "render", LOW],
    0x0101: ["Image height", "render", LOW],
    0x0102: ["Bits per sample", "render", LOW],
    0x0103: ["Compression", "render", LOW],
    0x0106: ["Photometric interpretation", "render", LOW],
    0x010e: ["Image description", "text", HIGH],
    0x010f: ["Camera make", "device", MED],
    0x0110: ["Camera model", "device", MED],
    0x0112: ["Orientation", "render", LOW, "orientation"],
    0x011a: ["X resolution", "render", LOW, "rational"],
    0x011b: ["Y resolution", "render", LOW, "rational"],
    0x0128: ["Resolution unit", "render", LOW, "resolutionUnit"],
    0x0131: ["Software", "device", MED],
    0x0132: ["File changed", "dates", MED, "exifDate"],
    0x013b: ["Artist", "people", HIGH],
    0x013e: ["White point", "render", LOW],
    0x013f: ["Primary chromaticities", "render", LOW],
    0x0211: ["YCbCr coefficients", "render", LOW],
    0x0213: ["YCbCr positioning", "render", LOW],
    0x0214: ["Reference black/white", "render", LOW],
    0x8298: ["Copyright", "people", HIGH],
    0x9c9b: ["Title (Windows)", "text", HIGH, "xpString"],
    0x9c9c: ["Comment (Windows)", "text", HIGH, "xpString"],
    0x9c9d: ["Author (Windows)", "people", HIGH, "xpString"],
    0x9c9e: ["Keywords (Windows)", "text", HIGH, "xpString"],
    0x9c9f: ["Subject (Windows)", "text", HIGH, "xpString"],
  };

  const TAGS_EXIF = {
    0x829a: ["Exposure time", "capture", MED, "exposureTime"],
    0x829d: ["Aperture", "capture", MED, "fnumber"],
    0x8822: ["Exposure program", "capture", MED, "exposureProgram"],
    0x8824: ["Spectral sensitivity", "capture", MED],
    0x8827: ["ISO", "capture", MED, "first"],
    0x8830: ["Sensitivity type", "capture", MED],
    0x9000: ["Exif version", "render", LOW, "version"],
    0x9003: ["Date taken", "dates", MED, "exifDate"],
    0x9004: ["Date digitised", "dates", MED, "exifDate"],
    0x9010: ["Time zone", "dates", MED],
    0x9011: ["Time zone (taken)", "dates", MED],
    0x9012: ["Time zone (digitised)", "dates", MED],
    0x9101: ["Components configuration", "render", LOW],
    0x9102: ["Compressed bits per pixel", "render", LOW],
    0x9201: ["Shutter speed", "capture", MED, "apexShutter"],
    0x9202: ["Aperture (APEX)", "capture", MED, "apexAperture"],
    0x9203: ["Brightness", "capture", MED, "rational"],
    0x9204: ["Exposure compensation", "capture", MED, "rational"],
    0x9205: ["Max aperture", "capture", MED, "apexAperture"],
    0x9206: ["Subject distance", "capture", MED, "rational"],
    0x9207: ["Metering mode", "capture", MED, "meteringMode"],
    0x9208: ["Light source", "capture", MED, "lightSource"],
    0x9209: ["Flash", "capture", MED, "flash"],
    0x920a: ["Focal length", "capture", MED, "focalLength"],
    0x9214: ["Subject area", "capture", MED],
    0x927c: ["Maker note", "device", HIGH, "makerNote"],
    0x9286: ["User comment", "text", HIGH, "userComment"],
    0x9290: ["Sub-second", "dates", MED],
    0x9291: ["Sub-second (taken)", "dates", MED],
    0x9292: ["Sub-second (digitised)", "dates", MED],
    0x9400: ["Ambient temperature", "capture", MED, "rational"],
    0x9401: ["Humidity", "capture", MED, "rational"],
    0x9402: ["Air pressure", "capture", MED, "rational"],
    0x9403: ["Water depth", "capture", MED, "rational"],
    0x9405: ["Camera elevation angle", "capture", MED, "rational"],
    0xa000: ["Flashpix version", "render", LOW, "version"],
    0xa001: ["Colour space", "render", LOW, "colorSpace"],
    0xa002: ["Pixel width", "render", LOW],
    0xa003: ["Pixel height", "render", LOW],
    0xa004: ["Related sound file", "other", MED],
    0xa20b: ["Flash energy", "capture", MED, "rational"],
    0xa20e: ["Focal plane X resolution", "capture", MED, "rational"],
    0xa20f: ["Focal plane Y resolution", "capture", MED, "rational"],
    0xa210: ["Focal plane resolution unit", "capture", MED, "resolutionUnit"],
    0xa215: ["Exposure index", "capture", MED, "rational"],
    0xa217: ["Sensing method", "capture", MED],
    0xa300: ["File source", "capture", MED],
    0xa301: ["Scene type", "capture", MED],
    0xa401: ["Custom rendered", "capture", MED],
    0xa402: ["Exposure mode", "capture", MED],
    0xa403: ["White balance", "capture", MED, "whiteBalance"],
    0xa404: ["Digital zoom", "capture", MED, "rational"],
    0xa405: ["Focal length (35mm)", "capture", MED],
    0xa406: ["Scene capture type", "capture", MED],
    0xa407: ["Gain control", "capture", MED],
    0xa408: ["Contrast", "capture", MED],
    0xa409: ["Saturation", "capture", MED],
    0xa40a: ["Sharpness", "capture", MED],
    0xa40c: ["Subject distance range", "capture", MED],
    0xa420: ["Image unique ID", "device", HIGH],
    0xa430: ["Camera owner", "people", HIGH],
    0xa431: ["Camera serial number", "device", HIGH],
    0xa432: ["Lens specification", "device", MED],
    0xa433: ["Lens make", "device", MED],
    0xa434: ["Lens model", "device", MED],
    0xa435: ["Lens serial number", "device", HIGH],
  };

  /* Every GPS tag is location. GPSVersionID discloses nothing but stays in the
     group, because that is where a reader will look for it. */
  const TAGS_GPS = {
    0x0000: ["GPS tag version", "location", LOW, "bytes"],
    0x0001: ["Latitude ref", "location", HIGH],
    0x0002: ["Latitude", "location", HIGH, "gpsCoord"],
    0x0003: ["Longitude ref", "location", HIGH],
    0x0004: ["Longitude", "location", HIGH, "gpsCoord"],
    0x0005: ["Altitude ref", "location", HIGH, "altitudeRef"],
    0x0006: ["Altitude", "location", HIGH, "gpsAltitude"],
    0x0007: ["GPS time (UTC)", "location", HIGH, "gpsTime"],
    0x0008: ["Satellites", "location", HIGH],
    0x0009: ["Receiver status", "location", HIGH],
    0x000a: ["Measure mode", "location", HIGH],
    0x000b: ["Position precision", "location", HIGH, "rational"],
    0x000c: ["Speed unit", "location", HIGH],
    0x000d: ["Speed", "location", HIGH, "rational"],
    0x000e: ["Track ref", "location", HIGH],
    0x000f: ["Track", "location", HIGH, "rational"],
    0x0010: ["Image direction ref", "location", HIGH],
    0x0011: ["Image direction", "location", HIGH, "rational"],
    0x0012: ["Map datum", "location", HIGH],
    0x0013: ["Destination latitude ref", "location", HIGH],
    0x0014: ["Destination latitude", "location", HIGH, "gpsCoord"],
    0x0015: ["Destination longitude ref", "location", HIGH],
    0x0016: ["Destination longitude", "location", HIGH, "gpsCoord"],
    0x0017: ["Destination bearing ref", "location", HIGH],
    0x0018: ["Destination bearing", "location", HIGH, "rational"],
    0x0019: ["Destination distance ref", "location", HIGH],
    0x001a: ["Destination distance", "location", HIGH, "rational"],
    0x001b: ["Positioning method", "location", HIGH, "charsetText"],
    0x001c: ["Area name", "location", HIGH, "charsetText"],
    0x001d: ["GPS date (UTC)", "location", HIGH],
    0x001e: ["Differential correction", "location", HIGH],
    0x001f: ["Horizontal error", "location", HIGH, "rational"],
  };

  const TAGS_INTEROP = {
    0x0001: ["Interoperability index", "render", LOW],
    0x0002: ["Interoperability version", "render", LOW, "version"],
  };

  /* Names only. These decode as plain numbers and nobody makes privacy
     decisions on them, so packing them as "hex:Name" saves a few hundred
     source lines. */
  const MORE_TAGS =
    "00fe:SubfileType 00ff:OldSubfileType 0107:Thresholding 0108:CellWidth 0109:CellLength " +
    "010a:FillOrder 0111:StripOffsets 0115:SamplesPerPixel 0116:RowsPerStrip 0117:StripByteCounts " +
    "011c:PlanarConfiguration 011d:PageName 0140:ColorMap 0141:HalftoneHints 0142:TileWidth " +
    "0143:TileLength 0152:ExtraSamples 0153:SampleFormat 0212:YCbCrSubSampling " +
    "828d:CFARepeatPatternDim 828e:CFAPattern 828f:BatteryLevel 8773:ICCProfileTag " +
    "8828:OECF 8829:Interlace 882a:TimeZoneOffset 882b:SelfTimerMode 9211:ImageNumber " +
    "9212:SecurityClassification 9213:ImageHistory 920b:FlashEnergy 920c:SpatialFrequencyResponse " +
    "920d:Noise 9216:TIFFEPStandardID a20c:SpatialFrequencyResponse a214:SubjectLocation " +
    "a302:CFAPattern a40b:DeviceSettingDescription a460:CompositeImage a461:SourceImageCount " +
    "a462:SourceExposureTimes a500:Gamma";

  let moreTags = null;
  function longTailName(tag) {
    if (!moreTags) {
      moreTags = new Map();
      for (const pair of MORE_TAGS.split(" ")) {
        const cut = pair.indexOf(":");
        moreTags.set(parseInt(pair.slice(0, cut), 16), pair.slice(cut + 1));
      }
    }
    return moreTags.get(tag) || null;
  }

  // A name we have to invent is not the same as a field that discloses
  // nothing, so an unknown tag is never classed low.
  function describeTag(ifdName, tag) {
    const table =
      ifdName === "gps" ? TAGS_GPS :
      ifdName === "exif" ? TAGS_EXIF :
      ifdName === "interop" ? TAGS_INTEROP : TAGS_IFD0;
    const hit = table[tag];
    if (hit) return { label: hit[0], group: hit[1], risk: hit[2], fmt: hit[3] || "auto" };
    const name = longTailName(tag);
    if (name) return { label: name, group: "other", risk: MED, fmt: "auto" };
    return {
      label: "Unknown tag 0x" + tag.toString(16).padStart(4, "0"),
      group: "other",
      risk: MED,
      fmt: "auto",
    };
  }

  /* Enumerations, spelled out rather than numbered: "Rotated 90 degrees
     clockwise" is actionable and "6" is not. */

  const ORIENTATION = {
    1: "Normal", 2: "Mirrored horizontally", 3: "Rotated 180°",
    4: "Mirrored vertically", 5: "Mirrored, then rotated 270° clockwise",
    6: "Rotated 90° clockwise", 7: "Mirrored, then rotated 90° clockwise",
    8: "Rotated 270° clockwise",
  };
  const RES_UNIT = { 1: "none", 2: "inches", 3: "centimetres" };
  const METERING = {
    0: "Unknown", 1: "Average", 2: "Centre-weighted", 3: "Spot", 4: "Multi-spot",
    5: "Pattern", 6: "Partial", 255: "Other",
  };
  const EXP_PROGRAM = {
    0: "Not defined", 1: "Manual", 2: "Normal", 3: "Aperture priority",
    4: "Shutter priority", 5: "Creative", 6: "Action", 7: "Portrait", 8: "Landscape",
  };
  const LIGHT_SOURCE = {
    0: "Unknown", 1: "Daylight", 2: "Fluorescent", 3: "Tungsten", 4: "Flash",
    9: "Fine weather", 10: "Cloudy", 11: "Shade", 17: "Standard light A",
    18: "Standard light B", 19: "Standard light C", 255: "Other",
  };
  const WHITE_BALANCE = { 0: "Auto", 1: "Manual" };
  const COLOR_SPACE = { 1: "sRGB", 2: "Adobe RGB", 0xfffd: "Wide gamut RGB", 0xffff: "Uncalibrated" };

  /* Formatters. Several need a neighbouring value: a latitude needs its N/S
     ref, a GPS time its date stamp, a user comment the byte order of its TIFF.
     Each formatter is therefore given the whole IFD rather than just its own
     value. */

  function ratio(pair) {
    if (!pair || pair.length < 2) return NaN;
    return pair[1] === 0 ? NaN : pair[0] / pair[1];
  }

  /* The single number a formatter needs, whatever numeric type it was stored
     in. Exposure time and aperture are rational by specification, but some
     software writes them as a float or an integer. Reading only the specified
     type would report a legible value as invalid. */
  function scalar(value, index = 0) {
    if (value.rationals && value.rationals.length > index) return ratio(value.rationals[index]);
    if (value.numbers && value.numbers.length > index) return value.numbers[index];
    return NaN;
  }

  function tidyNumber(n, places = 4) {
    if (!isFinite(n)) return "invalid";
    const fixed = n.toFixed(places);
    return fixed.replace(/\.?0+$/, "") || "0";
  }

  const FORMATTERS = {
    auto(v) {
      if (typeof v.text === "string") return trimNul(v.text);
      if (v.rationals) return v.rationals.map((p) => tidyNumber(ratio(p))).join(", ");
      if (v.numbers) return v.numbers.join(", ");
      return FORMATTERS.bytes(v);
    },

    bytes(v) {
      const raw = v.raw || new Uint8Array(0);
      if (looksLikeText(raw)) {
        const text = trimNul(LATIN1.decode(raw));
        if (text) return text;
      }
      return raw.length + " bytes · " + hexPreview(raw);
    },

    first(v) {
      return v.numbers && v.numbers.length ? String(v.numbers[0]) : FORMATTERS.auto(v);
    },

    rational(v) {
      if (v.rationals && v.rationals.length) return v.rationals.map((p) => tidyNumber(ratio(p))).join(", ");
      if (v.numbers && v.numbers.length) return v.numbers.map((n) => tidyNumber(n)).join(", ");
      return FORMATTERS.auto(v);
    },

    version(v) {
      const raw = v.raw || new Uint8Array(0);
      const digits = asciiAt(raw, 0, 4);
      if (/^\d{4}$/.test(digits)) return String(parseInt(digits.slice(0, 2), 10)) + "." + digits.slice(2);
      return FORMATTERS.auto(v);
    },

    orientation(v) {
      const n = v.numbers && v.numbers[0];
      return ORIENTATION[n] ? ORIENTATION[n] + " (" + n + ")" : String(n);
    },

    resolutionUnit(v) {
      const n = v.numbers && v.numbers[0];
      return RES_UNIT[n] || String(n);
    },

    exposureTime(v) {
      const n = scalar(v);
      if (!isFinite(n)) return "invalid";
      if (n >= 1) return tidyNumber(n, 2) + " s";
      // Cameras usually store it already as 1/x, so say it back that way.
      return "1/" + Math.round(1 / n) + " s";
    },

    fnumber(v) {
      const n = scalar(v);
      return isFinite(n) ? "f/" + tidyNumber(n, 1) : "invalid";
    },

    apexAperture(v) {
      const n = scalar(v);
      if (!isFinite(n)) return "invalid";
      return tidyNumber(n, 2) + " APEX (about f/" + Math.pow(2, n / 2).toFixed(1) + ")";
    },

    apexShutter(v) {
      const n = scalar(v);
      if (!isFinite(n)) return "invalid";
      const seconds = Math.pow(2, -n);
      const asFraction = seconds >= 1 ? tidyNumber(seconds, 2) + " s" : "1/" + Math.round(1 / seconds) + " s";
      return tidyNumber(n, 2) + " APEX (about " + asFraction + ")";
    },

    focalLength(v) {
      const n = scalar(v);
      return isFinite(n) ? tidyNumber(n, 1) + " mm" : "invalid";
    },

    meteringMode: (v) => METERING[v.numbers && v.numbers[0]] || String(v.numbers && v.numbers[0]),
    exposureProgram: (v) => EXP_PROGRAM[v.numbers && v.numbers[0]] || String(v.numbers && v.numbers[0]),
    lightSource: (v) => LIGHT_SOURCE[v.numbers && v.numbers[0]] || String(v.numbers && v.numbers[0]),
    whiteBalance: (v) => WHITE_BALANCE[v.numbers && v.numbers[0]] || String(v.numbers && v.numbers[0]),
    colorSpace: (v) => COLOR_SPACE[v.numbers && v.numbers[0]] || String(v.numbers && v.numbers[0]),

    flash(v) {
      const n = v.numbers && v.numbers[0];
      if (typeof n !== "number") return FORMATTERS.auto(v);
      if (n & 0x20) return "No flash function (" + n + ")";
      const parts = [n & 1 ? "Fired" : "Did not fire"];
      if (n & 0x18) parts.push(((n >> 3) & 3) === 1 ? "forced on" : ((n >> 3) & 3) === 2 ? "forced off" : "auto");
      if (n & 0x40) parts.push("red-eye reduction");
      return parts.join(", ") + " (" + n + ")";
    },

    // "YYYY:MM:DD HH:MM:SS". Never handed to Date(): the colons make it
    // unparseable and any parse that succeeds has invented a time zone.
    exifDate(v) {
      const text = trimNul(typeof v.text === "string" ? v.text : "");
      if (!text || /^[\s:]*$/.test(text)) return "(blank)";
      const m = text.match(/^(\d{4}):(\d{2}):(\d{2})[ T](.+)$/);
      return m ? m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] : text;
    },

    gpsCoord(v, ifd, ctx) {
      const parts = v.rationals || v.numbers || [];
      if (parts.length < 3) return FORMATTERS.auto(v);
      const deg = scalar(v, 0), min = scalar(v, 1), sec = scalar(v, 2);
      if (!isFinite(deg) || !isFinite(min) || !isFinite(sec)) return "invalid";
      const decimal = deg + min / 60 + sec / 3600;
      const refTag = ctx.tag === 0x0002 ? 0x0001 : ctx.tag === 0x0004 ? 0x0003
        : ctx.tag === 0x0014 ? 0x0013 : 0x0015;
      const ref = trimNul(String(ifd.decoded.get(refTag) && ifd.decoded.get(refTag).text || ""));
      const signed = /^[SW]$/i.test(ref) ? -decimal : decimal;
      return (
        signed.toFixed(6) + "° " + (ref || "?") +
        "  (" + Math.floor(deg) + "° " + Math.floor(min) + "′ " + sec.toFixed(1) + "″)"
      );
    },

    altitudeRef(v) {
      const n = v.numbers && v.numbers[0];
      return n === 1 ? "below sea level (1)" : "above sea level (" + n + ")";
    },

    gpsAltitude(v, ifd) {
      const n = scalar(v);
      if (!isFinite(n)) return "invalid";
      const refEntry = ifd.decoded.get(0x0005);
      const below = refEntry && refEntry.numbers && refEntry.numbers[0] === 1;
      return tidyNumber(n, 1) + " m " + (below ? "below sea level" : "above sea level");
    },

    // Time of day in UTC, and the date lives in a separate tag. Worth saying
    // "UTC" out loud: the gap between this and the local timestamp is itself a
    // disclosure about where the camera was.
    gpsTime(v, ifd) {
      const parts = v.rationals || v.numbers || [];
      if (parts.length < 3) return FORMATTERS.auto(v);
      const pad = (n) => String(Math.floor(n)).padStart(2, "0");
      const h = scalar(v, 0), m = scalar(v, 1), s = scalar(v, 2);
      if (!isFinite(h) || !isFinite(m) || !isFinite(s)) return "invalid";
      const dateEntry = ifd.decoded.get(0x001d);
      const date = dateEntry ? trimNul(String(dateEntry.text || "")).replace(/:/g, "-") : "";
      return (date ? date + " " : "") + pad(h) + ":" + pad(m) + ":" + pad(s) + " UTC";
    },

    /* The 8-byte charset designator in front of UserComment, and in front of
       the two GPS free-text tags, which use the identical prefix. The classic
       bug is decoding UNICODE as big-endian always: it is in the byte order of
       the TIFF it sits in. */
    charsetText(v, ifd) {
      const raw = v.raw || new Uint8Array(0);
      if (raw.length <= 8) return "(blank)";
      const charset = asciiAt(raw, 0, 8);
      const body = raw.subarray(8);
      if (/^ASCII/.test(charset)) return trimNul(LATIN1.decode(body)) || "(blank)";
      if (/^UNICODE/.test(charset)) {
        const dec = new TextDecoder(ifd.le ? "utf-16le" : "utf-16be");
        return trimNul(dec.decode(body)) || "(blank)";
      }
      if (/^JIS/.test(charset)) return "(JIS-encoded, " + body.length + " bytes)";
      // Undefined charset: sniff, because plenty of writers leave it blank.
      let zeros = 0;
      for (let i = 1; i < Math.min(body.length, 32); i += 2) if (body[i] === 0) zeros++;
      if (zeros > 6) return trimNul(new TextDecoder("utf-16le").decode(body)) || "(blank)";
      return trimNul(LATIN1.decode(body)) || "(blank)";
    },

    userComment(v, ifd) {
      return FORMATTERS.charsetText(v, ifd);
    },

    // Windows writes these little-endian whatever the TIFF says.
    xpString(v) {
      const raw = v.raw || new Uint8Array(0);
      return trimNul(new TextDecoder("utf-16le").decode(raw)) || "(blank)";
    },

    makerNote(v) {
      const raw = v.raw || new Uint8Array(0);
      const head = asciiAt(raw, 0, 10);
      const vendors = [
        ["Nikon", "Nikon"], ["OLYMPUS", "Olympus"], ["OM SYSTEM", "OM System"],
        ["FUJIFILM", "Fujifilm"], ["SONY", "Sony"], ["Apple iOS", "Apple"],
        ["PENTAX", "Pentax"], ["Panasonic", "Panasonic"], ["SAMSUNG", "Samsung"],
        ["LEICA", "Leica"], ["Ricoh", "Ricoh"], ["CASIO", "Casio"],
      ];
      let vendor = "unrecognised format";
      for (const [sig, name] of vendors) if (head.indexOf(sig) === 0) { vendor = name; break; }
      return vendor + ", " + raw.length + " bytes of camera-private data";
    },
  };

  function runFormatter(name, decoded, ifd, ctx) {
    const fn = FORMATTERS[name] || FORMATTERS.auto;
    try {
      const out = fn(decoded, ifd, ctx);
      return typeof out === "string" ? out : String(out);
    } catch (err) {
      return FORMATTERS.auto(decoded);
    }
  }

  /* ── Escalation ────────────────────────────────────────────────────────
     The leak that actually burns people is not tag-specific. A full Windows
     path in a Software string, an email in a caption, a serial in a field
     nobody thinks to read — any of those outrank whatever the tag table said,
     so a value that trips this is reclassified on the spot. */

  function sniffSensitive(text) {
    if (!text || text.length > 4096) return null;
    if (/[A-Za-z]:\\Users\\|\/Users\/|\/home\/|\\Documents\\|\/Documents\//.test(text)) {
      return "holds a file path with an account name in it";
    }
    if (/[\w.+-]+@[\w-]+\.[\w.]{2,}/.test(text)) return "holds an email address";
    if (/\+\d[\d\s()-]{9,}\d/.test(text)) return "holds something shaped like a phone number";
    if (/\b[A-Z0-9]{10,}\b/.test(text)) return "holds something shaped like a serial number";
    return null;
  }

  /* TIFF, reading. EXIF is a TIFF file wherever it is stored: a JPEG APP1
     segment, a PNG eXIf chunk, a WebP EXIF chunk. The block is sliced out
     first so every offset inside is relative to zero. Offsets in a TIFF are
     relative to the first byte of the II/MM header, and slicing makes it
     impossible to get that wrong. */

  const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
  const POINTER_TAGS = new Set([0x8769, 0x8825, 0xa005]);
  /* Tags whose value is a position in the file. Any of these that we do not
     handle explicitly is dropped rather than copied: a pointer we move without
     understanding is worse than a tag we lose. */
  const OFFSET_TAGS = new Set([
    0x0111, 0x0117, 0x0120, 0x0144, 0x0145, 0x0201, 0x0202, 0x0207, 0x0208, 0x0209, 0x014a,
  ]);

  const IFD_LIMIT = 24;
  const ENTRY_LIMIT = 4096;

  function decodeEntry(entry, le) {
    const raw = entry.valueBytes;
    const out = { raw };
    const t = entry.type;
    const n = entry.count;
    if (t === 2) {
      out.text = LATIN1.decode(raw);
      return out;
    }
    if (t === 5 || t === 10) {
      const pairs = [];
      for (let i = 0; i + 8 <= raw.length && pairs.length < 64; i += 8) {
        pairs.push(
          t === 5 ? [u32(raw, i, le), u32(raw, i + 4, le)] : [i32(raw, i, le), i32(raw, i + 4, le)]
        );
      }
      out.rationals = pairs;
      return out;
    }
    if (t === 1 || t === 3 || t === 4 || t === 6 || t === 8 || t === 9 || t === 11 || t === 12) {
      const nums = [];
      const size = TYPE_SIZE[t];
      const dv = t >= 11 ? new DataView(raw.buffer, raw.byteOffset, raw.byteLength) : null;
      for (let i = 0, k = 0; k < n && i + size <= raw.length && k < 64; i += size, k++) {
        if (t === 1) nums.push(raw[i]);
        else if (t === 6) nums.push((raw[i] << 24) >> 24);
        else if (t === 3) nums.push(u16(raw, i, le));
        else if (t === 8) nums.push((u16(raw, i, le) << 16) >> 16);
        else if (t === 4) nums.push(u32(raw, i, le));
        else if (t === 9) nums.push(i32(raw, i, le));
        else if (t === 11) nums.push(dv.getFloat32(i, le));
        else nums.push(dv.getFloat64(i, le));
      }
      out.numbers = nums;
      return out;
    }
    return out; // UNDEFINED and anything unrecognised stay raw
  }

  function parseIfd(tiff, offset, name, seen, depth) {
    const block = tiff.block;
    const le = tiff.le;
    if (offset < 8 || offset + 2 > block.length) return null;
    if (seen.has(offset) || seen.size > IFD_LIMIT || depth > 3) return null;
    seen.add(offset);

    const count = u16(block, offset, le);
    if (!count || count > ENTRY_LIMIT) {
      if (count > ENTRY_LIMIT) tiff.warnings.push("An EXIF directory claimed " + count + " entries and was skipped.");
      return count ? null : { name, offset, le, entries: [], decoded: new Map(), next: 0 };
    }
    if (offset + 2 + count * 12 + 4 > block.length) {
      tiff.warnings.push("The EXIF block is truncated; part of it could not be read.");
      return null;
    }

    const ifd = { name, offset, le, entries: [], decoded: new Map(), next: 0, subs: {} };
    const seenTags = new Set();

    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      const tag = u16(block, at, le);
      const type = u16(block, at + 2, le);
      const n = u32(block, at + 4, le);

      // Duplicate tags in one directory are illegal and do happen. Keep the
      // first, or two fields collide on one id.
      if (seenTags.has(tag)) continue;
      seenTags.add(tag);

      const size = type >= 1 && type <= 13 ? TYPE_SIZE[type] : 0;
      const byteLength = size * n;
      const entry = {
        tag, type, count: n, byteLength,
        pointer: POINTER_TAGS.has(tag),
        bad: false,
        inline: byteLength <= 4,
        dataOffset: null,
        valueBytes: new Uint8Array(0),
      };

      if (!size || byteLength > block.length) {
        entry.bad = true;
      } else if (byteLength <= 4) {
        // Values of four bytes or fewer sit in the entry, left-aligned from
        // the first byte in BOTH byte orders. Right-aligning big-endian shorts
        // is the other classic EXIF bug.
        entry.valueBytes = block.slice(at + 8, at + 8 + byteLength);
      } else {
        const dataAt = u32(block, at + 8, le);
        if (dataAt + byteLength > block.length) {
          entry.bad = true;
        } else {
          entry.dataOffset = dataAt;
          entry.valueBytes = block.slice(dataAt, dataAt + byteLength);
        }
      }

      ifd.entries.push(entry);
      if (!entry.bad) ifd.decoded.set(tag, decodeEntry(entry, le));
    }

    ifd.next = u32(block, offset + 2 + count * 12, le);
    return ifd;
  }

  function parseTiff(block) {
    if (block.length < 8) return null;
    const order = asciiAt(block, 0, 2);
    if (order !== "II" && order !== "MM") return null;
    const le = order === "II";
    if (u16(block, 2, le) !== 42) return null;

    const tiff = { block, le, order, warnings: [], ifds: {} };
    const seen = new Set();
    const ifd0 = parseIfd(tiff, u32(block, 4, le), "ifd0", seen, 0);
    if (!ifd0) return null;
    tiff.ifds.ifd0 = ifd0;

    const follow = (from, tag, name) => {
      const entry = from.entries.find((e) => e.tag === tag && !e.bad);
      if (!entry) return null;
      const target = entry.inline
        ? u32(entry.valueBytes, 0, le)
        : entry.dataOffset !== null ? u32(block, entry.dataOffset, le) : 0;
      const sub = parseIfd(tiff, target, name, seen, 1);
      if (sub) tiff.ifds[name] = sub;
      return sub;
    };

    const exif = follow(ifd0, 0x8769, "exif");
    follow(ifd0, 0x8825, "gps");
    if (exif) follow(exif, 0xa005, "interop");

    // IFD1 is the thumbnail directory. Anything chained past it is legal but
    // unused by EXIF, and re-chaining it is more risk than it is worth.
    if (ifd0.next) {
      const ifd1 = parseIfd(tiff, ifd0.next, "ifd1", seen, 1);
      if (ifd1) {
        tiff.ifds.ifd1 = ifd1;
        if (ifd1.next) tiff.warnings.push("Extra image directories past the thumbnail were found and will not be carried over.");
      }
    }

    // The thumbnail's own bytes, sliced now while the original offsets are
    // still meaningful. A thumbnail that does not start with a JPEG signature,
    // or that runs past the block, is treated as absent: a pointer to nothing
    // is strictly worse than no pointer.
    tiff.thumb = null;
    const ifd1 = tiff.ifds.ifd1;
    if (ifd1) {
      const at = ifd1.decoded.get(0x0201);
      const len = ifd1.decoded.get(0x0202);
      const start = at && at.numbers ? at.numbers[0] : 0;
      const size = len && len.numbers ? len.numbers[0] : 0;
      if (start && size && start + size <= block.length && block[start] === 0xff && block[start + 1] === 0xd8) {
        tiff.thumb = block.slice(start, start + size);
      } else if (start || size) {
        tiff.warnings.push("The embedded thumbnail is damaged and will not be carried over.");
      }
    }

    return tiff;
  }

  /* ── TIFF, writing ─────────────────────────────────────────────────────
     Rebuild the directories from the kept entries and recompute every offset.
     Values are copied verbatim, byte order is preserved, and nothing is added
     that was not already present — so the rebuilt block is always smaller than
     the one that came in. That shrink-only property is what makes the maker
     note trick below sound. */

  function isSelfContainedMakerNote(bytes) {
    // Notes that carry their own TIFF header (Nikon type 3) or count from
    // their own first byte (Fujifilm, Panasonic, Apple) survive being moved.
    const head = asciiAt(bytes, 0, 10);
    return /^(Nikon\0|FUJIFILM|Panasonic\0|Apple iOS\0)/.test(head);
  }

  function serializeTiff(tiff, keep) {
    const le = tiff.le;
    const src = tiff.ifds;

    // Pass 0 — prune, then collapse anything left empty, innermost first.
    const kept = {};
    for (const name of ["ifd0", "exif", "gps", "interop"]) {
      const ifd = src[name];
      if (!ifd) continue;
      kept[name] = ifd.entries.filter((e) => {
        if (e.bad || e.pointer) return false;
        if (OFFSET_TAGS.has(e.tag)) return false;
        return keep("exif:" + name + ":0x" + e.tag.toString(16).padStart(4, "0"));
      });
    }

    const keepThumb = !!tiff.thumb && keep("exif:thumbnail");
    if (!kept.interop || !kept.interop.length) delete kept.interop;
    if (kept.exif && !kept.exif.length && !kept.interop) delete kept.exif;
    if (kept.gps && !kept.gps.length) delete kept.gps;
    if (!kept.ifd0) kept.ifd0 = [];
    if (!kept.ifd0.length && !kept.exif && !kept.gps && !keepThumb) return null;

    // The maker note, if it survived. Notes whose internal pointers are
    // absolute into the TIFF break the moment they move, so instead of moving
    // them we pin them: because the rebuilt directories can only be smaller,
    // the note's original offset is still free, and every internal pointer
    // keeps its literal value and is provably still right.
    let pin = null;
    if (kept.exif) {
      const note = kept.exif.find((e) => e.tag === 0x927c);
      if (note && note.dataOffset !== null && !isSelfContainedMakerNote(note.valueBytes)) {
        pin = { entry: note, offset: note.dataOffset };
      }
    }

    const order = [];
    const push = (name, entries) => { if (entries) order.push({ name, entries }); };
    push("ifd0", kept.ifd0);
    const thumbEntries = [];
    if (keepThumb) {
      const ifd1 = src.ifd1;
      for (const e of ifd1.entries) {
        if (e.bad || e.pointer || e.tag === 0x0201 || e.tag === 0x0202) continue;
        if (OFFSET_TAGS.has(e.tag)) continue;
        thumbEntries.push(e);
      }
      // Synthesised fresh: the length is taken from the bytes we actually have
      // rather than trusted from the file.
      thumbEntries.push(makeLongEntry(0x0201, 0, le), makeLongEntry(0x0202, tiff.thumb.length, le));
      order.push({ name: "ifd1", entries: thumbEntries });
    }
    push("exif", kept.exif);
    push("gps", kept.gps);
    push("interop", kept.interop);

    // Pointer entries are synthesised, never copied, so a pointer can only
    // exist when the thing it points at does.
    if (kept.exif) kept.ifd0.push(makeLongEntry(0x8769, 0, le));
    if (kept.gps) kept.ifd0.push(makeLongEntry(0x8825, 0, le));
    if (kept.interop) kept.exif.push(makeLongEntry(0xa005, 0, le));

    // TIFF wants ascending tag order inside a directory, and plenty of readers
    // quietly depend on it.
    for (const ifd of order) ifd.entries.sort((a, b) => a.tag - b.tag);

    // Pass 1 — lay out the directory blocks, then the data area around the pin.
    let cursor = 8;
    for (const ifd of order) {
      ifd.at = cursor;
      cursor += 2 + 12 * ifd.entries.length + 4;
    }

    let reserved = null;
    if (pin && pin.offset >= cursor) {
      reserved = [pin.offset, pin.offset + pin.entry.byteLength];
      pin.entry.newOffset = pin.offset;
    } else if (pin) {
      pin = null; // cannot pin it; the caller is told and the note is dropped
    }

    const align = (n) => (n & 1 ? n + 1 : n);
    const skipPin = (at, size) =>
      reserved && at < reserved[1] && at + size > reserved[0] ? reserved[1] : at;

    cursor = align(cursor);
    for (const ifd of order) {
      for (const e of ifd.entries) {
        if (e.byteLength <= 4 || (pin && e === pin.entry)) continue;
        cursor = align(skipPin(cursor, e.byteLength));
        e.newOffset = cursor;
        cursor += e.byteLength;
      }
    }

    let thumbAt = 0;
    if (keepThumb) {
      cursor = align(skipPin(align(cursor), tiff.thumb.length));
      thumbAt = cursor;
      cursor += tiff.thumb.length;
    }

    const total = Math.max(cursor, reserved ? reserved[1] : 0);
    const out = new Uint8Array(total);

    // Pass 2 — emit.
    out[0] = le ? 0x49 : 0x4d;
    out[1] = out[0];
    put16(out, 2, 42, le);
    put32(out, 4, order[0].at, le);

    const at = (name) => {
      const hit = order.find((o) => o.name === name);
      return hit ? hit.at : 0;
    };

    for (const ifd of order) {
      let p = ifd.at;
      put16(out, p, ifd.entries.length, le);
      p += 2;
      for (const e of ifd.entries) {
        put16(out, p, e.tag, le);
        put16(out, p + 2, e.type, le);
        put32(out, p + 4, e.count, le);
        if (e.tag === 0x8769) put32(out, p + 8, at("exif"), le);
        else if (e.tag === 0x8825) put32(out, p + 8, at("gps"), le);
        else if (e.tag === 0xa005) put32(out, p + 8, at("interop"), le);
        else if (e.tag === 0x0201 && ifd.name === "ifd1") put32(out, p + 8, thumbAt, le);
        else if (e.byteLength <= 4) out.set(e.valueBytes, p + 8);
        else {
          put32(out, p + 8, e.newOffset, le);
          out.set(e.valueBytes, e.newOffset);
        }
        p += 12;
      }
      // Only IFD0 chains, and only to the thumbnail directory.
      const next = ifd.name === "ifd0" && keepThumb ? at("ifd1") : 0;
      put32(out, p, next, le);
    }

    if (keepThumb) out.set(tiff.thumb, thumbAt);
    return out;
  }

  function makeLongEntry(tag, value, le) {
    const valueBytes = new Uint8Array(4);
    put32(valueBytes, 0, value, le);
    return {
      tag, type: 4, count: 1, byteLength: 4, valueBytes,
      pointer: POINTER_TAGS.has(tag), bad: false, inline: true, dataOffset: null,
    };
  }

  /* ── ICC ───────────────────────────────────────────────────────────────
     The profile is not parsed beyond its header and its description, because
     the description is the only part anyone reads and the rest is a colour
     transform, not a disclosure. What matters here is telling a wide-gamut
     profile from plain sRGB: dropping the first shifts the colours visibly,
     dropping the second changes nothing a viewer would notice. */

  function describeIcc(profile) {
    if (!profile || profile.length < 132) return { name: "", summary: "unreadable profile" };
    const space = asciiAt(profile, 16, 4).trim();
    const count = u32(profile, 128, false);
    let name = "";
    if (count > 0 && count < 256) {
      for (let i = 0; i < count; i++) {
        const at = 132 + i * 12;
        if (at + 12 > profile.length) break;
        if (asciiAt(profile, at, 4) !== "desc") continue;
        const off = u32(profile, at + 4, false);
        const size = u32(profile, at + 8, false);
        if (off + size > profile.length) break;
        const kind = asciiAt(profile, off, 4);
        if (kind === "desc") {
          const len = u32(profile, off + 8, false);
          name = trimNul(asciiAt(profile, off + 12, Math.max(0, Math.min(len, size - 12))));
        } else if (kind === "mluc") {
          const len = u32(profile, off + 20, false);
          const at2 = u32(profile, off + 24, false);
          if (off + at2 + len <= profile.length) {
            name = trimNul(new TextDecoder("utf-16be").decode(profile.subarray(off + at2, off + at2 + len)));
          }
        }
        break;
      }
    }
    const wide = /P3|Adobe ?RGB|ProPhoto|Rec\.? ?2020|scRGB|Wide/i.test(name);
    return {
      name,
      wide,
      summary: (name || space || "profile") + " · " + fileSize(profile.length),
    };
  }

  /* ── IPTC IIM ──────────────────────────────────────────────────────────
     Flat records, so removal really is per-field here. Datasets have no
     declared encoding of their own: 1:90 CodedCharacterSet says UTF-8 when it
     is present, and Photoshop writes UTF-8 without saying so often enough that
     sniffing beats trusting the marker. */

  const IPTC_NAMES = {
    5: ["Object name", "text", MED], 15: ["Category", "text", MED],
    20: ["Supplemental category", "text", MED], 25: ["Keywords", "text", MED],
    40: ["Special instructions", "text", MED], 55: ["Date created", "dates", MED],
    60: ["Time created", "dates", MED], 62: ["Digital date created", "dates", MED],
    63: ["Digital time created", "dates", MED], 65: ["Originating program", "device", MED],
    70: ["Program version", "device", MED], 80: ["By-line", "people", HIGH],
    85: ["By-line title", "people", HIGH], 90: ["City", "location", HIGH],
    92: ["Sublocation", "location", HIGH], 95: ["Province or state", "location", HIGH],
    100: ["Country code", "location", HIGH], 101: ["Country", "location", HIGH],
    103: ["Transmission reference", "other", MED], 105: ["Headline", "text", MED],
    110: ["Credit", "people", HIGH], 115: ["Source", "people", HIGH],
    116: ["Copyright notice", "people", HIGH], 118: ["Contact", "people", HIGH],
    120: ["Caption", "text", HIGH], 122: ["Caption writer", "people", HIGH],
  };

  function parseIptc(bytes) {
    const records = [];
    let i = 0;
    let utf8 = false;
    while (i + 5 <= bytes.length) {
      if (bytes[i] !== 0x1c) { i++; continue; }
      const record = bytes[i + 1];
      const dataset = bytes[i + 2];
      let len = u16(bytes, i + 3, false);
      let at = i + 5;
      if (len & 0x8000) {
        // Extended length: the low bits say how many length bytes follow.
        const n = len & 0x7fff;
        if (n > 4 || at + n > bytes.length) break;
        len = 0;
        for (let k = 0; k < n; k++) len = len * 256 + bytes[at + k];
        at += n;
      }
      if (at + len > bytes.length) break;
      const data = bytes.slice(at, at + len);
      if (record === 1 && dataset === 90 && sigAt(data, 0, "\x1b%G")) utf8 = true;
      records.push({ record, dataset, data });
      i = at + len;
    }
    for (const r of records) r.text = decodeIptcText(r.data, utf8);
    return records;
  }

  function decodeIptcText(bytes, declaredUtf8) {
    if (declaredUtf8) {
      try { return trimNul(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (e) { /* fall through */ }
    }
    let highBit = false;
    for (const b of bytes) if (b > 0x7f) { highBit = true; break; }
    if (highBit) {
      try { return trimNul(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (e) { /* fall through */ }
    }
    return trimNul(LATIN1.decode(bytes));
  }

  function writeIptc(records) {
    const parts = [];
    for (const r of records) {
      const len = r.data.length;
      if (len < 0x8000) {
        const head = new Uint8Array(5);
        head[0] = 0x1c; head[1] = r.record; head[2] = r.dataset;
        put16(head, 3, len, false);
        parts.push(head, r.data);
      } else {
        const head = new Uint8Array(9);
        head[0] = 0x1c; head[1] = r.record; head[2] = r.dataset;
        put16(head, 3, 0x8004, false);
        put32(head, 5, len, false);
        parts.push(head, r.data);
      }
    }
    return parts.length ? concat(parts) : null;
  }

  /* ── Photoshop image resource blocks ───────────────────────────────────
     A flat list of resources, one of which (0x0404) holds the IPTC records
     above. The Pascal-style name is padded so that the length byte plus the
     name is an even count, which makes an empty name two bytes rather than
     one — an off-by-one that silently shifts every resource after it. */

  const PSD_NAMES = {
    0x0404: ["IPTC record", "other", HIGH],
    0x040f: ["ICC profile", "render", LOW],
    0x0422: ["EXIF block", "other", MED],
    0x0424: ["XMP packet", "other", HIGH],
    0x0425: ["Caption digest", "other", LOW],
    0x0410: ["Watermark", "other", MED],
    0x041a: ["Slices", "other", HIGH],
    0x0400: ["Layer state", "other", MED],
    0x0408: ["Grid and guides", "other", LOW],
    0x03f3: ["Print flags", "other", LOW],
    0x0426: ["Print scale", "other", LOW],
  };

  function parsePhotoshop(bytes) {
    const out = [];
    let i = 0;
    while (i + 12 <= bytes.length) {
      if (!sigAt(bytes, i, "8BIM")) { i++; continue; }
      const id = u16(bytes, i + 4, false);
      const nameLen = bytes[i + 6];
      let at = i + 6 + 1 + nameLen;
      if ((1 + nameLen) & 1) at++;
      if (at + 4 > bytes.length) break;
      const size = u32(bytes, at, false);
      at += 4;
      if (at + size > bytes.length) break;
      out.push({
        id,
        name: asciiAt(bytes, i + 7, nameLen),
        data: bytes.slice(at, at + size),
      });
      i = at + size + (size & 1);
    }
    return out;
  }

  function writePhotoshop(resources) {
    const parts = [];
    const enc = new TextEncoder();
    for (const r of resources) {
      const nameBytes = enc.encode(r.name || "");
      const nameLen = Math.min(nameBytes.length, 255);
      const pad = (1 + nameLen) & 1 ? 1 : 0;
      const head = new Uint8Array(6 + 1 + nameLen + pad + 4);
      head[0] = 0x38; head[1] = 0x42; head[2] = 0x49; head[3] = 0x4d; // 8BIM
      put16(head, 4, r.id, false);
      head[6] = nameLen;
      head.set(nameBytes.subarray(0, nameLen), 7);
      put32(head, 7 + nameLen + pad, r.data.length, false);
      parts.push(head, r.data);
      if (r.data.length & 1) parts.push(new Uint8Array(1));
    }
    return parts.length ? concat(parts) : null;
  }

  /* ── XMP ───────────────────────────────────────────────────────────────
     Listed property by property so a reader can see what is in there, but
     removed as a whole packet. Editing XMP in place means namespace-correct
     round-tripping of somebody else's XML, and a packet that comes back
     subtly wrong is worse than a packet that is gone. */

  function xmpProperties(text) {
    const props = [];
    try {
      const doc = new DOMParser().parseFromString(text, "application/xml");
      if (doc.querySelector("parsererror")) return props;
      const walk = (node) => {
        for (const attr of node.attributes || []) {
          if (/^xmlns/.test(attr.name) || attr.name === "rdf:about") continue;
          if (attr.value.trim()) props.push([attr.name, attr.value.trim()]);
        }
        for (const child of node.children) {
          const kids = child.children;
          if (!kids.length) {
            const value = (child.textContent || "").trim();
            if (value) props.push([child.nodeName, value]);
          }
          walk(child);
        }
      };
      walk(doc.documentElement);
    } catch (err) { /* an unparseable packet still gets removed as a whole */ }
    const seen = new Set();
    return props.filter(([k, v]) => {
      const key = k + "=" + v;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 80);
  }

  /* ── JPEG ──────────────────────────────────────────────────────────────
     A run of marker segments, then the scan, then the end marker. Everything
     from the start-of-scan onward is copied byte for byte: that is the picture
     and this tool has no business touching it. */

  const JPEG_APP_NAMES = {
    0xe0: "JFIF header", 0xe1: "APP1", 0xe2: "APP2", 0xe3: "APP3", 0xe4: "APP4",
    0xe5: "APP5", 0xe6: "APP6", 0xe7: "APP7", 0xe8: "APP8", 0xe9: "APP9",
    0xea: "APP10", 0xeb: "APP11", 0xec: "APP12", 0xed: "APP13", 0xee: "Adobe colour transform",
    0xef: "APP15",
  };

  const XMP_SIG = "http://ns.adobe.com/xap/1.0/\0";
  const XMP_EXT_SIG = "http://ns.adobe.com/xmp/extension/\0";

  function walkJpeg(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const segments = [];
    let i = 2;
    let scanAt = -1;

    while (i + 2 <= bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      let j = i + 1;
      while (j < bytes.length && bytes[j] === 0xff) j++; // fill bytes are legal
      const marker = bytes[j];
      if (marker === undefined) break;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i = j + 1; continue; }
      if (marker === 0xd9) { scanAt = j + 1; break; }
      if (marker === 0xda) { scanAt = i; break; }
      if (j + 3 > bytes.length) break;
      const len = u16(bytes, j + 1, false);
      if (len < 2 || j + 1 + len > bytes.length) break;
      segments.push({ marker, payload: bytes.slice(j + 3, j + 1 + len) });
      i = j + 1 + len;
    }

    if (scanAt < 0) return null;

    // FF D9 cannot occur inside entropy-coded data (an FF there is always
    // followed by 00 or a restart marker), so the first one after the scan
    // starts is the real end of image. Anything past it is a trailer.
    let end = bytes.length;
    for (let k = scanAt; k + 1 < bytes.length; k++) {
      if (bytes[k] === 0xff && bytes[k + 1] === 0xd9) { end = k + 2; break; }
    }

    return {
      segments,
      scan: bytes.slice(scanAt, end),
      trailer: end < bytes.length ? bytes.slice(end) : null,
    };
  }

  function writeJpeg(parts, plan) {
    const out = [new Uint8Array([0xff, 0xd8])];
    for (const seg of parts.segments) {
      const payload = plan.segment(seg);
      if (!payload) continue;
      const head = new Uint8Array(4);
      head[0] = 0xff; head[1] = seg.marker;
      put16(head, 2, payload.length + 2, false);
      out.push(head, payload);
    }
    out.push(parts.scan);
    if (parts.trailer && plan.keepTrailer) out.push(parts.trailer);
    return concat(out);
  }

  /* ── PNG ───────────────────────────────────────────────────────────────
     Chunks in, chunks out, original order preserved. Because nothing is ever
     inserted, the ordering rules the format cares about (header first, palette
     before the data, end last) hold without a line of code. */

  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const PNG_CRITICAL = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
  /* Lowercase by the naming convention, structural in fact: APNG's control
     chunks and the transparency chunk all change what is drawn. */
  const PNG_STRUCTURAL = new Set(["tRNS", "acTL", "fcTL", "fdAT"]);

  const PNG_CHUNK_NAMES = {
    tIME: ["Last modified", "dates", MED],
    pHYs: ["Physical pixel size", "render", LOW],
    gAMA: ["Gamma", "render", LOW],
    cHRM: ["Chromaticities", "render", LOW],
    sRGB: ["sRGB rendering intent", "render", LOW],
    sBIT: ["Significant bits", "render", LOW],
    bKGD: ["Background colour", "render", LOW],
    hIST: ["Palette histogram", "render", LOW],
    sPLT: ["Suggested palette", "render", LOW],
    eXIf: ["EXIF block", "other", MED],
  };

  function walkPng(bytes) {
    for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return null;
    const chunks = [];
    let i = 8;
    while (i + 12 <= bytes.length) {
      const len = u32(bytes, i, false);
      if (len > bytes.length) break;
      const type = asciiAt(bytes, i + 4, 4);
      if (i + 12 + len > bytes.length) break;
      const data = bytes.slice(i + 8, i + 8 + len);
      const stored = u32(bytes, i + 8 + len, false);
      const chunk = { type, data, crcOk: crc32(bytes.slice(i + 4, i + 8 + len)) === stored, crc: stored };
      chunks.push(chunk);
      i += 12 + len;
      if (type === "IEND") break;
    }
    return chunks.length ? { chunks } : null;
  }

  function pngChunkBytes(chunk, rebuiltData) {
    const data = rebuiltData || chunk.data;
    const out = new Uint8Array(12 + data.length);
    put32(out, 0, data.length, false);
    for (let i = 0; i < 4; i++) out[4 + i] = chunk.type.charCodeAt(i);
    out.set(data, 8);
    // A chunk copied through keeps its original check value, so a file that
    // arrived with a bad one stays exactly as wrong as it was. Only a chunk we
    // actually rewrote gets a fresh one.
    put32(out, 8 + data.length, rebuiltData ? crc32(out.slice(4, 8 + data.length)) : chunk.crc, false);
    return out;
  }

  function writePng(parts, plan) {
    const out = [new Uint8Array(PNG_SIG)];
    for (const chunk of parts.chunks) {
      const verdict = plan.chunk(chunk);
      if (!verdict) continue;
      out.push(pngChunkBytes(chunk, verdict === true ? null : verdict));
    }
    return concat(out);
  }

  /* ── WebP ──────────────────────────────────────────────────────────────
     RIFF chunks, padded to even. The catch is the VP8X flag byte: it promises
     which optional chunks exist, and a flag left set for a chunk we removed
     makes strict decoders reject the file. The alpha and animation bits
     describe pixel data and are never touched. */

  const WEBP_FLAG = { ICCP: 0x20, EXIF: 0x08, "XMP ": 0x04 };
  const WEBP_STRUCTURAL = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF"]);

  function walkWebp(bytes) {
    if (bytes.length < 12 || !sigAt(bytes, 0, "RIFF") || !sigAt(bytes, 8, "WEBP")) return null;
    const chunks = [];
    let i = 12;
    while (i + 8 <= bytes.length) {
      const fourcc = asciiAt(bytes, i, 4);
      const size = u32(bytes, i + 4, true);
      if (i + 8 + size > bytes.length) break;
      chunks.push({ fourcc, data: bytes.slice(i + 8, i + 8 + size) });
      i += 8 + size + (size & 1);
    }
    return chunks.length ? { chunks } : null;
  }

  function writeWebp(parts, plan) {
    const kept = [];
    let cleared = 0;
    for (const chunk of parts.chunks) {
      if (plan.chunk(chunk)) kept.push(chunk);
      else if (WEBP_FLAG[chunk.fourcc]) cleared |= WEBP_FLAG[chunk.fourcc];
    }

    const body = [];
    for (const chunk of kept) {
      const head = new Uint8Array(8);
      for (let i = 0; i < 4; i++) head[i] = chunk.fourcc.charCodeAt(i);
      put32(head, 4, chunk.data.length, true);
      let data = chunk.data;
      // The header stays even when every flag it carries is cleared. Collapsing
      // back to a simple WebP saves eighteen bytes and risks the canvas size.
      if (chunk.fourcc === "VP8X" && cleared && data.length >= 1) {
        data = data.slice();
        data[0] &= ~cleared & 0xff;
      }
      body.push(head, data);
      if (data.length & 1) body.push(new Uint8Array(1));
    }

    const payload = concat(body);
    const out = new Uint8Array(12 + payload.length);
    for (let i = 0; i < 4; i++) out[i] = "RIFF".charCodeAt(i);
    put32(out, 4, 4 + payload.length, true);
    for (let i = 0; i < 4; i++) out[8 + i] = "WEBP".charCodeAt(i);
    out.set(payload, 12);
    return out;
  }

  /* ── Fields ────────────────────────────────────────────────────────────
     One row of the sheet. The id is keyed to where the value is stored, not to
     the file it came from, so a rule set made while reading one photo applies
     to every other photo that has the same field. That is what makes a batch
     of fifty the same operation as a batch of one. */

  function makeField(spec) {
    const field = {
      id: spec.id,
      key: spec.key || spec.id,
      label: spec.label,
      group: spec.group || "other",
      value: spec.value == null ? "" : String(spec.value),
      risk: spec.risk || MED,
      removable: spec.removable !== false,
      note: spec.note || "",
      warn: spec.warn || null,
    };
    field.blank = !field.value || field.value === "(blank)";

    // A value can outrank its own tag. A path with an account name in it is a
    // disclosure whatever field it turned up in.
    const sniff = sniffSensitive(field.value);
    if (sniff) {
      field.risk = HIGH;
      field.note = field.note || "This value " + sniff + ".";
    } else if (field.blank) {
      field.risk = LOW;
      field.note = field.note || "Empty.";
    }
    return field;
  }

  function tiffFields(tiff, out) {
    for (const name of ["ifd0", "exif", "gps", "interop"]) {
      const ifd = tiff.ifds[name];
      if (!ifd) continue;
      for (const entry of ifd.entries) {
        if (entry.bad || entry.pointer || OFFSET_TAGS.has(entry.tag)) continue;
        const hex = "0x" + entry.tag.toString(16).padStart(4, "0");
        const desc = describeTag(name, entry.tag);
        const decoded = ifd.decoded.get(entry.tag) || { raw: entry.valueBytes };
        const value = runFormatter(desc.fmt, decoded, ifd, { tag: entry.tag });

        let warn = null;
        if (name === "ifd0" && entry.tag === 0x0112) {
          const n = decoded.numbers && decoded.numbers[0];
          if (n && n !== 1) {
            warn = {
              kind: "orientation",
              text:
                "This photo is stored " + (ORIENTATION[n] || "rotated").toLowerCase() +
                " and relies on the orientation tag to appear the right way up. " +
                "Remove it and most viewers will show it sideways.",
            };
          }
        }

        out.push(makeField({
          id: "exif:" + name + ":" + hex,
          key: "exif " + (name === "ifd0" ? "tiff" : name) + " " + hex,
          label: desc.label,
          group: desc.group,
          risk: desc.risk,
          value,
          warn,
          note: entry.tag === 0x927c
            ? "Camera makers put body and lens serial numbers, shutter counts and owner names in here. Its contents are undocumented, so this tool shows the size and the vendor and nothing more."
            : "",
        }));
      }
    }

    if (tiff.thumb) {
      out.push(makeField({
        id: "exif:thumbnail",
        key: "exif thumbnail",
        label: "Embedded thumbnail",
        group: "thumbnail",
        risk: HIGH,
        value: "JPEG preview · " + fileSize(tiff.thumb.length),
        note: "A thumbnail is a second copy of the picture, and it is often the copy from before you cropped or edited. It can show what you took out.",
      }));
    }
  }

  function xmpField(text, out) {
    const props = xmpProperties(text);
    const lines = props.map(([k, v]) => k + " = " + (v.length > 160 ? v.slice(0, 160) + "…" : v));
    out.push(makeField({
      id: "xmp",
      key: "xmp packet",
      label: "XMP packet" + (props.length ? " (" + props.length + " properties)" : ""),
      group: props.some(([k]) => /creator|author|owner|rights|person/i.test(k)) ? "people" : "text",
      risk: HIGH,
      value: lines.length ? lines.join("\n") : text.length + " bytes of XMP",
      note: "XMP collects everything else in one place: authorship, ratings, editing history, and often the names of the files a photo was built from. It is removed as a whole packet rather than property by property.",
    }));
  }

  function iccField(profile, out) {
    const icc = describeIcc(profile);
    out.push(makeField({
      id: "icc",
      key: "icc profile",
      label: "Colour profile",
      group: "render",
      risk: LOW,
      value: icc.summary,
      warn: icc.wide
        ? {
            kind: "icc",
            text:
              "This is a wide-gamut profile (" + icc.name + "). Removing it makes viewers " +
              "treat the picture as plain sRGB, and the colours will look over-saturated.",
          }
        : null,
      note: icc.wide ? "" : "This looks like ordinary sRGB, which is what a viewer assumes anyway, so removing it changes very little.",
    }));
  }

  function iptcFields(records, out) {
    for (const r of records) {
      if (r.record !== 2) continue;
      const key = String(r.dataset).padStart(3, "0");
      const desc = IPTC_NAMES[r.dataset];
      out.push(makeField({
        id: "iptc:2:" + key,
        key: "iptc 2:" + key,
        label: desc ? desc[0] : "IPTC field 2:" + key,
        group: desc ? desc[1] : "other",
        risk: desc ? desc[2] : MED,
        value: r.text || "(blank)",
      }));
    }
  }

  function photoshopFields(resources, out) {
    for (const r of resources) {
      if (r.id === 0x0404) continue; // listed as its own IPTC fields instead
      const desc = PSD_NAMES[r.id];
      const hex = "0x" + r.id.toString(16).padStart(4, "0");
      out.push(makeField({
        id: "psd:" + hex,
        key: "photoshop " + hex,
        label: desc ? "Photoshop: " + desc[0] : "Photoshop resource " + hex,
        group: desc ? desc[1] : "other",
        risk: desc ? desc[2] : MED,
        value: (r.name ? r.name + " · " : "") + fileSize(r.data.length) +
          (looksLikeText(r.data) ? " · " + trimNul(LATIN1.decode(r.data.subarray(0, 120))) : ""),
      }));
    }
  }

  /* ── Reading a JPEG ────────────────────────────────────────────────────*/

  async function readJpeg(doc) {
    const parts = walkJpeg(doc.bytes);
    if (!parts) { doc.error = "This does not look like a readable JPEG."; return; }
    doc.parts = parts;

    const iccChunks = [];
    let comIndex = 0;

    for (const seg of parts.segments) {
      const m = seg.marker;
      const p = seg.payload;

      if (m === 0xe1 && sigAt(p, 0, "Exif\0\0")) {
        seg.role = "exif";
        const tiff = parseTiff(p.slice(6));
        if (tiff) {
          doc.tiff = tiff;
          doc.warnings.push(...tiff.warnings);
          tiffFields(tiff, doc.fields);
        } else {
          seg.role = "opaque";
          seg.id = "jpeg:app1:broken";
          doc.fields.push(makeField({
            id: seg.id, key: "jpeg app1", label: "EXIF block (unreadable)",
            group: "other", risk: MED, value: fileSize(p.length),
          }));
        }
        continue;
      }

      if (m === 0xe1 && (sigAt(p, 0, XMP_SIG) || sigAt(p, 0, XMP_EXT_SIG))) {
        seg.role = "xmp";
        if (sigAt(p, 0, XMP_SIG) && !doc.sawXmp) {
          doc.sawXmp = true;
          xmpField(UTF8.decode(p.subarray(XMP_SIG.length)), doc.fields);
        }
        continue;
      }

      if (m === 0xe2 && sigAt(p, 0, "ICC_PROFILE\0")) {
        seg.role = "icc";
        iccChunks.push(p.subarray(14));
        continue;
      }

      if (m === 0xe2 && sigAt(p, 0, "MPF\0")) {
        seg.role = "opaque";
        seg.id = "jpeg:mpf";
        doc.fields.push(makeField({
          id: seg.id, key: "jpeg mpf", label: "Multi-picture index",
          group: "other", risk: HIGH, value: fileSize(p.length),
          warn: {
            kind: "mpf",
            text:
              "This file carries a multi-picture index, which is how phones attach an HDR gain " +
              "map or a linked second frame. Those extra images sit past the end of this one and " +
              "the index points at them by position, so any rewrite breaks it. Keeping the index " +
              "without its images is no better. Expect to lose the gain map.",
          },
        }));
        continue;
      }

      if (m === 0xed && sigAt(p, 0, "Photoshop 3.0\0")) {
        seg.role = "psd";
        const resources = parsePhotoshop(p.subarray(14));
        doc.psd = resources;
        photoshopFields(resources, doc.fields);
        const iptc = resources.find((r) => r.id === 0x0404);
        if (iptc) {
          doc.iptc = parseIptc(iptc.data);
          iptcFields(doc.iptc, doc.fields);
        }
        continue;
      }

      // The Adobe colour-transform marker says how the channels are encoded.
      // Removing it turns some CMYK and YCCK JPEGs inside out.
      if (m === 0xee && sigAt(p, 0, "Adobe")) { seg.role = "structural"; continue; }

      if (m === 0xe0 && sigAt(p, 0, "JFIF\0")) {
        seg.role = "opaque";
        seg.id = "jfif";
        const unit = p[7];
        doc.fields.push(makeField({
          id: seg.id, key: "jfif header", label: "JFIF header", group: "render", risk: LOW,
          value: "density " + u16(p, 8, false) + "×" + u16(p, 10, false) +
            (unit === 1 ? " per inch" : unit === 2 ? " per cm" : ""),
        }));
        continue;
      }

      if (m === 0xfe) {
        seg.role = "opaque";
        seg.id = "jpeg:comment:" + comIndex++;
        doc.fields.push(makeField({
          id: seg.id, key: "jpeg comment", label: "Comment", group: "text", risk: HIGH,
          value: trimNul(LATIN1.decode(p)) || "(blank)",
        }));
        continue;
      }

      if (m >= 0xe0 && m <= 0xef) {
        seg.role = "opaque";
        seg.id = "jpeg:app" + (m - 0xe0);
        const label = JPEG_APP_NAMES[m] || "APP" + (m - 0xe0);
        doc.fields.push(makeField({
          id: seg.id, key: "jpeg " + label.toLowerCase(), label: label + " block",
          group: "other", risk: MED,
          value: fileSize(p.length) + " · " +
            (looksLikeText(p) ? trimNul(LATIN1.decode(p.subarray(0, 80))) : hexPreview(p)),
        }));
        continue;
      }

      seg.role = "structural";
    }

    if (iccChunks.length) iccField(concat(iccChunks), doc.fields);

    if (parts.trailer && parts.trailer.length > 2) {
      doc.fields.push(makeField({
        id: "jpeg:trailer", key: "jpeg trailer", label: "Data after the end of the image",
        group: "other", risk: HIGH, value: fileSize(parts.trailer.length),
        warn: {
          kind: "trailer",
          text:
            "There are " + fileSize(parts.trailer.length) + " past the end marker. This is where " +
            "phones hide the video half of a motion photo. Removing it makes this an ordinary still.",
        },
      }));
    }
  }

  /* ── Reading a PNG ─────────────────────────────────────────────────────*/

  async function readPng(doc) {
    const parts = walkPng(doc.bytes);
    if (!parts) { doc.error = "This does not look like a readable PNG."; return; }
    doc.parts = parts;

    const pending = [];
    for (const chunk of parts.chunks) {
      const type = chunk.type;
      if (PNG_CRITICAL.has(type) || PNG_STRUCTURAL.has(type)) { chunk.role = "structural"; continue; }

      if (type === "eXIf") {
        chunk.role = "exif";
        const tiff = parseTiff(chunk.data);
        if (tiff) {
          doc.tiff = tiff;
          doc.warnings.push(...tiff.warnings);
          tiffFields(tiff, doc.fields);
          continue;
        }
      }

      if (type === "iCCP") {
        chunk.role = "icc";
        const nul = chunk.data.indexOf(0);
        pending.push(
          inflate(chunk.data.subarray(nul + 2)).then((profile) => {
            iccField(profile || chunk.data.subarray(nul + 2), doc.fields);
          })
        );
        continue;
      }

      if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
        chunk.role = "text";
        pending.push(
          pngText(chunk).then((entry) => {
            chunk.id = "png:text:" + entry.keyword;
            const isXmp = entry.keyword === "XML:com.adobe.xmp";
            if (isXmp) {
              xmpField(entry.text, doc.fields);
              chunk.id = "xmp";
              return;
            }
            doc.fields.push(makeField({
              id: chunk.id,
              key: "png " + type + " " + entry.keyword,
              label: entry.keyword,
              group: /author|artist|copyright|owner/i.test(entry.keyword) ? "people"
                : /software|source/i.test(entry.keyword) ? "device"
                : /creation|date|time/i.test(entry.keyword) ? "dates" : "text",
              risk: /software|source/i.test(entry.keyword) ? MED : HIGH,
              value: entry.text || "(blank)",
            }));
          })
        );
        continue;
      }

      chunk.role = "aux";
      chunk.id = "png:chunk:" + type;
      const desc = PNG_CHUNK_NAMES[type];
      doc.fields.push(makeField({
        id: chunk.id,
        key: "png " + type,
        label: desc ? desc[0] : "PNG " + type + " chunk",
        group: desc ? desc[1] : "other",
        risk: desc ? desc[2] : MED,
        value: type === "tIME" && chunk.data.length >= 7
          ? u16(chunk.data, 0, false) + "-" + String(chunk.data[2]).padStart(2, "0") + "-" +
            String(chunk.data[3]).padStart(2, "0") + " " + String(chunk.data[4]).padStart(2, "0") +
            ":" + String(chunk.data[5]).padStart(2, "0") + ":" + String(chunk.data[6]).padStart(2, "0")
          : fileSize(chunk.data.length) + " · " + hexPreview(chunk.data),
      }));
    }

    await Promise.all(pending);
  }

  async function pngText(chunk) {
    const data = chunk.data;
    const nul = data.indexOf(0);
    const keyword = LATIN1.decode(data.subarray(0, nul < 0 ? 0 : nul));
    if (chunk.type === "tEXt") {
      return { keyword, text: trimNul(LATIN1.decode(data.subarray(nul + 1))) };
    }
    if (chunk.type === "zTXt") {
      const out = await inflate(data.subarray(nul + 2));
      return { keyword, text: out ? trimNul(LATIN1.decode(out)) : "(could not decompress)" };
    }
    // iTXt: keyword, compression flag, method, language, translated keyword, text
    const compressed = data[nul + 1] === 1;
    let at = nul + 3;
    at = data.indexOf(0, at) + 1;
    at = data.indexOf(0, at) + 1;
    if (at <= 0 || at > data.length) return { keyword, text: "(unreadable)" };
    const body = data.subarray(at);
    if (!compressed) return { keyword, text: trimNul(UTF8.decode(body)) };
    const out = await inflate(body);
    return { keyword, text: out ? trimNul(UTF8.decode(out)) : "(could not decompress)" };
  }

  /* ── Reading a WebP ────────────────────────────────────────────────────*/

  async function readWebp(doc) {
    const parts = walkWebp(doc.bytes);
    if (!parts) { doc.error = "This does not look like a readable WebP."; return; }
    doc.parts = parts;

    for (const chunk of parts.chunks) {
      if (WEBP_STRUCTURAL.has(chunk.fourcc)) { chunk.role = "structural"; continue; }
      if (chunk.fourcc === "EXIF") {
        chunk.role = "exif";
        // Some writers put the JPEG-style prefix in front of the TIFF here.
        const body = sigAt(chunk.data, 0, "Exif\0\0") ? chunk.data.subarray(6) : chunk.data;
        const tiff = parseTiff(body.slice());
        if (tiff) {
          doc.tiff = tiff;
          doc.tiffPrefixed = sigAt(chunk.data, 0, "Exif\0\0");
          doc.warnings.push(...tiff.warnings);
          tiffFields(tiff, doc.fields);
          continue;
        }
      }
      if (chunk.fourcc === "ICCP") { chunk.role = "icc"; iccField(chunk.data, doc.fields); continue; }
      if (chunk.fourcc === "XMP ") { chunk.role = "xmp"; xmpField(UTF8.decode(chunk.data), doc.fields); continue; }
      chunk.role = "aux";
      chunk.id = "webp:chunk:" + chunk.fourcc.trim();
      doc.fields.push(makeField({
        id: chunk.id, key: "webp " + chunk.fourcc.trim(),
        label: "WebP " + chunk.fourcc.trim() + " chunk", group: "other", risk: MED,
        value: fileSize(chunk.data.length) + " · " + hexPreview(chunk.data),
      }));
    }
  }

  /* ── Inspect ───────────────────────────────────────────────────────────*/

  async function inspectBytes(name, bytes) {
    const doc = {
      name, bytes, size: bytes.length, fields: [], warnings: [],
      error: null, kind: null, tiff: null, parts: null,
    };

    if (bytes[0] === 0xff && bytes[1] === 0xd8) doc.kind = "jpeg";
    else if (sigAt(bytes, 1, "PNG")) doc.kind = "png";
    else if (sigAt(bytes, 0, "RIFF") && sigAt(bytes, 8, "WEBP")) doc.kind = "webp";
    else {
      doc.error = "Only JPEG, PNG and WebP are supported. This file is neither.";
      return doc;
    }

    try {
      if (doc.kind === "jpeg") await readJpeg(doc);
      else if (doc.kind === "png") await readPng(doc);
      else await readWebp(doc);
    } catch (err) {
      doc.error = "This file could not be read: " + (err && err.message ? err.message : "unknown error");
      return doc;
    }

    // Group order first, then loudest first inside a group.
    const groupRank = new Map(GROUPS.map(([key], i) => [key, i]));
    const riskRank = { high: 0, med: 1, low: 2 };
    doc.fields.sort((a, b) =>
      (groupRank.get(a.group) ?? 99) - (groupRank.get(b.group) ?? 99) ||
      riskRank[a.risk] - riskRank[b.risk] ||
      a.label.localeCompare(b.label)
    );
    return doc;
  }

  async function inspect(file) {
    const doc = await inspectBytes(file.name, new Uint8Array(await file.arrayBuffer()));
    doc.file = file;
    return doc;
  }

  /* ── Rewrite ───────────────────────────────────────────────────────────*/

  function rewrite(doc, keep) {
    const exifBlock = doc.tiff ? serializeTiff(doc.tiff, keep) : null;

    if (doc.kind === "jpeg") {
      return writeJpeg(doc.parts, {
        keepTrailer: keep("jpeg:trailer"),
        segment(seg) {
          if (seg.role === "structural") return seg.payload;
          if (seg.role === "exif") {
            if (!exifBlock) return null;
            const out = new Uint8Array(6 + exifBlock.length);
            out.set([0x45, 0x78, 0x69, 0x66, 0, 0]); // "Exif\0\0"
            out.set(exifBlock, 6);
            return out;
          }
          if (seg.role === "xmp") return keep("xmp") ? seg.payload : null;
          if (seg.role === "icc") return keep("icc") ? seg.payload : null;
          if (seg.role === "psd") return rebuildPsdSegment(doc, keep);
          return keep(seg.id) ? seg.payload : null;
        },
      });
    }

    if (doc.kind === "png") {
      return writePng(doc.parts, {
        chunk(chunk) {
          if (chunk.role === "structural") return true;
          if (chunk.role === "exif") return exifBlock ? exifBlock : false;
          if (chunk.role === "icc") return keep("icc");
          return keep(chunk.id);
        },
      });
    }

    return writeWebp(doc.parts, {
      chunk(chunk) {
        if (chunk.role === "structural") return true;
        if (chunk.role === "exif") {
          if (!exifBlock) return false;
          chunk.data = doc.tiffPrefixed
            ? concat([new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]), exifBlock])
            : exifBlock;
          return true;
        }
        if (chunk.role === "icc") return keep("icc");
        if (chunk.role === "xmp") return keep("xmp");
        return keep(chunk.id);
      },
    });
  }

  function rebuildPsdSegment(doc, keep) {
    if (!doc.psd) return null;
    const resources = [];
    for (const r of doc.psd) {
      if (r.id === 0x0404) {
        if (!doc.iptc) continue;
        const kept = doc.iptc.filter((rec) => {
          if (rec.record !== 2) return true; // keep the charset marker and friends
          return keep("iptc:2:" + String(rec.dataset).padStart(3, "0"));
        });
        const onlyMeta = !kept.some((rec) => rec.record === 2);
        const body = onlyMeta ? null : writeIptc(kept);
        if (body) resources.push({ id: r.id, name: r.name, data: body });
        continue;
      }
      if (keep("psd:0x" + r.id.toString(16).padStart(4, "0"))) resources.push(r);
    }
    const body = writePhotoshop(resources);
    if (!body) return null;
    const head = new Uint8Array(14);
    for (let i = 0; i < 13; i++) head[i] = "Photoshop 3.0".charCodeAt(i);
    return concat([head, body]);
  }

  /* ── The round trip ────────────────────────────────────────────────────
     The whole tool rests on one claim, so the claim is checked rather than
     asserted: parse the file we just wrote with the same parser, and compare
     what survived against what was asked for. A mismatch stops the download.
     The reader gets an honest failure instead of a file that quietly kept
     something it said it had removed. */

  async function verify(doc, outBytes, keep) {
    const after = await inspectBytes(doc.name, outBytes);
    if (after.error) return ["The cleaned file could not be read back: " + after.error];

    const problems = [];
    const survived = new Set(after.fields.map((f) => f.id));
    for (const field of doc.fields) {
      const wanted = keep(field.id);
      if (!wanted && survived.has(field.id)) {
        problems.push(field.label + " was marked for removal but is still in the file.");
      }
      if (wanted && !survived.has(field.id)) {
        problems.push(field.label + " was marked to keep but did not survive the rewrite.");
      }
    }
    return problems.slice(0, 6);
  }

  /* ── Rules ─────────────────────────────────────────────────────────────
     A preset is a function of a field, and manual switches are overrides on
     top of it, keyed by field id. Keeping it in that order rather than baking
     a preset into a flat list of ids means a file dropped later gets the same
     treatment as the ones already loaded, without anything having to walk back
     over them. */

  const PRESETS = {
    all: () => false,
    safe: (f) => f.group === "render",
    location: (f) => f.group !== "location",
    none: () => true,
  };

  let preset = "all";
  const overrides = new Map();

  function decide(field) {
    if (!field.removable) return true;
    if (overrides.has(field.id)) return overrides.get(field.id);
    return PRESETS[preset](field);
  }

  function keeperFor(doc) {
    const byId = new Map(doc.fields.map((f) => [f.id, f]));
    return (id) => {
      const field = byId.get(id);
      return field ? decide(field) : false;
    };
  }

  /* ── State ─────────────────────────────────────────────────────────────*/

  const docs = [];
  let current = 0;

  const el = (id) => document.getElementById(id);
  const dropZone = el("drop");
  const fileInput = el("file");
  const toolbar = el("toolbar");
  const work = el("work");
  const railList = el("railList");
  const fieldTable = el("fieldTable");
  const capName = el("capName");
  const capMeta = el("capMeta");
  const warningBox = el("warnings");
  const paneNote = el("paneNote");
  const hint = el("hint");
  const say = el("say");

  const KIND_LABEL = { jpeg: "JPEG", png: "PNG", webp: "WebP" };

  function announce(text) { say.textContent = text; }

  function showHint(text) {
    hint.textContent = text || "";
    hint.hidden = !text;
  }

  function countsFor(doc) {
    let removed = 0;
    let high = 0;
    for (const field of doc.fields) {
      if (field.removable && !decide(field)) removed++;
      if (field.risk === HIGH && field.removable) high++;
    }
    return { removed, high, total: doc.fields.length };
  }

  /* ── Render: the rail ──────────────────────────────────────────────────*/

  function renderRail() {
    railList.textContent = "";
    docs.forEach((doc, index) => {
      const li = document.createElement("li");
      li.className = "slip" + (index === current ? " is-open" : "") + (doc.error ? " is-bad" : "");

      const pick = document.createElement("button");
      pick.type = "button";
      pick.className = "slip-pick";
      if (index === current) pick.setAttribute("aria-current", "true");

      const name = document.createElement("span");
      name.className = "slip-name";
      name.textContent = doc.name;

      const meta = document.createElement("span");
      meta.className = "slip-meta";
      if (doc.error) {
        meta.textContent = "unreadable";
      } else {
        const c = countsFor(doc);
        meta.textContent = KIND_LABEL[doc.kind] + " · " + fileSize(doc.size) + " · ";
        const marked = document.createElement("span");
        marked.className = c.high ? "marked" : "";
        marked.textContent = c.removed + " to go";
        meta.appendChild(marked);
      }

      pick.append(name, meta);
      pick.addEventListener("click", () => { current = index; render(); });
      li.appendChild(pick);

      if (!doc.error) {
        const get = document.createElement("button");
        get.type = "button";
        get.className = "slip-get";
        get.setAttribute("data-tip", "Download this file, cleaned");
        get.setAttribute("aria-label", "Download " + doc.name + ", cleaned");
        get.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="square" aria-hidden="true"><path d="M8 2.5v7.5M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11"></path></svg>';
        get.addEventListener("click", () => downloadOne(index, get));
        li.appendChild(get);
      }

      railList.appendChild(li);
    });
  }

  /* ── Render: the sheet ─────────────────────────────────────────────────*/

  function renderFields() {
    for (const body of Array.from(fieldTable.querySelectorAll("tbody"))) body.remove();
    const doc = docs[current];
    if (!doc) {
      // Nothing loaded. Clear the caption too, or "Clear all" leaves the last
      // file's name and size sitting in a panel that no longer describes it.
      capName.textContent = "";
      capMeta.textContent = "";
      paneNote.textContent = "";
      return;
    }

    capName.textContent = doc.name;

    if (doc.error) {
      capMeta.textContent = "unreadable";
      const body = document.createElement("tbody");
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 4;
      cell.textContent = doc.error;
      fieldTable.appendChild(body);
      paneNote.textContent = "";
      return;
    }

    const c = countsFor(doc);
    capMeta.textContent =
      KIND_LABEL[doc.kind] + " · " + fileSize(doc.size) + " · " +
      (c.total ? c.total + " fields · " + c.removed + " marked for removal" : "no metadata found");

    if (!c.total) {
      const body = document.createElement("tbody");
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 4;
      cell.textContent = "There is no metadata in this file. Nothing to remove.";
      fieldTable.appendChild(body);
      paneNote.textContent = "";
      return;
    }

    let rowId = 0;
    for (const [key, title, blurb] of GROUPS) {
      const fields = doc.fields.filter((f) => f.group === key);
      if (!fields.length) continue;

      const body = document.createElement("tbody");
      body.dataset.group = key;

      const headRow = body.insertRow();
      headRow.className = "grp-row";
      const headCell = headRow.insertCell();
      headCell.colSpan = 4;

      const head = document.createElement("div");
      head.className = "grp-head";

      const boxWrap = document.createElement("span");
      boxWrap.className = "grp-box";
      const boxLabel = document.createElement("label");
      boxLabel.className = "checkbox";
      const master = document.createElement("input");
      master.type = "checkbox";
      master.dataset.master = key;
      master.setAttribute("aria-label", "Keep every field under " + title);
      boxLabel.appendChild(master);
      boxWrap.appendChild(boxLabel);

      const titleEl = document.createElement("span");
      titleEl.className = "grp-title";
      titleEl.textContent = title;

      const count = document.createElement("span");
      count.className = "grp-count";

      const blurbEl = document.createElement("span");
      blurbEl.className = "grp-blurb";
      blurbEl.textContent = blurb;

      head.append(boxWrap, titleEl, count, blurbEl);
      headCell.appendChild(head);

      const switchable = fields.filter((f) => f.removable);
      const keptCount = switchable.filter(decide).length;
      count.textContent = switchable.length
        ? (switchable.length - keptCount) + " of " + switchable.length + " to go"
        : "always kept";
      master.checked = switchable.length > 0 && keptCount === switchable.length;
      master.indeterminate = keptCount > 0 && keptCount < switchable.length;
      master.disabled = !switchable.length;
      master.addEventListener("change", () => {
        for (const field of switchable) overrides.set(field.id, master.checked);
        render();
      });

      for (const field of fields) {
        const kept = decide(field);
        const row = body.insertRow();
        row.className = "fld" + (kept ? "" : " is-cut") + (field.removable ? "" : " is-fixed");
        row.dataset.id = field.id;

        const keepCell = row.insertCell();
        keepCell.className = "col-keep";
        const nameId = "fld-" + rowId++;

        if (field.removable) {
          const label = document.createElement("label");
          label.className = "checkbox";
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = kept;
          box.setAttribute("aria-labelledby", nameId);
          box.addEventListener("change", () => {
            overrides.set(field.id, box.checked);
            render();
          });
          label.appendChild(box);
          keepCell.appendChild(label);
        }

        const nameCell = document.createElement("th");
        nameCell.className = "fld-name";
        nameCell.scope = "row";
        nameCell.id = nameId;
        nameCell.append(field.label);
        const keyEl = document.createElement("span");
        keyEl.className = "fld-key";
        keyEl.textContent = field.key;
        nameCell.appendChild(keyEl);
        row.appendChild(nameCell);

        const valueCell = row.insertCell();
        valueCell.className = "col-value";
        const value = document.createElement("span");
        value.className = "val" + (field.blank ? " val-blank" : "");
        value.textContent = field.value || "(blank)";
        valueCell.appendChild(value);
        if (field.value.length > 150 || field.value.indexOf("\n") >= 0) {
          const more = document.createElement("button");
          more.type = "button";
          more.className = "val-more";
          more.textContent = "show all";
          more.addEventListener("click", () => {
            const open = value.classList.toggle("is-open");
            more.textContent = open ? "show less" : "show all";
          });
          valueCell.appendChild(more);
        }

        const noteCell = row.insertCell();
        noteCell.className = "col-note";
        if (field.risk === HIGH || field.risk === MED) {
          const mark = document.createElement("span");
          mark.className =
            "risk" + (field.risk === HIGH ? " is-high mk--citron" : "");
          mark.textContent = field.risk === HIGH ? "identifying" : "telling";
          if (field.note) mark.setAttribute("data-tip", field.note);
          noteCell.appendChild(mark);
        }

        body.appendChild(row);
      }

      fieldTable.appendChild(body);
    }

    paneNote.textContent =
      "Every value above is read straight out of the file. The picture itself is never decoded, " +
      "so a cleaned copy is the same image data, byte for byte, with the container rewritten around it.";
  }

  /* ── Render: warnings ──────────────────────────────────────────────────
     Only for fields actually on their way out, and each one carries the button
     that puts it back, so the sentence and the fix are the same object. */

  function renderWarnings() {
    warningBox.textContent = "";
    const doc = docs[current];
    if (!doc || doc.error) return;

    for (const field of doc.fields) {
      if (!field.warn || decide(field)) continue;
      const box = document.createElement("div");
      box.className = "warn";

      const text = document.createElement("p");
      text.className = "warn-text";
      const strong = document.createElement("strong");
      strong.textContent = field.label + ". ";
      text.append(strong, field.warn.text);
      text.style.margin = "0";

      const fix = document.createElement("button");
      fix.type = "button";
      fix.className = "btn-ghost warn-fix";
      fix.textContent = "Keep it";
      fix.addEventListener("click", () => { overrides.set(field.id, true); render(); });

      box.append(text, fix);
      warningBox.appendChild(box);
    }

    for (const warning of doc.warnings.slice(0, 3)) {
      const box = document.createElement("div");
      box.className = "warn";
      const text = document.createElement("p");
      text.className = "warn-text";
      text.style.margin = "0";
      text.textContent = warning;
      box.appendChild(text);
      warningBox.appendChild(box);
    }
  }

  function renderPresets() {
    for (const button of document.querySelectorAll("[data-preset]")) {
      const active = button.dataset.preset === preset && !overrides.size;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  function render() {
    renderPresets();
    renderRail();
    renderFields();
    renderWarnings();
  }

  /* ── Downloads ─────────────────────────────────────────────────────────*/

  function flash(button, message) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = message;
    clearTimeout(button.dataset.timer);
    button.dataset.timer = setTimeout(() => { button.textContent = button.dataset.label; }, 1600);
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function outputName(doc, index) {
    const dot = doc.name.lastIndexOf(".");
    const ext = dot > 0 ? doc.name.slice(dot) : "." + (doc.kind === "jpeg" ? "jpg" : doc.kind);
    if (el("rename").checked) return zipSafeName("image-" + (index + 1) + ext);
    const stem = dot > 0 ? doc.name.slice(0, dot) : doc.name;
    return zipSafeName(stem + "-cleaned" + ext);
  }

  async function produce(doc) {
    const keep = keeperFor(doc);
    const bytes = rewrite(doc, keep);
    const problems = await verify(doc, bytes, keep);
    if (problems.length) throw new Error(problems.join(" "));
    return bytes;
  }

  async function downloadOne(index, button) {
    const doc = docs[index];
    if (!doc || doc.error) return;
    try {
      showHint("");
      const bytes = await produce(doc);
      saveBlob(new Blob([bytes], { type: "image/" + doc.kind }), outputName(doc, index));
      if (button) flash(button, "Saved");
      announce("Saved " + outputName(doc, index) + ", " + fileSize(bytes.length) + ".");
    } catch (err) {
      showHint(
        "The cleaned copy of " + doc.name + " did not come back correct, so it has not been saved. " +
        err.message
      );
    }
  }

  async function downloadAll(button) {
    const usable = docs.filter((d) => !d.error);
    if (!usable.length) return;
    if (usable.length === 1) return downloadOne(docs.indexOf(usable[0]), button);

    try {
      showHint("");
      const entries = [];
      const seen = new Map();
      for (const doc of usable) {
        const bytes = await produce(doc);
        let name = outputName(doc, docs.indexOf(doc));
        // Two photos called IMG_1234.jpg is the ordinary case, not the exotic one.
        if (seen.has(name)) {
          const n = seen.get(name) + 1;
          seen.set(name, n);
          const dot = name.lastIndexOf(".");
          name = name.slice(0, dot) + " (" + n + ")" + name.slice(dot);
        } else {
          seen.set(name, 1);
        }
        entries.push({ name, bytes });
      }
      saveBlob(buildZip(entries), "cleaned-images.zip");
      if (button) flash(button, "Saved " + entries.length);
      announce("Saved a zip of " + entries.length + " cleaned files.");
    } catch (err) {
      showHint("One of the cleaned copies did not come back correct, so nothing has been saved. " + err.message);
    }
  }

  /* ── Loading ───────────────────────────────────────────────────────────*/

  async function addFiles(list) {
    const incoming = Array.from(list).filter((f) => f.size > 0);
    if (!incoming.length) return;
    if (incoming.length > 200) {
      showHint("That is more than 200 files. Only the first 200 were read.");
      incoming.length = 200;
    }

    document.body.style.cursor = "var(--pp-cursor-working)";
    for (const file of incoming) {
      try {
        docs.push(await inspect(file));
      } catch (err) {
        docs.push({ name: file.name, size: file.size, fields: [], warnings: [], error: "Could not be read." });
      }
    }
    document.body.style.cursor = "";

    current = Math.min(current, docs.length - 1);
    toolbar.hidden = false;
    work.hidden = false;
    dropZone.classList.add("is-compact");
    render();

    const readable = docs.filter((d) => !d.error);
    const high = readable.reduce((n, d) => n + countsFor(d).high, 0);
    announce(
      docs.length + " file" + (docs.length === 1 ? "" : "s") + " loaded, " +
      high + " identifying field" + (high === 1 ? "" : "s") + " found."
    );
  }

  fileInput.addEventListener("change", () => {
    // Copy the list out before clearing the input. A FileList is live, and
    // addFiles is asynchronous, so reading it across an await would be reading
    // something the next line just emptied.
    const chosen = Array.from(fileInput.files);
    fileInput.value = "";
    addFiles(chosen);
  });

  for (const type of ["dragenter", "dragover"]) {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.add("drag-over");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    dropZone.addEventListener(type, () => dropZone.classList.remove("drag-over"));
  }
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    if (event.dataTransfer && event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  });
  // Without this the browser navigates away from the page to display a file
  // that was aimed at the drop target and missed.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  for (const button of document.querySelectorAll("[data-preset]")) {
    button.addEventListener("click", () => {
      preset = button.dataset.preset;
      overrides.clear();
      render();
      announce("Preset " + button.textContent.trim() + " applied.");
    });
  }

  el("reset").addEventListener("click", () => {
    docs.length = 0;
    current = 0;
    overrides.clear();
    toolbar.hidden = true;
    work.hidden = true;
    dropZone.classList.remove("is-compact");
    showHint("");
    render();
  });

  el("rename").addEventListener("change", render);
  el("dlOne").addEventListener("click", (e) => downloadOne(current, e.currentTarget));
  el("dlAll").addEventListener("click", (e) => downloadAll(e.currentTarget));

  if (typeof DecompressionStream !== "function") {
    showHint(
      "This browser cannot decompress PNG text chunks, so some PNG metadata will be listed as " +
      "unreadable. JPEG and WebP are unaffected."
    );
  }

  renderPresets();
})();
