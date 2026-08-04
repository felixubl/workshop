/* Network Inspector.

   Four questions, kept strictly apart because they cost different things to
   answer:

     1. What does this page already know, having asked nobody?  Rendered on
        load. Nothing leaves the browser to produce it.
     2. What is the connection actually doing right now?  Resource Timing,
        live. Also free, also nobody asked.
     3. What does one lookup add?  A button, because it hands your address to a
        third party and that should be a decision rather than a side effect.
     4. Who else is on this network?  A button, and the weakest answer on the
        page. A browser cannot scan. See probe() for what it does instead.

   The whole tool is one long argument that (1) and (2) are much larger than
   people expect, which is why they are the parts that render without asking. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const DASH = '–';

  /* Who else can see a value. The three answers this tool ever gives, named
     once so a row cannot invent a fourth. */
  const WHO = {
    local: ['local', 'stays in your browser'],
    isp: ['network', 'your ISP and anyone operating this network'],
    site: ['any site', 'readable by every site you open, no permission needed'],
  };

  // ── Rendering ────────────────────────────────────────────────────────────

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* One row of a key/value sheet. `who` is a key of WHO, or null for a row
     that is a measurement rather than a disclosure. A value of null prints the
     dash and goes quiet, which is itself information: the browser declining to
     answer is worth seeing next to the ones it answers freely. */
  function row(tbody, key, value, who) {
    const tr = el('tr');
    tr.append(el('td', 'k', key));

    const empty = value == null || value === '';
    const td = el('td', empty ? 'v none' : 'v', empty ? `${DASH} not available` : String(value));
    tr.append(td);

    const w = el('td', 'w');
    if (who) {
      const span = el('span', `who who--${who}`);
      span.append(el('span', 'sq'));
      span.append(el('span', null, WHO[who][0]));
      span.setAttribute('data-tip', WHO[who][1]);
      w.append(span);
    }
    tr.append(w);
    tbody.append(tr);
    return tr;
  }

  /* Rows with nothing in them are dropped rather than printed as "not
     available". Which signals a browser refuses to answer varies by browser and
     by platform, so hardcoding a list of dead ones would be wrong somewhere
     else: Chrome has no connection.type on desktop, Firefox has no deviceMemory
     or Client Hints, Safari has no battery. Filtering on the value covers all
     of them and keeps the sheet to things that actually say something.

     Callers that want an absence stated out loud still call row() directly. */
  const fill = (tbody, rows) => {
    tbody.replaceChildren();
    for (const r of rows) {
      if (r[1] == null || r[1] === '') continue;
      row(tbody, r[0], r[1], r[2]);
    }
  };

  const bytes = (n) => {
    if (!n && n !== 0) return null;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
    if (n < 1024 * 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(1)} GB`;
  };
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const ms = (n) => (n == null ? null : `${n < 10 ? n.toFixed(1) : Math.round(n)} ms`);

  /* Some of these buttons carry an icon beside their label, so the busy state
     has to put the whole button back rather than overwrite its text and drop
     the SVG on the floor. */
  const idleMarkup = new WeakMap();

  function busy(btn, label) {
    if (!idleMarkup.has(btn)) idleMarkup.set(btn, btn.innerHTML);
    btn.classList.add('is-busy');
    btn.disabled = true;
    btn.textContent = label;
  }
  function done(btn) {
    btn.classList.remove('is-busy');
    btn.disabled = false;
    if (idleMarkup.has(btn)) btn.innerHTML = idleMarkup.get(btn);
  }

  /* Replaces a section's idle prompt with real content. Sections start as a
     .card.prompt saying nothing has been sent, and that card is the thing being
     answered, so it goes when the answer arrives. */
  function section(wrapId) {
    const wrap = $(wrapId);
    wrap.classList.remove('idle');
    wrap.replaceChildren();
    return wrap;
  }

  function sheet(wrap, cap, meta) {
    const s = el('div', 'sheet');
    const head = el('div', 'sheet-cap');
    head.append(el('code', null, cap));
    if (meta) head.append(el('code', 'meta', meta));
    s.append(head);
    const scroll = el('div', 'sheet-scroll');
    const table = el('table');
    const tbody = el('tbody');
    table.append(tbody);
    scroll.append(table);
    s.append(scroll);
    wrap.append(s);
    return tbody;
  }

  function note(wrap, text) {
    wrap.append(el('p', 'sheet-note', text));
  }

  // ── 1. The line, as the browser estimates it ─────────────────────────────

  /* navigator.connection is the browser's own guess, revised as you use the
     network. It is not a measurement and it rounds hard (downlink caps at 10
     and buckets to 0.05) precisely so it cannot be used to fingerprint a
     connection. The measured numbers that replace these come from measure(). */
  function renderLine() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const rows = [
      ['Online', navigator.onLine ? 'yes' : 'no, the browser thinks it is offline', 'local'],
    ];
    if (c) {
      rows.push(
        ['Connection class', c.effectiveType || null, 'site'],
        ['Physical type', c.type || null, 'site'],
        ['Estimated downlink', c.downlink != null ? `${c.downlink} Mbit/s` : null, 'site'],
        ['Estimated round trip', c.rtt != null ? `${c.rtt} ms` : null, 'site'],
        ['Data saver on', c.saveData ? 'yes' : 'no', 'site'],
      );
    } else {
      rows.push(['Connection API', null, 'site']);
    }
    fill($('tLine'), rows);
    if (c && !c._bound) {
      c._bound = true;
      c.addEventListener('change', renderLine);
    }
  }

  window.addEventListener('online', renderLine);
  window.addEventListener('offline', renderLine);

  // ── 2. Where you look like you are, with no lookup ───────────────────────

  /* The point of this panel: a site can place you roughly without touching the
     network, and a VPN does not change any of it. If the IP lookup later says
     Frankfurt and this says Europe/Vienna, that gap is the tell. */
  function renderPlace() {
    const dt = Intl.DateTimeFormat().resolvedOptions();
    const off = -new Date().getTimezoneOffset();
    const sign = off < 0 ? '-' : '+';
    const abs = Math.abs(off);
    const utc = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;

    // A timezone that changes across the year is a jurisdiction-level hint on
    // its own: most of the world does not observe DST.
    const jan = new Date(new Date().getFullYear(), 0, 1).getTimezoneOffset();
    const jul = new Date(new Date().getFullYear(), 6, 1).getTimezoneOffset();

    fill($('tPlace'), [
      ['Time zone', dt.timeZone, 'site'],
      ['Offset from UTC', utc, 'site'],
      ['Observes daylight saving', jan === jul ? 'no' : 'yes', 'site'],
      ['Locale', dt.locale, 'site'],
      ['Languages, in order', (navigator.languages || []).join(', ') || navigator.language, 'site'],
      ['Calendar and numerals', `${dt.calendar}, ${dt.numberingSystem}`, 'site'],
      ['Country your locale implies', regionOf(dt.locale), 'site'],
      ['Your clock, as this page reads it', new Date().toString(), 'site'],
    ]);
  }

  /* A bare language tag like "de" carries no country, but CLDR knows the most
     likely one, so "de" maximizes to de-Latn-DE. That inference is the reason a
     language header is a location hint and not just a display preference. */
  function regionOf(locale) {
    try {
      return new Intl.Locale(locale).maximize().region || null;
    } catch {
      return null;
    }
  }

  // ── 3. The machine ───────────────────────────────────────────────────────

  /* Every entry here is readable by any script on any page, with no prompt and
     no permission. Collected together because that is the honest way to show
     it: the individual facts are dull and the combination is an identifier. */
  async function renderMachine() {
    const rows = [];
    const nav = navigator;

    rows.push(['User agent', nav.userAgent, 'site']);

    // Client Hints are the replacement for the UA string, and the high-entropy
    // set is handed over on request with no user-visible step.
    if (nav.userAgentData) {
      try {
        const h = await nav.userAgentData.getHighEntropyValues([
          'architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion', 'fullVersionList',
        ]);
        rows.push(
          ['Platform', `${h.platform || nav.userAgentData.platform} ${h.platformVersion || ''}`.trim(), 'site'],
          ['Architecture', [h.architecture, h.bitness && `${h.bitness}-bit`].filter(Boolean).join(' ') || null, 'site'],
          ['Browser build', h.uaFullVersion || null, 'site'],
          ['Device model', h.model || null, 'site'],
          ['Mobile', nav.userAgentData.mobile ? 'yes' : 'no', 'site'],
        );
      } catch {
        rows.push(['Client Hints', 'present, but the high-entropy set was refused', 'site']);
      }
    } else {
      rows.push(['Platform', nav.platform || null, 'site']);
    }

    rows.push(
      ['CPU cores', nav.hardwareConcurrency || null, 'site'],
      ['Memory, as reported', nav.deviceMemory ? `${nav.deviceMemory} GB or more` : null, 'site'],
      ['Screen', `${screen.width} x ${screen.height}, ${screen.colorDepth}-bit`, 'site'],
      ['Available screen', `${screen.availWidth} x ${screen.availHeight}`, 'site'],
      ['Window', `${innerWidth} x ${innerHeight}`, 'site'],
      ['Pixel ratio', devicePixelRatio, 'site'],
      ['Touch points', nav.maxTouchPoints, 'site'],
      ['Graphics', gpu(), 'site'],
      ['Graphics limits', glDetail(), 'site'],
      ['Video it can decode', codecs(), 'site'],
      ['Keyboard layout', await keyboardLayout(), 'site'],
      ['Cameras and microphones', await mediaDevices(), 'site'],
      ['Speech voices installed', await voices(), 'site'],
      ['Permissions already decided', await permissions(), 'site'],
      ['JavaScript heap ceiling', performance.memory
        ? `${Math.round(performance.memory.jsHeapSizeLimit / 1048576)} MB` : null, 'site'],
      ['Built-in PDF viewer', nav.pdfViewerEnabled == null ? null
        : (nav.pdfViewerEnabled ? 'yes' : 'no'), 'site'],
      /* Where you came from. Not a property of the machine, but it belongs with
         the things handed over without being asked for, and people are
         consistently surprised a site is told which page sent them. */
      ['The page that sent you here', document.referrer || 'opened directly, no referrer', 'site'],
      ['Cookies enabled', nav.cookieEnabled ? 'yes' : 'no', 'site'],
      ['Do Not Track', nav.doNotTrack === '1' ? 'on, and almost universally ignored' : 'not set', 'site'],
      ['Global Privacy Control', nav.globalPrivacyControl ? 'on' : 'not set', 'site'],
      ['Colour scheme preferred', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', 'site'],
      ['Reduced motion preferred', matchMedia('(prefers-reduced-motion: reduce)').matches ? 'yes' : 'no', 'site'],
      ['Canvas signature', hash(canvasPrint()), 'site'],
      ['Audio signature', hash(String(await audioPrint())), 'site'],
      ['Fonts detected', fontList(), 'site'],
    );

    if (nav.storage && nav.storage.estimate) {
      try {
        const e = await nav.storage.estimate();
        rows.push(['Storage quota for this site', bytes(e.quota), 'local']);
      } catch { /* Firefox in private mode rejects this */ }
    }
    if (nav.getBattery) {
      try {
        const b = await nav.getBattery();
        rows.push(['Battery', `${Math.round(b.level * 100)}%, ${b.charging ? 'charging' : 'on battery'}`, 'site']);
      } catch { /* removed in some browsers, on purpose */ }
    }

    fill($('tMachine'), rows);

    const signals = rows.map((r) => `${r[0]}=${r[1]}`).join('|');
    $('fpMeta').textContent = `signature ${hash(signals)}`;
  }

  /* Permission state is readable without asking for anything. A site can tell,
     silently and on load, whether you have already granted it a camera or
     turned notifications down, which is a different thing from being able to
     use them. Querying never prompts. */
  async function permissions() {
    if (!navigator.permissions || !navigator.permissions.query) return null;
    const names = ['geolocation', 'notifications', 'camera', 'microphone',
      'clipboard-read', 'midi', 'persistent-storage'];
    const out = [];
    for (const name of names) {
      try {
        const s = await navigator.permissions.query({ name });
        if (s.state !== 'prompt') out.push(`${name} ${s.state}`);
      } catch { /* the browser does not know this permission */ }
    }
    return out.length ? out.join(', ') : 'nothing granted or denied yet';
  }

  /* How many cameras and microphones you have, with no permission and no
     prompt. The labels stay hidden until you grant access, but the count does
     not, and the count alone separates a laptop from a desktop from a
     conference room. */
  async function mediaDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return null;
    try {
      const d = await navigator.mediaDevices.enumerateDevices();
      const n = (kind) => d.filter((x) => x.kind === kind).length;
      const named = d.filter((x) => x.label).length;
      if (!d.length) return null;
      return [count(n('videoinput'), 'camera', 'cameras'),
        count(n('audioinput'), 'microphone', 'microphones'),
        count(n('audiooutput'), 'output', 'outputs')].join(', ')
        + (named ? ', and their names, because access was granted before' : ', names hidden');
    } catch {
      return null;
    }
  }

  /* Installed speech voices leak the operating system and every language pack
     on it. getVoices is empty until the list loads, so this waits for it. */
  function voices() {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) return resolve(null);
      const read = () => {
        const v = speechSynthesis.getVoices();
        if (!v.length) return null;
        const langs = [...new Set(v.map((x) => x.lang))];
        return `${v.length} installed, covering ${langs.length} languages`;
      };
      const first = read();
      if (first) return resolve(first);
      const t = setTimeout(() => resolve(read()), 800);
      speechSynthesis.addEventListener('voiceschanged', () => {
        clearTimeout(t);
        resolve(read());
      }, { once: true });
    });
  }

  /* Which video codecs decode is a hardware and licensing fingerprint. HEVC in
     particular is close to a tell for Apple hardware, because almost nobody
     else ships the decoder to the browser. */
  function codecs() {
    try {
      const v = document.createElement('video');
      const list = [
        ['H.264', 'video/mp4; codecs="avc1.42E01E"'],
        ['HEVC', 'video/mp4; codecs="hvc1"'],
        ['AV1', 'video/mp4; codecs="av01.0.00M.08"'],
        ['VP9', 'video/webm; codecs="vp9"'],
        ['Ogg Theora', 'video/ogg; codecs="theora"'],
      ];
      const ok = list.filter(([, type]) => v.canPlayType(type)).map(([name]) => name);
      return ok.length ? ok.join(', ') : null;
    } catch {
      return null;
    }
  }

  /* The physical keyboard layout, which is a strong regional hint and one
     almost nobody knows is readable. A German keyboard reads QWERTZ here. */
  async function keyboardLayout() {
    if (!navigator.keyboard || !navigator.keyboard.getLayoutMap) return null;
    try {
      const map = await navigator.keyboard.getLayoutMap();
      const top = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY']
        .map((k) => (map.get(k) || '?').toUpperCase()).join('');
      return `${top}, read straight off your physical keys`;
    } catch {
      return null;
    }
  }

  function glDetail() {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return null;
      const ext = gl.getSupportedExtensions() || [];
      return `${gl.getParameter(gl.MAX_TEXTURE_SIZE)}px max texture, ${ext.length} extensions`;
    } catch {
      return null;
    }
  }

  function gpu() {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return null;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (!dbg) return gl.getParameter(gl.RENDERER);
      return `${gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)}, ${gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)}`;
    } catch {
      return null;
    }
  }

  /* The classic canvas fingerprint. The same string drawn on two machines
     differs in antialiasing at the pixel level, so the encoded image is a
     stable id for a GPU and font stack. Reproduced here to be shown, not used. */
  function canvasPrint() {
    try {
      const c = document.createElement('canvas');
      c.width = 260;
      c.height = 60;
      const x = c.getContext('2d');
      x.textBaseline = 'top';
      x.font = "16px 'Arial'";
      x.fillStyle = '#f60';
      x.fillRect(10, 10, 80, 24);
      x.fillStyle = '#069';
      x.fillText('Network Inspector', 12, 14);
      x.fillStyle = 'rgba(102, 200, 0, 0.7)';
      x.fillText('Network Inspector', 14, 18);
      return c.toDataURL();
    } catch {
      return 'unavailable';
    }
  }

  /* Same idea through the audio stack: render a fixed oscillator through a
     compressor offline and sum the result. The floating point differs by
     platform and build. */
  function audioPrint() {
    return new Promise((resolve) => {
      try {
        const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!Ctx) return resolve('unavailable');
        const ctx = new Ctx(1, 44100, 44100);
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = 10000;
        const comp = ctx.createDynamicsCompressor();
        osc.connect(comp);
        comp.connect(ctx.destination);
        osc.start(0);
        ctx.startRendering().then((buf) => {
          const d = buf.getChannelData(0);
          let sum = 0;
          for (let i = 4500; i < 5000; i++) sum += Math.abs(d[i]);
          resolve(sum.toFixed(8));
        }).catch(() => resolve('unavailable'));
      } catch {
        resolve('unavailable');
      }
    });
  }

  /* Which fonts you have installed is a list nobody agreed to publish. Detected
     the old way: set a string in the candidate font with a known fallback
     behind it, and see whether the measured width moved. */
  const FONT_CANDIDATES = [
    'Arial', 'Helvetica Neue', 'Times New Roman', 'Georgia', 'Courier New', 'Verdana',
    'Tahoma', 'Trebuchet MS', 'Palatino', 'Garamond', 'Comic Sans MS', 'Impact',
    'Segoe UI', 'Calibri', 'Cambria', 'Consolas', 'Menlo', 'Monaco', 'SF Pro Text',
    'Roboto', 'Ubuntu', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans', 'Optima',
    'Futura', 'Gill Sans', 'Baskerville', 'Didot', 'American Typewriter',
  ];

  function fontList() {
    try {
      const c = document.createElement('canvas').getContext('2d');
      const probe = 'mmmmmmmmmmlli WMwm 0123';
      const base = {};
      for (const b of ['monospace', 'serif', 'sans-serif']) {
        c.font = `72px ${b}`;
        base[b] = c.measureText(probe).width;
      }
      const found = FONT_CANDIDATES.filter((f) =>
        ['monospace', 'serif', 'sans-serif'].some((b) => {
          c.font = `72px '${f}', ${b}`;
          return c.measureText(probe).width !== base[b];
        }));
      return `${found.length} of ${FONT_CANDIDATES.length} tested: ${found.join(', ') || 'none'}`;
    } catch {
      return null;
    }
  }

  /* FNV-1a, run twice with different offsets to get eight hex characters. Not a
     cryptographic hash and does not need to be: it exists to show that these
     signals collapse to a short stable string. */
  function hash(str) {
    const one = (seed) => {
      let h = seed;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h;
    };
    return (one(2166136261) >>> 0).toString(16).padStart(8, '0').slice(0, 8);
  }

  // ── 4. Live traffic, from Resource Timing ────────────────────────────────

  const traffic = [];

  function trafficRow(e) {
    const tr = el('tr');
    const name = e.name.replace(location.origin, '').replace(/^https?:\/\//, '');
    tr.append(el('td', null, name.length > 62 ? `${name.slice(0, 60)}...` : name));

    /* A cross-origin server that does not send Timing-Allow-Origin gets its
       phase timings zeroed by the browser. Worth showing as dashes rather than
       as zeros, because "we are not allowed to tell you" and "it took no time"
       are opposite facts. */
    const opaque = e.domainLookupEnd === 0 && e.connectEnd === 0 && e.responseStart === 0;
    const cell = (v) => {
      const td = el('td', v == null ? 'blank' : null, v == null ? DASH : v);
      return td;
    };

    tr.append(cell(e.nextHopProtocol || (opaque ? null : 'unknown')));
    if (opaque) {
      for (let i = 0; i < 4; i++) tr.append(cell(null));
    } else {
      const tls = e.secureConnectionStart ? e.connectEnd - e.secureConnectionStart : null;
      tr.append(cell(ms(e.domainLookupEnd - e.domainLookupStart)));
      tr.append(cell(ms(e.connectEnd - e.connectStart)));
      tr.append(cell(tls == null ? null : ms(tls)));
      tr.append(cell(ms(e.responseStart - e.requestStart)));
    }
    tr.append(cell(ms(e.duration)));

    // transferSize 0 with a decoded body is a cache hit, which is a different
    // thing from an opaque response and reads better said than shown as a zero.
    let size;
    if (e.transferSize > 0) size = bytes(e.transferSize);
    else if (e.decodedBodySize > 0) size = 'cached';
    else size = null;
    tr.append(cell(size));

    return tr;
  }

  /* The speed test pulls the same file a few thousand times, and every one of
     those is a resource entry. Left in, the tool's own instrumentation buries
     the page's real traffic under its noise and the counter reads in the
     thousands, which is a measurement artefact rather than anything about your
     connection. They carry a marker in the query string precisely so this can
     drop them.

     The sweep's probes are the same kind of noise, and they are spotted by
     their target rather than a marker: nothing this page legitimately loads
     lives at a literal private address, so anything that does is the sweep. */
  const PRIVATE_URL = /^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/;
  const isOwnNoise = (name) =>
    name.includes('cachebust=') || name.includes('ping=') || PRIVATE_URL.test(name);

  function addEntries(entries) {
    const tbody = $('tTraffic');
    for (const e of entries) {
      if (isOwnNoise(e.name)) continue;
      traffic.push(e);
      tbody.append(trafficRow(e));
    }
    // Newest at the bottom is right for a log, but the sheet must not grow
    // without limit on a page left open.
    while (tbody.children.length > 200) tbody.removeChild(tbody.firstChild);
    $('trafficCount').textContent = traffic.length;
  }

  function watchTraffic() {
    if (!('PerformanceObserver' in window)) {
      const tr = el('tr');
      const td = el('td', 'blank', 'Resource Timing is not available in this browser.');
      td.colSpan = 8;
      tr.append(td);
      $('tTraffic').append(tr);
      return;
    }
    addEntries(performance.getEntriesByType('resource'));
    new PerformanceObserver((list) => addEntries(list.getEntries())).observe({ type: 'resource', buffered: false });
  }

  $('trafficClear').addEventListener('click', () => {
    traffic.length = 0;
    $('tTraffic').replaceChildren();
    $('trafficCount').textContent = '0';
    performance.clearResourceTimings();
  });

  // ── 5. Measuring the line, against this site's own origin ────────────────

  /* Deliberately same-origin. Pulling a file this page already serves tells no
     third party anything it did not learn when the page loaded, so this is the
     one "makes requests" button that is safe to press without a warning. The
     cost is that it measures the path to one server in one place rather than
     your connection in the abstract. Said plainly in the note. */
  const BIG = '../assets/fonts/HeptaSlab.ttf';
  const TINY = '../assets/favicon.svg';

  async function measure() {
    const btn = $('measure');
    busy(btn, 'Measuring');
    const wrap = section('lineWrap');

    let downMbit = null, bytesPulled = 0, seconds = 0;
    try {
      const started = performance.now();
      const deadline = started + 3500;
      const streams = 6;
      const pull = async () => {
        while (performance.now() < deadline) {
          const url = `${BIG}?cachebust=${Math.random()}`;
          const res = await fetch(url, { cache: 'no-store' });
          const buf = await res.arrayBuffer();
          const entry = performance.getEntriesByName(new URL(url, location.href).href).pop();
          bytesPulled += (entry && entry.transferSize) || buf.byteLength;
        }
      };
      await Promise.all(Array.from({ length: streams }, pull));
      seconds = (performance.now() - started) / 1000;
      downMbit = (bytesPulled * 8) / seconds / 1e6;
    } catch {
      downMbit = null;
    }

    // Latency: the smallest same-origin file, one at a time, so the readings do
    // not queue behind each other. Min is the honest floor, jitter is the part
    // that decides whether a call sounds bad.
    const samples = [];
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      try {
        await fetch(`${TINY}?ping=${i}-${Math.random()}`, { cache: 'no-store' });
        samples.push(performance.now() - t0);
      } catch { /* a failed ping is not a sample */ }
    }
    /* Your clock against the server's, from the Date header every response
       already carries. The header has one-second resolution, so this can only
       ever say "right" or "wrong by this many seconds", which is exactly the
       interesting distinction: a clock off by minutes breaks TLS certificate
       checks and is worth knowing about. */
    let skew = null;
    try {
      const t0 = Date.now();
      const res = await fetch(`${TINY}?clock=${Math.random()}`, { cache: 'no-store' });
      const t1 = Date.now();
      const served = res.headers.get('date');
      if (served) skew = ((t0 + t1) / 2) - Date.parse(served);
    } catch { /* no Date header, or the request failed */ }

    samples.sort((a, b) => a - b);
    const median = samples.length ? samples[Math.floor(samples.length / 2)] : null;
    const min = samples.length ? samples[0] : null;
    let jitter = null;
    if (samples.length > 2) {
      let d = 0;
      for (let i = 1; i < samples.length; i++) d += Math.abs(samples[i] - samples[i - 1]);
      jitter = d / (samples.length - 1);
    }

    const s = el('div', 'sheet');
    const cap = el('div', 'sheet-cap');
    cap.append(el('code', null, 'Measured'));
    cap.append(el('code', 'meta', `${bytes(bytesPulled)} pulled over ${seconds.toFixed(1)}s`));
    s.append(cap);
    const dl = el('div', 'readings');
    const reading = (label, value, sub) => {
      const d = el('div', 'reading');
      d.append(el('dt', null, label));
      const dd = el('dd', null, value);
      if (sub) dd.append(el('small', null, ` ${sub}`));
      d.append(dd);
      dl.append(d);
    };
    reading('Download', downMbit ? downMbit.toFixed(1) : DASH, 'Mbit/s');
    reading('Latency, best', min ? Math.round(min) : DASH, 'ms');
    reading('Latency, median', median ? Math.round(median) : DASH, 'ms');
    reading('Jitter', jitter ? jitter.toFixed(1) : DASH, 'ms');
    if (skew != null) {
      reading('Clock offset', Math.abs(skew) < 1500 ? 'right' : `${(skew / 1000).toFixed(0)}`,
        Math.abs(skew) < 1500 ? 'within a second' : 's ahead of the server');
    }
    s.append(dl);
    wrap.append(s);

    note(wrap, 'The path between you and this one server, not a rating of your connection. No upload '
      + 'figure: measuring it needs a server that accepts a large POST, and this site has none.');

    done(btn);
  }

  $('measure').addEventListener('click', measure);

  // ── 6. The lookup: what a third party makes of your address ──────────────

  async function lookup() {
    const btn = $('lookup');
    busy(btn, 'Looking up');
    const wrap = section('lookupWrap');

    const [infoRes, v4Res] = await Promise.allSettled([
      fetch('https://ipwho.is/').then((r) => r.json()),
      fetch('https://api.ipify.org?format=json').then((r) => r.json()),
    ]);

    if (infoRes.status !== 'fulfilled' || !infoRes.value || infoRes.value.success === false) {
      wrap.append(el('p', 'hint', 'The lookup did not come back. That is usually an ad blocker, a '
        + 'privacy extension, or the service being rate limited. Nothing about your connection '
        + 'is broken.'));
      done(btn);
      return;
    }

    const d = infoRes.value;
    const v4 = v4Res.status === 'fulfilled' ? v4Res.value.ip : null;
    const conn = d.connection || {};
    const tz = d.timezone || {};

    const tb = sheet(wrap, 'Handed over by one request', 'source: ipwho.is');
    const rows = [
      ['Address it saw', d.ip, 'isp'],
      ['Address family', d.type, 'isp'],
    ];
    /* Showing both stacks matters: people who assume they have one address
       often have two, and blocking or rotating one leaves the other. */
    if (v4 && v4 !== d.ip) rows.push(['Your IPv4, separately', `${v4} (you are dual stack)`, 'isp']);
    rows.push(
      ['Internet provider', conn.isp, 'isp'],
      ['Network operator', conn.org, 'isp'],
      ['Autonomous system', conn.asn ? `AS${conn.asn}` : null, 'isp'],
      ['Their domain', conn.domain, 'isp'],
      ['Country', d.country ? `${d.country} (${d.country_code})` : null, 'isp'],
      ['Region', d.region, 'isp'],
      ['City', d.city, 'isp'],
      ['Postal code', d.postal, 'isp'],
      ['Coordinates', d.latitude != null ? `${d.latitude}, ${d.longitude}` : null, 'isp'],
      ['Time zone they infer', tz.id, 'isp'],
      ['In the EU', d.is_eu ? 'yes' : 'no', 'isp'],
    );
    fill(tb, rows);

    /* The verdict. Two independent signals the browser gives away for free,
       checked against what the address claims. A VPN moves the address and
       leaves the browser alone, so a disagreement is the shape of a VPN and an
       agreement is the shape of none. Neither is proof, and the wording says
       so rather than printing a badge. */
    const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const region = (() => {
      try { return new Intl.Locale(navigator.language).maximize().region; } catch { return null; }
    })();
    const tzAgrees = tz.id && mine && tz.id === mine;
    const ctryAgrees = region && d.country_code && region === d.country_code;

    const vb = sheet(wrap, 'Cross-check', 'browser against address');
    fill(vb, [
      ['Time zone, from your browser', mine, 'site'],
      ['Time zone, from your address', tz.id, 'isp'],
      ['Time zones agree', tz.id && mine ? (tzAgrees ? 'yes' : 'no') : null, null],
      ['Country, from your language', region, 'site'],
      ['Country, from your address', d.country_code, 'isp'],
    ]);

    /* The verdict rests on the time zone alone, and only the time zone.

       The language-implied country is in the table because it is a real
       disclosure, but it is worthless as VPN evidence: half the world browses
       in en-US from everywhere, so it disagrees with the address constantly on
       connections that have no VPN anywhere near them. An early version scored
       the two signals together and confidently told a machine sitting in Vienna,
       on an Austrian address, in Europe/Vienna, that it looked like a VPN. */
    if (tzAgrees) {
      note(wrap, 'Clock and address agree, which is what no VPN looks like. A VPN that moves your time '
        + 'zone too would look the same, so this is consistency, not proof.');
    } else if (tz.id && mine) {
      note(wrap, 'Clock and address disagree. That gap is what a VPN produces, and also what travelling '
        + 'with an unchanged clock produces. A hint, not a verdict.');
    }

    if (region && !ctryAgrees) {
      note(wrap, `Your language implies ${region} while your address says ${d.country_code}. Weak on its `
        + 'own, since English is the default everywhere, but one more field you never chose to publish.');
    }

    note(wrap, 'All of it from one request that carried nothing but the fact you made it. The postal '
      + 'code is real.');

    done(btn);
  }

  $('lookup').addEventListener('click', lookup);

  // ── 7. WebRTC ────────────────────────────────────────────────────────────

  /* Opening a peer connection makes the browser enumerate the addresses it
     could be reached on and, via STUN, the address the outside world sees. A
     page reads them out of the ICE candidates without a permission prompt.

     Chrome and Safari now hand out a random .local hostname instead of the real
     private address unless the page already has camera or microphone access,
     which closed most of this leak. The tool reports which one you got, because
     "the leak is closed on your browser" is the useful answer. */
  function rtcProbe() {
    const btn = $('webrtc');
    busy(btn, 'Probing');
    const wrap = section('rtcWrap');
    const found = new Map();

    if (!window.RTCPeerConnection) {
      wrap.append(el('p', 'hint', 'WebRTC is not available in this browser, so this leak does not apply to you.'));
      done(btn);
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.createDataChannel('probe');

    /* Two things race to end this: the null candidate that means gathering is
       complete, and the timeout for the case where it never arrives. Whichever
       lands first wins, and the other must not redraw the panel underneath it. */
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      try { pc.close(); } catch { /* already closed */ }
      renderRtc(wrap, [...found.values()]);
      done(btn);
    };

    pc.addEventListener('icecandidate', (ev) => {
      if (!ev.candidate) return finish();
      const c = ev.candidate;
      const key = `${c.address}:${c.port}:${c.type}`;
      if (c.address) found.set(key, c);
    });

    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(finish);
    setTimeout(finish, 5000);
  }

  const RTC_KIND = {
    host: 'an address on your own machine',
    srflx: 'the address the internet sees, as told by a STUN server',
    prflx: 'an address discovered mid-connection',
    relay: 'a relay, your real address stayed hidden',
  };

  let rtcLocalV4 = null;

  function renderRtc(wrap, cands) {
    if (!cands.length) {
      wrap.replaceChildren();
      wrap.append(el('p', 'hint', 'No candidates came back, which usually means WebRTC is disabled or '
        + 'blocked by an extension. That is the leak being closed.'));
      return;
    }
    const tb = sheet(wrap, 'Addresses your browser offered up', `${cands.length} candidates`);
    let mdns = 0;
    for (const c of cands) {
      const isMdns = /\.local$/i.test(c.address || '');
      if (isMdns) mdns++;
      if (!isMdns && c.type === 'host' && /^\d+\.\d+\.\d+\.\d+$/.test(c.address)) rtcLocalV4 = c.address;
      row(tb, RTC_KIND[c.type] || c.type,
        `${c.address}  ${c.protocol || ''}`.trim(),
        c.type === 'host' ? 'local' : 'isp');
    }
    if (mdns) {
      note(wrap, `${mdns} came back as a random .local name instead of a real private address. That is `
        + 'your browser closing the oldest WebRTC leak.');
    } else {
      note(wrap, 'Your private address came back in full. Any page can read it the same way, VPN or '
        + 'not, and it maps out your network.');
    }
  }

  $('webrtc').addEventListener('click', rtcProbe);

  // ── 8. Looking for other devices ─────────────────────────────────────────

  /* What this is not: a scan. A browser cannot open a raw socket, read ARP, or
     see a reply it did not ask for.

     What it is: a connection attempt to each address, timed. An address with
     something listening refuses or resets almost immediately, in single-digit
     to low tens of milliseconds. An address with nothing at it has to be ARPed
     for and never answers, so the attempt hangs until the timeout. The gap
     between those two is the entire signal, and it is genuinely noisy.

     Two things make it worse, both stated in the output rather than hidden:
     served over HTTPS, a request to a plain http:// address inside the LAN is
     blocked as mixed content before it is even attempted, so the sweep has to
     use https:// and gets a TLS failure it must time instead. And Chrome's
     Private Network Access work is progressively blocking exactly this. */
  const GATEWAYS = [
    '192.168.0.1', '192.168.1.1', '192.168.2.1', '192.168.8.1', '192.168.10.1',
    '192.168.100.1', '192.168.178.1', '192.168.1.254', '10.0.0.1', '10.0.1.1',
    '10.1.1.1', '10.0.0.138', '172.16.0.1', '172.20.10.1',
  ];
  const PROBE_TIMEOUT = 1500;
  const CONCURRENCY = 32;

  function probe(ip, scheme) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const ctrl = new AbortController();
      let settled = false;
      const timer = setTimeout(() => { ctrl.abort(); }, PROBE_TIMEOUT);
      const finish = (state) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ip, state, took: performance.now() - t0 });
      };
      fetch(`${scheme}//${ip}/`, { mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' })
        .then(() => finish('answered'))
        .catch(() => {
          const took = performance.now() - t0;
          // Aborted at the timeout means nothing was there to say no. Anything
          // that failed well before the timeout said no, which means it exists.
          finish(ctrl.signal.aborted && took >= PROBE_TIMEOUT * 0.9 ? 'silent' : 'answered');
        });
    });
  }

  async function pool(items, worker, onProgress) {
    const out = [];
    let i = 0;
    let finished = 0;
    const run = async () => {
      while (i < items.length) {
        const mine = items[i++];
        out.push(await worker(mine));
        onProgress(++finished, items.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
    return out;
  }

  /* ── Ports on your own machine ──────────────────────────────────────────

     The same timing trick as the network sweep, but pointed at 127.0.0.1, where
     it works far better: loopback has no ARP and no packet loss, so a closed
     port refuses in about a millisecond while an open one takes visibly longer,
     and the two populations barely overlap.

     This is the technique eBay was found running against its own visitors, and
     it is the strongest demonstration on the page precisely because it is the
     one that returns real results. The port list is chosen to be legible: each
     one is named after the software that normally sits on it, so the output
     reads as "you are running Postgres" rather than as a column of numbers. */
  const PORTS = [
    [22, 'SSH'], [80, 'a web server'], [443, 'a web server over TLS'],
    [445, 'Windows file sharing'], [631, 'CUPS printing'], [1080, 'a SOCKS proxy'],
    [1313, 'Hugo'], [1433, 'SQL Server'], [3000, 'a Node or Rails dev server'],
    [3001, 'a second Node dev server'], [3128, 'a Squid proxy'], [3306, 'MySQL or MariaDB'],
    [3389, 'Remote Desktop'], [4200, 'an Angular dev server'], [4321, 'Astro'],
    [5000, 'Flask, or AirPlay on a Mac'], [5173, 'a Vite dev server'], [5432, 'PostgreSQL'],
    [5900, 'VNC screen sharing'], [5984, 'CouchDB'], [6006, 'TensorBoard'], [6379, 'Redis'],
    [7000, 'AirPlay'], [8000, 'a dev server'], [8080, 'a web server or proxy'],
    [8086, 'InfluxDB'], [8443, 'a web server over TLS'], [8888, 'Jupyter'],
    [9000, 'PHP-FPM or SonarQube'], [9090, 'Prometheus'], [9200, 'Elasticsearch'],
    [11211, 'Memcached'], [27017, 'MongoDB'],
  ];
  const PORT_TIMEOUT = 1200;

  /* Three outcomes, and the boundary between them is measured rather than
     guessed. Against ports whose state was known in advance:

       open, speaks HTTP      the fetch RESOLVES, in about 1 ms
       open, speaks something the connection is accepted and then nothing
       else                   matches, so it hangs until the abort at 1200 ms
       closed                 refused in 0.3 to 8 ms

     An earlier version called anything slower than 40 ms open, which a closed
     port answering in 8 ms is one bad moment away from tripping. The honest
     split is the timeout: a fast rejection is refusal, a rejection that had to
     be aborted is a connection that was accepted and went quiet.

     What this misses, and the note under the table says so: a service that
     greets you the instant you connect, like SSH, or answers rubbish and hangs
     up, like a real Redis, is rejected just as fast as a closed port and is
     indistinguishable from one here. */
  function probePort(port) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const ctrl = new AbortController();
      let settled = false;
      const timer = setTimeout(() => ctrl.abort(), PORT_TIMEOUT);
      const finish = (state) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ port, state, took: performance.now() - t0 });
      };
      fetch(`http://127.0.0.1:${port}/`, { mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' })
        .then(() => finish('http'))
        .catch(() => finish(
          ctrl.signal.aborted && performance.now() - t0 >= PORT_TIMEOUT * 0.9 ? 'open' : 'closed'));
    });
  }

  async function portScan() {
    const btn = $('ports');
    busy(btn, 'Knocking');
    const wrap = section('portsWrap');

    const bar = el('div', 'sheet');
    const cap = el('div', 'scan-bar');
    const label = el('span', null, `0 / ${PORTS.length}`);
    const track = el('div', 'scan-track');
    const fillEl = el('span', 'scan-fill');
    track.append(fillEl);
    cap.append(label, track);
    bar.append(cap);
    wrap.append(bar);

    const results = await pool(PORTS, ([port]) => probePort(port), (n, total) => {
      label.textContent = `${n} / ${total}`;
      fillEl.style.width = `${(n / total) * 100}%`;
    });

    wrap.replaceChildren();

    const names = new Map(PORTS);
    const open = results.filter((r) => r.state !== 'closed')
      .sort((a, b) => a.port - b.port);

    const tb = sheet(wrap, 'Ports that answered', `${open.length} of ${PORTS.length} knocked on`);
    if (!open.length) {
      row(tb, 'Nothing answered', `${PORTS.length} ports tried, every one refused`, null);
    } else {
      for (const r of open) {
        row(tb, `Port ${r.port}`,
          `${names.get(r.port)}, ${r.state === 'http' ? 'answered as a web server' : 'accepted the connection'} in ${ms(r.took)}`,
          'site');
      }
    }

    if (open.length) {
      note(wrap, 'Software on your computer, identified by a web page with no prompt and no permission. '
        + 'Nothing went over your network, so a VPN does nothing about it.');
      note(wrap, 'The names are what normally sits on each port, not what was identified. That something '
        + 'answered is the fact, the program is the convention.');
      note(wrap, 'A floor, not a total. Anything that greets you on connect, like SSH, is refused as '
        + 'fast as a closed port and cannot be told apart from one.');
    } else {
      note(wrap, 'Nothing answered: either none of this software is running, or your browser already '
        + 'blocks pages from reaching your own machine.');
    }

    done(btn);
  }

  $('ports').addEventListener('click', portScan);

  async function scan() {
    const btn = $('scan');
    busy(btn, 'Sweeping');
    const wrap = section('scanWrap');

    /* Always http:, whatever this page is served over.

       An earlier version switched to https: on a secure page, on the assumption
       that a plain http: request into the local network would be refused as
       mixed content. Measured from an HTTPS origin, it is not: a request to a
       LAN address that answers plain HTTP resolved in 3.3 ms, and one to
       loopback in 2.3 ms. Meanwhile https: to a device is close to useless,
       because almost nothing on a home network speaks TLS.

       The measurement was taken from a private-address origin, and the deployed
       site is a public one, which is the transition Chrome's Private Network
       Access actually restricts. So this may yet be blocked in production. It
       costs nothing to find out this way round: if the request is refused it
       fails instantly and reads as a closed address, which is the same answer
       the https: version was giving for every address anyway. */
    const scheme = 'http:';

    /* Finding the range to sweep.

       WebRTC would hand us the local address directly, but Chrome and Safari
       now answer with a random .local name instead, so on most browsers there
       is nothing to read. Rather than fall back to knocking on fourteen router
       addresses and calling it a sweep, phase one probes those fourteen and
       phase two sweeps the whole /24 around whichever ones answered. A router
       that says no is a reliable marker for the range you are on, which is the
       same fact WebRTC used to give away for free. */
    let subnet = rtcLocalV4 ? rtcLocalV4.split('.').slice(0, 3).join('.') : null;
    const subnets = new Set();
    let seeds = [];
    if (subnet) subnets.add(subnet);

    if (!subnet) {
      busy(btn, 'Finding your range');
      seeds = await pool(GATEWAYS, (ip) => probe(ip, scheme), () => {});
      for (const s of seeds) {
        if (s.state === 'answered') subnets.add(s.ip.split('.').slice(0, 3).join('.'));
      }
      busy(btn, 'Sweeping');
    }

    /* Only the addresses phase one did not already cover. When it found no
       range at all there is nothing left to sweep, and re-probing the same
       fourteen gateways would just double the wait to reach the same answer. */
    const seeded = new Set(seeds.map((s) => s.ip));
    const targets = [];
    for (const net of subnets) {
      for (let h = 1; h <= 254; h++) {
        const ip = `${net}.${h}`;
        if (!seeded.has(ip)) targets.push(ip);
      }
    }
    for (const g of GATEWAYS) if (!seeded.has(g) && !targets.includes(g)) targets.push(g);
    subnet = [...subnets][0] || null;

    const bar = el('div', 'sheet');
    const cap = el('div', 'scan-bar');
    const label = el('span', null, `0 / ${targets.length}`);
    const track = el('div', 'scan-track');
    const fillEl = el('span', 'scan-fill');
    track.append(fillEl);
    cap.append(label, track);
    bar.append(cap);
    wrap.append(bar);

    const swept = await pool(targets, (ip) => probe(ip, scheme), (n, total) => {
      label.textContent = `${n} / ${total}`;
      fillEl.style.width = `${(n / total) * 100}%`;
    });

    wrap.replaceChildren();

    // Phase one's probes were real probes and count as such.
    const results = seeds.concat(swept);
    const probed = results.length;
    const hits = results.filter((r) => r.state === 'answered').sort((a, b) => a.took - b.took);
    const ranges = [...subnets].map((s) => `${s}.0/24`).join(', ');
    const tb = sheet(wrap, 'Addresses that answered',
      `${hits.length} of ${probed} probed${ranges ? `, across ${ranges}` : ''}`);

    if (!hits.length) {
      row(tb, 'Nothing answered', `${probed} addresses probed, every one silent`, null);
      /* The most likely outcome, and the one worth explaining properly, because
         "found nothing" reads as "nothing is there" and it usually is not. The
         probe can only see a device that actively refuses the connection. A
         device that drops the packet without replying is indistinguishable from
         an address with nothing on it, and dropping is the normal, correct,
         secure behaviour for most hardware. Verified on a network with six
         devices on it, none of which this technique could see. */
      note(wrap, 'Silence is not an empty network. This only sees a device that answers to say no, and '
        + 'most drop the packet without a word. Your network can be full and still look like this.');
    } else {
      for (const h of hits) {
        const isGw = h.ip.endsWith('.1') || h.ip.endsWith('.254');
        row(tb, h.ip, `refused in ${ms(h.took)}${isGw ? ', likely your router' : ''}`,
          h.ip === rtcLocalV4 ? 'local' : 'isp');
      }
    }

    if (!subnets.size) {
      note(wrap, 'No common router address answered, so there was no range to sweep. Either yours is '
        + 'unusual, or the browser blocked the requests.');
    } else if (!rtcLocalV4) {
      note(wrap, 'Your browser refused to hand over your private address, so the range was found by '
        + 'knocking on router addresses instead. Closing one leak does not close the question.');
    }
    if (location.protocol === 'https:') {
      note(wrap, 'This page is encrypted and still knocked on your network in plain HTTP. Encryption on '
        + 'the page says nothing about where it may reach.');
    }
    note(wrap, 'Inference, not a scan. A real tool with a real socket would see the whole network in a '
      + 'second. A web page cannot, and that is the browser protecting you.');

    done(btn);
  }

  $('scan').addEventListener('click', scan);

  // ── 9. The report ────────────────────────────────────────────────────────

  function report() {
    const lines = [`Network Inspector, ${new Date().toISOString()}`, ''];
    for (const s of document.querySelectorAll('.sheet')) {
      const cap = s.querySelector('.sheet-cap code');
      if (cap) lines.push(`## ${cap.textContent}`);
      for (const tr of s.querySelectorAll('tbody tr')) {
        const cells = [...tr.children].map((c) => c.textContent.trim());
        lines.push(cells.filter(Boolean).join('  |  '));
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  $('copyReport').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    try {
      await navigator.clipboard.writeText(report());
      btn.dataset.idle = btn.dataset.idle || btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('is-done');
      setTimeout(() => { btn.textContent = btn.dataset.idle; btn.classList.remove('is-done'); }, 1600);
    } catch {
      btn.textContent = 'Clipboard refused';
    }
  });

  // ── Boot ─────────────────────────────────────────────────────────────────

  renderLine();
  renderPlace();
  renderMachine();
  watchTraffic();
})();
