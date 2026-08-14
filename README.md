# Felix' Workshop

A collection of browser tools, hosted at
[workshop.fubl.org](https://workshop.fubl.org). No accounts and no build step:
the site is a folder of static files, and the source is public, so what any
tool does can be checked.

Most tools run entirely in the browser; not all will. Rather than a site-wide
claim, every card on the index carries a custody rating on a five-rung scale:

| rung | meaning |
|---|---|
| `local` | Nothing leaves your machine. |
| `fetch` | Reads public data from a third party. Nothing of yours is sent; the request still reveals your IP. |
| `send` | Something of yours is uploaded, processed and returned. Not kept. |
| `store` | Something of yours is kept on a server. The tool says whose. |
| `account` | Kept, and tied to a login. |

The rating is drawn in ink rather than in a plate colour, because the plates
are the index's category vocabulary and a second colour code on the same card
would make both harder to read. It appears as five squares filled from the
left plus one word. The key at the foot of the index defines all five; a card
carries the rating and nothing more.

No tool is above `fetch` today: seven never open a socket, four read public
data and keep nothing. `store` and `account` are defined ahead of the tools
that will need them.

Each of the four on `fetch` names the hosts it contacts on its own page,
before anything is sent. In two of them the traffic is the subject of the tool
rather than an aside — see Network Inspector and Eclipse Recon below. In Route
Sheet the socket is a setting rather than a fact about the tool, so the page
restates its own rung live as that setting changes.

## Tools

The index groups tools by domain rather than by build state, and prints only
the tools that exist. The planned tools listed below are the roadmap; on the
index each is kept as a comment in the section that will hold it.

### Media

Raster and vector images, type, colour, audio and video.

- [Pixel Art SVG Drawer](draw-svg/) — draw pixel art on a grid-snapped canvas,
  starting from a standard sprite size or a custom one, and export the result
  as an SVG file.

- [Image Metadata Cleaner](metadata-cleaner/) — read every metadata field a
  JPEG, PNG or WebP carries (EXIF, GPS, XMP, IPTC, colour profile, embedded
  thumbnail), see what each one discloses, and choose field by field what to
  remove. Works on batches or single files, and is lossless: the pixels are
  never re-encoded.

- [Chiptune Tracker](chiptune-tracker/) — write music for the NES sound chip in
  a pattern grid: two pulse channels with four duty cycles, a triangle with 32
  fixed levels and no volume control, and noise off a 15-bit shift register.
  Instruments are per-frame sequences rather than envelopes, which is how every
  sound driver on the console did it, and the difference between a note that
  decays and one that sustains is a loop point.

  The chip is arithmetic, not samples:
  [`chiptune-tracker/apu.js`](chiptune-tracker/apu.js) steps each voice in CPU
  cycles at four times the output rate and decimates, mixes through the
  hardware's measured non-linear ladders, and applies the analog filters on the
  console's output. What that buys is the wrongness — pitch is an integer
  divider off one 1.789773 MHz clock, so a note is only ever the nearest one
  available and the page prints the error in cents; tempo is a whole number of
  video frames, so speed 6 is 150.2 BPM and speed 7 is 128.8 and there is
  nothing between them; the noise channel has sixteen periods and no pitch at
  all.

  One render serves both the transport and the export, so the WAV cannot differ
  from what was heard. A song is a few kilobytes of integers, saved to a file
  rather than a server. Note entry wants a keyboard, and the page says so.

Planned: image, SVG, font, colour, audio and video toolkits.

### Documents

Tools whose output is a document or a printed sheet. The bingo generator is
filed here rather than under computation, and Route Sheet here rather than
under geospatial, because in both the artefact is the deliverable. The dividing
line with Geospatial is what a tool reads: those measure something outside the
browser, and this prints a file the reader supplied.

- [PDF Toolkit](pdf-toolkit/) — merge, split, extract, reorder, delete and
  rotate PDF pages, with a preview of every page that can be dragged. The PDF
  engine is written from scratch: no library parses, renders or writes
  anything.

- [Bingo Card Generator](bingo-cards/) — enter the squares and it counts the
  number of distinct cards that list can produce, exactly, at any number of
  digits. Request any number of cards and it generates that many, all
  different, from a seed so the same set can be reproduced. The PDF is one card
  per page and is written here without a library.

- [Route Sheet](route-sheet/) — a route in, a printable sheet out: an overview
  map with the path on it, a scale bar and a north arrow, and every turn
  numbered, with how far along it is, how far to the next, and its coordinates.
  Paper needs no signal and no battery, which is the whole argument for it.

  The formats split in two, and the split is what the tool is about. GPX, TCX,
  KML, KMZ and GeoJSON carry the path itself, every vertex of it, and so does a
  response from the Google Directions, OSRM, Mapbox or GraphHopper routing APIs
  — the last of which arrive with written instructions already in them, street
  names and all. A link from Google Maps, Waze, Apple Maps, OpenStreetMap or
  Bing carries only the *stops*, because none of the five publishes the road
  between them; those draw as a dashed line that the sheet labels, in as many
  words, as not a road. A `maps.app.goo.gl` short link cannot be opened at all:
  following it is a cross-origin redirect the browser forbids, and resolving it
  on somebody's server would hand over a destination to save a paste.

  A recorded track has no instructions in it, which is the ordinary case, so
  they are read out of the shape. The direction of travel is measured over a
  window either side of each point rather than between neighbours — at one
  sample apart a GPS fix is noise, at fifty metres it is the road — and where it
  changes by enough the tool says so, with the angle turned through and the
  compass heading it leaves on. Against a fixture of straight legs and known
  corners under ±3 m of jitter, it recovers every corner to within a few degrees
  and to the right tenth of a kilometre. It can never name a street, and the
  page says so; that is the price of not sending the route to anybody.

  The PDF is written here, byte by byte, as the two above it are. The turn
  arrow is drawn at the angle the route actually turns through rather than
  picked from four pictures, so a bend and a right angle do not look alike. With
  the map switched on, tiles are fetched at print resolution and at a whole-
  number zoom, so a tile pixel is a paper pixel, and put through a tone curve
  that lifts the mid-tones while holding the street names dark — a flat fade
  toward white takes the most out of exactly the type the map was fetched for.

Planned: QR codes and barcodes, text and document utilities, email tools.

### Data & Computation

Numbers, text as data, tables, archives and code — work whose output is a
figure or another file rather than a rendering.

- [Random Number Generator](random-numbers/) — draw from eleven distributions
  in up to ten dimensions, seeded and reproducible, with summary statistics and
  CSV/JSON export.

- [Abecedarian Distance](abecedarian/) — *billowy* and *almost* are already in
  alphabetical order; most other words would be under some other alphabet. This
  finds the nearest such alphabet and counts the letter swaps needed to reach
  it — the minimum Cayley distance over all 26! orderings. That claim cannot be
  demonstrated at 26 letters, so it is
  [proved at five and six letters](tools/verify/abecedarian.html), where every
  word can be checked against every permutation by brute force. Some words
  (*anna*, *knowledge*) have no distance at all, and the page reports which
  letter recurs. The engine is a separate file from the page and also runs
  under node, against the same assertions.

  At the foot of the page the same question is asked of four languages at once:
  every headword of the English, Spanish, French and German Hunspell
  dictionaries — 222,830 words — run through that engine. One row of switches
  drives two figures, because one axis cannot answer both questions the survey
  raises.

  The first is the shape: grouped columns, linear, shares of the words that
  have a distance. It says that all four peak at two or three swaps and that
  they are closer to each other than one might expect.

  The second is the ends: one point per distance, logarithmic, shares of *every*
  word. On that axis the rare cases keep their size. Only 1,225 of the 222,830
  words are already abecedarian — 0.55%, and it ranges from 1.1% of English
  down to 0.31% of Spanish. The tails separate too: no Spanish word needs more
  than seven swaps, English runs out at eight, and German alone reaches ten, on
  two words out of 47,707. The words no ordering sorts at all — most of every
  dictionary, 61% of English and around 80% of the other three — stand on that
  same axis, apart from the sequence, because they are not a distance.

  Under both is the far end named: the worst word in each dictionary, and every
  word tying for worst where the tie is short enough to print. English tops out
  at eight swaps on three words, French at eight on ten, Spanish at seven on
  seventeen, and German at ten on *Exportschiffbau* and *gastfreundlich*. Any
  of them can be clicked, which puts it in the field at the top and works it
  out — the words are findings rather than a shelf of examples, which is why
  they sit at the end of the survey and not beside the field.

  Whatever is in the field is marked on the first figure, so a word can be read
  against its language.

  The counting is a build step, not a fetch:
  [`tools/abecedarian-corpus.mjs`](tools/abecedarian-corpus.mjs) surveys the
  four lists offline and writes the tallies to
  [`abecedarian/data/`](abecedarian/data/), which is sixty numbers rather than
  four megabytes of word lists, and keeps the tool on `local`. The sources are
  pinned to one commit of one repository so the four are packaged identically
  and the run repeats. The four inks are not the site's plates: the plates are
  the index's category vocabulary, and green beside red is the one pair a
  red-green reader cannot separate. They were searched for instead, against the
  lightness, chroma, contrast and colour-vision separation each needs, and then
  searched again for the quietest set that still clears it.

  Under both figures is the table, which is their twin: counts only, one number
  to a cell. The figures work in two different denominators, and a table that
  printed a percentage would have to pick one of them and then explain which —
  counts need no denominator, and every share either figure draws can be got
  from them.

Planned: CSV and spreadsheet toolkit, developer tools, archive and file tools,
calendar and date tools.

### Geospatial & Networks

Tools that measure something outside the browser rather than a file the reader
supplied: terrain, sky and the network connection. Every rung above `local` is
in this category, which follows from the definition.

- [Eclipse Recon](eclipse-recon/) — a planning console for a solar eclipse.
  The path is computed from Besselian elements in the browser, with an animated
  umbra that can be scrubbed through time and a report for any point clicked or
  entered as coordinates: contact times, Sun altitude, a terrain-masked horizon
  profile, and the cloud forecast. For a low Sun, cloud is read where the line
  of sight crosses each deck, tens of kilometres toward the Sun's azimuth.

  A suitability field scores the whole umbral band from 0 to 100, weighted by
  certainty: horizon visibility is measured terrain and counts squared, air
  mass penalises a Sun below 8°, the sky is a forecast and is weighted less
  (though a certain storm scores zero), and duration counts gently. A Sun
  behind terrain scores zero regardless of forecast. The formula is printed in
  the tool for every site. A switch removes duration from the score.

  A "within reach" panel maps that field inside a travel radius at a chosen
  cell size, down to 100 m, which is where the terrain data runs out. Finer
  cells cost more horizon scans, all computed in the browser; every scan is
  stored in IndexedDB and does not expire, so finer passes and return visits
  only pay for new ground. Forecasts are not stored.

  A GitHub Action ([`tools/crawl-vis.mjs`](tools/crawl-vis.mjs)) crawls the
  whole band at the same resolution and commits results to
  [`eclipse-recon/data/`](eclipse-recon/data/), which Pages serves to every
  visitor. The workflow disables its own schedule when the queue empties. The
  browser and the crawler run the same formulas. Nothing in the code is
  specific to one eclipse: a catalogue record is a set of elements and a date,
  and another eclipse can be loaded by pasting the Polynomial Besselian
  Elements block from its NASA/GSFC page.

  The map is drawn from elevation alone, with water as the palest tone and land
  darkening in altitude steps. Scores use viridis rather than the site's
  plates: it is perceptually uniform and legible under every form of colour
  vision, and the field is data rather than page furniture. Works on a phone.

- [Eclipse Countdown](eclipse-countdown/) — the same arithmetic applied to a
  narrower question: from a given place, when is the next eclipse and what will
  it look like? A clock counts down to each phase beside a drawing of the Sun
  at the moment on the clock, with the Moon at its true separation and position
  angle and the horizon at true scale, so a Sun that sets mid-eclipse is drawn
  setting. Beside it, the same instant seen from outside: the Moon, its shadow
  cone, the Earth, and a marker for the reader, all from the same elements and
  moving with the clock. Below, every phase with its local time, UT and Sun
  altitude. A preview plays the whole eclipse in 15 seconds.

  A horizon check reads the skyline in the strip of sky the eclipse crosses and
  draws it upright: the quarter hour either side of totality, with the ground
  filled in and the Sun's path across it. It reports what the skyline is made
  of as well as its height, because a block 40 km away is a mountain range and
  a block 150 m away is a roof. Once read, that skyline replaces the flat
  horizon in the drawing above.

  It holds no eclipse data or arithmetic of its own: the catalogue, engine and
  terrain reader are Recon's files
  ([`eclipse-recon/js/eclipses.js`](eclipse-recon/js/eclipses.js),
  [`eclipse-recon/js/bessel.js`](eclipse-recon/js/bessel.js),
  [`eclipse-recon/js/terrain.js`](eclipse-recon/js/terrain.js)), loaded from
  the neighbouring folder rather than copied, so the two tools cannot disagree.
  It is on `fetch` for two reasons, each behind its own button: converting a
  typed place name to coordinates, and reading the terrain. Enter coordinates
  and skip the horizon check and it opens no socket.

- [Network Inspector](network-inspector/) — shows what the browser discloses to
  every site before any interaction, from keyboard layout and installed voices
  to a device fingerprint; breaks the page's own requests into DNS, TCP, TLS
  and wait time; and measures the connection. An IP lookup, a WebRTC probe, a
  scan of local listening ports and a sweep of the local network are each
  behind a button.

Planned: geospatial tools.

### General

Tools that share no domain with the others. The index does not print this
category, because it holds nothing built.

Planned: odds and ends — webpage to PDF, an invoice photo to structured CSV, a
slider comparing two image versions, a signature photo to a transparent PNG, a
passport-photo sheet at exact print dimensions.

## The index

Each tool lives in its own top-level folder and appears on the index once it is
built. The section carries the register class (`reg-N`), so a tool takes the
colour of the category it sits in; the section's band prints that colour as a
small square, which is why the index needs no legend.

A card carries the tool's name, one sentence describing it, two dates written
by `tools/stamp-dates` from git history, a pin, and the custody rating as
`<code class="plate-custody" data-custody="…">`. One attribute sets both the
number of filled squares and the ink, and the key at the foot reads the same
attribute, so the two cannot disagree.

## Stack

Plain HTML, CSS and JS per tool: no bundler, no framework. The one library is
Leaflet 1.9.4 (BSD-2), vendored into Eclipse Recon for the map pane; the
eclipse engine, terrain reader and weather client are written from scratch, and
everything the tool draws reads its colours from the PREPRINT tokens at draw
time, so changing mode restyles the map with the page.

The design language is **PREPRINT**: Hepta Slab for display, Zilla Slab for
running text, Cousine for machine output, three press plates instead of an
accent colour, hard offset casts instead of soft shadows, and one dark mode
across every surface via `data-mode`.

Three CSS layers, in this order:

| layer | file | rule |
|---|---|---|
| the system | [`assets/preprint/`](assets/preprint/) | **vendored verbatim, do not edit.** `tools/sync-preprint` re-copies it from `~/code/preprint`; `tools/push` in the system updates every consumer. |
| shared chrome | [`assets/base.css`](assets/base.css) | the classes every tool reuses, built only from `--pp-*` tokens |
| workshop deviations | [`assets/site.css`](assets/site.css) | the complete list: halftone screen, the tilt, the bench lamp, the drawing surface's ground |

Two of the four scripts come from the system:

- [`js/mode.js`](assets/preprint/js/mode.js) sets `data-mode` before first
  paint and toggles it on any `[data-mode-toggle]`.
- [`js/controls.js`](assets/preprint/js/controls.js) and
  [`controls.css`](assets/preprint/controls.css) draw five widgets the browser
  would otherwise style itself: the number spinner, the checkbox, the colour
  swatch, the `<select>` menu and the `title` tooltip. They work by
  enhancement, so the native `<input>` and `<select>` stay in the DOM and keep
  firing `input` and `change`; a tool reads its controls as if none of this
  existed. A `MutationObserver` picks up controls added after load. Use
  `data-tip` rather than `title`.

The mode control is the workshop's own, and it is the **bench lamp**: a fixture
on a jointed arm hung off the top edge of the page, throwing a cone of light
across the sheet down to the spine. Light mode is the lamp on; dark mode is the
lamp off and the room with it. It replaces both of the system's mode controls —
the swatch and the pull cord — because once the light itself is drawn, a cord
reaching for an undrawn light is the smaller half of the same idea. It is drawn
entirely in [`assets/site.css`](assets/site.css) and has no script: the switch
is a `[data-mode-toggle]` button sitting over the shade, and `mode.js` answers
it. The drawing is a separate, inert `span` at `z-index: -1`, so the cone passes
*behind* the wordmark instead of washing over it, and it is clipped by whatever
element holds it — `.masthead` on the index, `header` on a tool page — which is
what lands the light exactly on the spine at every width.

Two scripts are the workshop's own. [`assets/share.js`](assets/share.js) backs
the `[data-share]` button beside each tool title, which copies that tool's
address. [`assets/favourites.js`](assets/favourites.js) backs the pin: a
`[data-pin]` button toggles its tool in a `localStorage` list under
`workshop-pinned`. The script only sets a class; the sorting is two CSS rules,
because a pinned tool moves to the front of its category and its category to
the front of the page. The index and the tool pages read the same list.

The one vendored file the workshop rewrites is
[`tokens/fonts.css`](assets/preprint/tokens/fonts.css), which self-hosts the
faces instead of requesting them from Google Fonts. The family names it
declares must not change.

## Adding a new tool

1. Create `<tool-name>/index.html`, `style.css`, `script.js`.
2. In `<head>`, before the stylesheets, link `../assets/preprint/js/mode.js`,
   then `../assets/preprint/styles.css`, `../assets/preprint/core.css`,
   `../assets/preprint/controls.css`, `../assets/base.css` and
   `../assets/site.css`. Put only tool-specific layout in the tool's own
   `style.css`.
3. At the end of `<body>`, load the tool's `script.js`, then
   `../assets/preprint/js/controls.js`, `../assets/share.js` and
   `../assets/favourites.js`. The tool's script goes first, so anything it
   builds at startup is in the DOM when the controls are drawn.
4. Give the page the shared header: a `.back-link` and a `.title-row` holding
   `h1.tool-title` plus the `[data-share]` and `[data-pin]` buttons, which key
   off the folder name. Copy the `.lamp` span and the `.lamp-switch` button
   from another tool as the first children of `<header>`: the lamp hangs off
   that element's top edge and is clipped by it, which is why the page's top
   padding belongs to the header and not to `.wrap`.
5. Add a card to the root [index.html](index.html), inside the `section.area`
   for the tool's domain. The section carries the register class, so the card
   does not. Add a `div` in that section's `.plates` with `data-tool`, holding
   a `.plate.plate-live`: the name in an `h3` wrapped in `a.plate-open`, the
   pin, and one `.plate-say` sentence. Remove the tool from that section's
   planned-tools comment and update the section count and the inventory line.
   If no section fits, use `General`, which prints its band for the first time.
6. Give the card its rating. Copy a `code.plate-custody` from another card and
   set `data-custody` to the highest rung the tool reaches: a tool that keeps
   one thing on a server is `store` even if the rest is local. The word and the
   meter are the whole line; hosts and conditions belong on the tool's own
   page. The five `<i>` squares are always five, and the attribute decides how
   many are filled.
7. Commit, then run `tools/stamp-dates` and commit what it rewrites. It is the
   only thing that writes the date lines. Run it again after any later change
   to a tool.

## License

Code in this repo is unlicensed (all rights reserved) unless stated otherwise.
The fonts in `assets/fonts/` are Hepta Slab and Zilla Slab (SIL Open Font
License 1.1) and Cousine (Apache License 2.0). See the `LICENSE-*` files
alongside them.
