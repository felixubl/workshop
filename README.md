# Felix' Workshop

A small collection of self-serve browser tools, hosted at
[workshop.fubl.org](https://workshop.fubl.org). No accounts, no build step, no
server: every tool runs entirely client-side, and the whole thing is open
source so that claim is checkable rather than just asserted.

Two tools talk to the network, and in both the traffic is the subject of the
tool rather than an exception to the rule. The Network Inspector can look your
IP address up with a third party, ask a STUN server what it sees, and probe
your local range — all behind buttons, nothing sent on load, and the page says
who it is about to talk to before you press anything. Eclipse Recon is a map
of the world with live weather on it, which cannot exist without a network:
it fetches elevation tiles (Mapzen/AWS) for both the base map and the horizon
scans, map labels (Carto/OSM) and forecasts (Open-Meteo), plus a keyless
reverse geocoder for place names, and credits every one of them on screen.
The eclipse mathematics itself runs entirely in your browser.

## Tools

- [Pixel Art SVG Drawer](draw-svg/) — draw pixel art on a grid-snapped canvas,
  start from a classic sprite size or type your own, export exactly what you
  drew as a real SVG file.
- [Random Number Generator](random-numbers/) — draw from eleven distributions in
  up to ten dimensions, seeded and reproducible, with summary statistics and
  CSV/JSON export.
- [PDF Toolkit](pdf-toolkit/) — merge, split, extract, reorder, delete and
  turn PDF pages, with every page shown as a real preview you can drag. The
  PDF engine underneath is written from scratch: no library parses, renders
  or writes anything here.
- [Network Inspector](network-inspector/) — see what your browser gives away to
  every site before you touch anything, from your keyboard layout and installed
  voices to a fingerprint of the machine, watch the page's own requests broken
  into DNS, TCP, TLS and wait time, measure the line, then opt in to an IP
  lookup, a WebRTC probe, a scan of the ports your own computer is listening on,
  and a sweep of the network around it.
- [Image Metadata Cleaner](metadata-cleaner/) — read every field a JPEG, PNG or
  WebP is carrying (EXIF, GPS, XMP, IPTC, colour profile, embedded thumbnail),
  see what each one gives away, and choose field by field what to strip. Batch
  or single file, and lossless: the pixels are never re-encoded.
- [Bingo Card Generator](bingo-cards/) — type the squares, and it counts every
  distinct card that list can make, exactly, however many digits that takes.
  Ask for as many as you want and it deals that many, no two alike, seeded so
  the same set comes back. The PDF is one card per page and is written here,
  byte by byte, with no library involved.
- [Eclipse Recon](eclipse-recon/) — an ops-console view of a solar
  eclipse: the path computed from Besselian elements in the browser, an
  animated umbra you can scrub through time, and a dossier for any point
  you click or type as coordinates — contact times, Sun altitude, a
  terrain-masked horizon profile (does that ridge hide a low Sun?), and the
  cloud outlook, including the sightline: for a low Sun, cloud is read
  where the line to the Sun crosses each deck, tens of kilometres toward
  its azimuth. A suitability field paints the whole umbral band in a
  red-to-green ramp, weighted by certainty: the horizon is surveyed fact
  and counts squared, air mass punishes a Sun under 8°, the sky is a
  prognosis and is softened — though a certain storm still scores zero —
  and duration counts gently, because any totality is the event. A Sun
  behind terrain is zero whatever the forecast, and the formula is
  printed in the tool, factor by factor, for every site you click. A
  "within reach" panel answers the practical question — I am here, where
  could I go? — by painting that field inside a travel radius, graded on
  the local curve, at a cell size the reader chooses — down to 100 m,
  the scale at which the terrain data itself runs out: finer costs
  more horizon scans, all computed on their own machine, and every scan
  is kept in the browser (IndexedDB) — the horizon is surveyed fact and
  never expires — so finer passes and return visits only pay for ground
  not yet surveyed. Forecasts are never stored that way. Behind it runs
  the repo's one piece of automation: a GitHub Action
  ([`tools/crawl-vis.mjs`](tools/crawl-vis.mjs)) crawls the entire band
  at the same resolution, hour after hour, back to back, until every
  square has its value — ocean and high-Sun tiles resolve instantly,
  mountainous ground gets truly scanned — committing progress into
  [`eclipse-recon/data/`](eclipse-recon/data/) as it goes, which Pages
  serves to everyone; the Event panel shows how far it has got, and
  every visitor's fine maps reuse what it has settled. When the queue
  empties the workflow switches its own schedule off: the crawl is a
  finite data build, not a resident service. The site still runs no
  server, and the browser math and the crawler math are the same
  formulas line for line. Nothing is per-eclipse in the code: a
  catalogue record is elements and a date, everything else is derived, and
  any other eclipse loads by pasting the Polynomial Besselian Elements
  block off its NASA/GSFC page. It wears PREPRINT like the rest: the map is
  drawn from elevation alone — water the palest flat tone, land darkening
  in altitude steps with a key in the corner — the Moon's shadow is printed
  in actual black, and the plates appear only where they mean something —
  plate 3 is totality, and every score wears one ramp pressed from plate 2
  through the citron marker to plate 1: cannot see it, gamble, go. It is
  the second tool that talks to the network (see above), and it works on a
  phone.

The homepage ([index.html](index.html)) also lists a long line-up of
"coming soon" tool categories: PDF, image, SVG, QR/barcode, audio, video,
text/document, CSV/spreadsheet, developer, font, color, archive, geospatial,
calendar, email, and more. Each new tool lands in its own top-level folder, and
its card goes from a queue row to solid stock with a cast once it's built.
A card carries the tool's name, one sentence of what it is for, and two dates
in small print — the day the tool first landed and the day it last changed,
read out of git history by `tools/stamp-dates` rather than written by hand —
plus a pin that drives it to the front of the grid. The tools that talk to
the network carry a small plate-3 `network` mark under the dates; an
unmarked card runs entirely on your machine. "Everything is local" is a
per-tool promise, checked card by card, not a site-wide vow.

## Stack

Plain HTML/CSS/JS per tool, no bundler, no framework. The one exception to
"no library" is Eclipse Recon, which vendors Leaflet 1.9.4 (BSD-2) into its
own folder for the map pane — the eclipse engine, terrain reader and weather
client beside it are written from scratch, and everything the tool draws
(map overlays, charts) reads its colour off the PREPRINT tokens at draw
time, so the pull cord restyles the map along with the page. The design
language is
**PREPRINT**: a printed sheet, then annotated by hand. Hepta Slab for display,
Zilla Slab for anything read at length, Cousine for anything the machine said,
three press plates instead of an accent colour, hard offset casts instead of
soft shadows, and one dark mode for every surface via `data-mode`.

Three CSS layers, in this order:

| layer | file | rule |
|---|---|---|
| the system | [`assets/preprint/`](assets/preprint/) | **vendored verbatim, do not edit.** `tools/sync-preprint` re-copies it from `~/code/preprint`, and `tools/push` in the system does every consumer at once. |
| shared chrome | [`assets/base.css`](assets/base.css) | the classes every tool reuses, built only from `--pp-*` tokens |
| the workshop's own deviations | [`assets/site.css`](assets/site.css) | the whole list: halftone screen, category washes, sticker chips, the tilt |

Three of the four scripts are the system's, vendored with it.
[`assets/preprint/js/mode.js`](assets/preprint/js/mode.js) sets `data-mode`
before the first paint and flips it on any `[data-mode-toggle]`. It is the
system's rather than the workshop's because there is one dark mode across
everything set in PREPRINT, and this file was previously written twice.
[`assets/preprint/js/pullcord.js`](assets/preprint/js/pullcord.js) is the
control that drives it here. Core ships two, and the workshop takes the cord
rather than the swatch fubl.org wears: a 1px line hanging off the top edge with
a bead on the end. Take hold of the bead and it follows the hand until the
detent trips at 42px, which is where the mode changes — let go short of that
and it springs back having done nothing. It goes sideways as well as down,
swinging from the point it hangs off, and it resists as it goes: the first
pixels track the hand exactly and the last ones barely move, in both
directions. How far sideways depends on how much page there is next to it, so
the cord never reaches the edge. Let go and it swings once past rest and
settles. Clicking it plays an abbreviated 13px version of the same pull, and
Enter and Space go through that too. Either way there is a two-part click when
the detent goes. The sound is on by default and silenced by
`localStorage['preprint-sound'] = 'off'` or by `prefers-reduced-motion`, which
also drops the animation while leaving the drag and its threshold intact.
Neither script draws anything: the cord is `.pullcord` in `core.css`, and the
positioned ancestor it hangs from is `.wrap` / `.masthead` in `base.css`.
[`assets/preprint/js/controls.js`](assets/preprint/js/controls.js), with
[`assets/preprint/controls.css`](assets/preprint/controls.css) beside it, draws
the five widgets the browser would otherwise style itself: the number field's
spinner, the checkbox, the colour swatch and its OS dialog, the menu a
`<select>` opens, and the grey box a `title` attribute produces. It works by
enhancement, so the native `<input>` and `<select>` stay in the DOM as the value
and keep firing `input` and `change`. A tool reads its controls exactly as if
none of this existed, and a `MutationObserver` picks up controls built after
load. Use `data-tip` rather than `title` for any tooltip.

Two scripts are the workshop's own.
[`assets/share.js`](assets/share.js) backs the one `[data-share]` button each
tool page carries beside its title, which copies that tool's own address.
[`assets/favourites.js`](assets/favourites.js) backs the pin: any `[data-pin]`
button toggles its tool in a list held in `localStorage` under
`workshop-pinned`, and pinned tools sort to the front of the index. The index
and the tool pages read the same list, so pinning from inside a tool moves its
card too.

The one vendored file the workshop rewrites is
[`assets/preprint/tokens/fonts.css`](assets/preprint/tokens/fonts.css), which
self-hosts the faces instead of requesting them from Google Fonts. The family
names it declares must not change.

## Adding a new tool

1. Create `<tool-name>/index.html`, `style.css`, `script.js`.
2. Link `../assets/preprint/js/mode.js` (in `<head>`, before the stylesheets)
   and `../assets/preprint/js/pullcord.js` after it with `defer`, then
   `../assets/preprint/styles.css`, `../assets/preprint/core.css`,
   `../assets/preprint/controls.css`, `../assets/base.css`, and
   `../assets/site.css`. Write only the tool-specific layout in the tool's own
   `style.css`.
3. At the end of `<body>`, load the tool's `script.js`, then
   `../assets/preprint/js/controls.js`, `../assets/share.js` and
   `../assets/favourites.js`. The tool's own script goes first so anything it
   builds at startup is already in the DOM when the controls are drawn.
4. Give the page the shared header: a `.back-link`, a `.title-row` holding the
   `h1.tool-title` plus the `[data-share]` and `[data-pin]` buttons, which both
   key off the folder name. The `.pullcord` goes above the header as the first
   child of `.wrap`, not inside it — it hangs from the top of the page, and
   `<header>` starts below the shell's padding.
5. Add a card for it to the root [index.html](index.html): a `div` on the
   bench with the tool's register class (`reg-N`) and `data-tool`, holding a
   `.plate.plate-live` — the name in an `h3` wrapped in `a.plate-open`, the
   pin, and one `.plate-say` sentence. Remove the tool's queue row if it had
   one, and update both tally counts. If the tool talks to the network, add
   a `code.plate-net` mark under the dates saying so, tersely.
6. Commit, then run `tools/stamp-dates` and commit what it rewrites: it reads
   git history and presses two dates onto every card — the day the tool first
   landed, the day it last changed — and that script is the only thing that
   writes those lines. Run it again after any later change to a tool.

## License

Code in this repo is unlicensed (all rights reserved) unless stated
otherwise. The fonts in `assets/fonts/` are Hepta Slab and Zilla Slab (SIL
Open Font License 1.1) and Cousine (Apache License 2.0). See the `LICENSE-*`
files alongside them.
