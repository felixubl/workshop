# Felix' Workshop

A small collection of self-serve browser tools, hosted at
[workshop.fubl.org](https://workshop.fubl.org). No accounts and no build step:
the site is a folder of static files, and the whole thing is open source, so
what any one tool does is checkable rather than merely asserted.

Most of them run entirely in your browser. Not all of them will. Rather than a
site-wide vow that one tool could falsify — and rather than the older
arrangement, where the reassuring case was the *absence* of a mark — every card
on the index says what leaves your machine, on a five-rung ladder printed on
all of them:

| rung | what it means |
|---|---|
| `local` | Nothing leaves the page. It is fetched once and then runs on your machine. |
| `fetch` | It asks somebody else for public data. Nothing you gave it goes out, but the request does, and a request is your address and what you asked for. |
| `send` | Something you gave it goes out to be worked on and comes back. It is not kept. |
| `store` | Something you gave it is kept on a server. The tool says whose. |
| `account` | Kept, and tied to a name you signed in with. |

The ladder is printed in ink and never in a plate, because the plates are the
index's *category* vocabulary — the cast on a card, the square in front of a
queued name — and a second colour code on the same object would make both
harder to trust. Invasiveness is measured in ink coverage instead: five small
squares driven in from the left, and a word that darkens as the rung rises.
The key at the foot of the index defines all five, and it is the only place
one is spelled out: a card carries the rating and stops there.

Nothing on the bench is above `fetch` today — six tools never open a socket,
and three read public data and keep nothing. `store` and `account` are printed
unused because the tools that will need them (Convex, Supabase, or something
self-hosted on a VPS) are planned, and a scale written to describe what already
exists is a scale bent to fit it.

Each of the three on `fetch` names who it is about to talk to on its own page,
before anything is sent, and in two of them the traffic is the subject rather
than an aside. The Network Inspector can look your
IP address up with a third party, ask a STUN server what it sees, and probe
your local range — all behind buttons, with nothing sent on load at all.
Eclipse Recon is a map
of the world with live weather on it, which cannot exist without a network:
it fetches elevation tiles (Mapzen/AWS) for both the base map and the horizon
scans, map labels (Carto/OSM) and forecasts (Open-Meteo), plus a keyless
reverse geocoder for place names, and credits every one of them on screen.
The third asks for two things and only on demand: Eclipse Countdown sends a
typed place name to Open-Meteo's keyless geocoder to turn it into coordinates,
and reads AWS terrain tiles when you press the horizon check — each on its own
button and never on load. Type coordinates and skip the horizon and it opens no
socket at all. The eclipse mathematics itself runs in your browser in both of
the eclipse tools.

## Tools

The homepage sorts them the way a workshop sorts tools: by the kind of work,
not by what is finished. Five areas, and each one keeps both — the tools that
exist, and the gaps on its own wall. Sorting by state instead answered "how far
along is this site", which is a question nobody arrives holding.

### At the light table

Anything whose output is looked at or listened to.

- [Pixel Art SVG Drawer](draw-svg/) — draw pixel art on a grid-snapped canvas,
  start from a classic sprite size or type your own, export exactly what you
  drew as a real SVG file.

- [Image Metadata Cleaner](metadata-cleaner/) — read every field a JPEG, PNG or
  WebP is carrying (EXIF, GPS, XMP, IPTC, colour profile, embedded thumbnail),
  see what each one gives away, and choose field by field what to strip. Batch
  or single file, and lossless: the pixels are never re-encoded.

Still on the list: image, SVG, font, colour, audio and video toolkits.

### At the press

Anything that ends up a document or a printed sheet.

- [PDF Toolkit](pdf-toolkit/) — merge, split, extract, reorder, delete and
  turn PDF pages, with every page shown as a real preview you can drag. The
  PDF engine underneath is written from scratch: no library parses, renders
  or writes anything here.

- [Bingo Card Generator](bingo-cards/) — type the squares, and it counts every
  distinct card that list can make, exactly, however many digits that takes.
  Ask for as many as you want and it deals that many, no two alike, seeded so
  the same set comes back. The PDF is one card per page and is written here,
  byte by byte, with no library involved.

Still on the list: QR codes and barcodes, text and document utilities, email tools.

### At the workbench

Numbers, letters, tables and files — work whose output is a figure or another
file rather than something to look at.

- [Random Number Generator](random-numbers/) — draw from eleven distributions in
  up to ten dimensions, seeded and reproducible, with summary statistics and
  CSV/JSON export.

- [Abecedarian Distance](abecedarian/) — *billowy* and *almost* already run in
  alphabetical order; nearly every other word would too, under some other
  alphabet. This finds the nearest such alphabet and counts the letter swaps it
  took to get there — the minimum Cayley distance over all 26! orderings, which
  is a claim the tool cannot demonstrate at 26 letters and so
  [proves at five and six](tools/verify/abecedarian.html), where every word can
  be checked against every permutation by brute force. Some words — *anna*,
  *knowledge* — have no distance at all, and the page says which letter left and
  came back. The engine is a separate file from the page and runs under node too,
  off the same assertions.

Still on the list: CSV and spreadsheet toolkit, developer tools, archive and file tools,
calendar and date tools.

### Out in the field

The tools that look outward rather than at a file you brought — at the ground,
the sky and the wire. Every rung above `local` on the page is here, which is not
a coincidence: a tool that reports on the world has to reach it.

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
  plate 3 is totality, and every score wears one scale: viridis, worst
  to best — the standard scientific ramp, perceptually uniform and
  legible under every form of colour vision, deliberately not pressed
  from the site's own plates because the field is data, not chrome. A
  switch takes totality's duration out of the score, leaving it purely
  about seeing. It is
  the second tool that talks to the network (see above), and it works on a
  phone.

- [Eclipse Countdown](eclipse-countdown/) — the same arithmetic, asked the
  smaller question: from where I am, when is the next one and what will it look
  like? A clock counts down to the next phase — first contact, totality, last
  contact — beside a drawing of the Sun for the moment on the clock: zenith up,
  the Moon at its true separation and position angle, and the whole thing
  printed as two plates and their overprint — plate 2 is Sun nobody is
  covering, plate 3 is Moon standing off the Sun's face, and the dark third
  colour where they land on the same paper is exactly the bite — with the
  horizon at true scale, so a Sun that sets mid-eclipse is drawn setting.
  Beside it, the same instant seen from outside: the Moon, the shadow cone it
  casts, the Earth it lands on and a dot for the reader standing under it, all
  read off the same Besselian elements and moving with the clock, so the bite
  in the disc above and the cone in the diagram are one shadow drawn from both
  ends. Under it, every phase with
  its local time, its time in UT and the Sun's altitude. A preview plays the
  whole eclipse in 15 seconds, easing continuously into the middle and out
  again — a rate that changes in steps reads as a fault rather than as a
  slowdown — and printing the rate it is running at. A horizon check borrows Recon's terrain reader and asks it
  a much narrower question — the skyline in the strip of sky the eclipse
  actually crosses — and prints the answer upright: the quarter hour either
  side of totality, tall, with the ground filled in and the Sun's path drawn
  across it, dashed and in plate 2 wherever the ground takes it. It says what
  the skyline is made of as well as how high it stands, because a block from
  40 km out is a mountain range and a block from 150 m out is the elevation
  model reading the roof across the street. Once it has been read, that same
  skyline is what the Sun sets behind in the drawing above — the real ridge
  line at true scale, in place of the flat horizon an unread one gets. It holds no eclipse data and no
  eclipse arithmetic of its own: the catalogue, the engine and the terrain
  reader are Recon's files
  ([`eclipse-recon/js/eclipses.js`](eclipse-recon/js/eclipses.js),
  [`eclipse-recon/js/bessel.js`](eclipse-recon/js/bessel.js),
  [`eclipse-recon/js/terrain.js`](eclipse-recon/js/terrain.js)), loaded from
  the folder next door rather than copied, so the two tools cannot disagree
  about when the Moon arrives or what stands in the way — and an eclipse pasted
  into Recon appears here too. It sits on `fetch` for two reasons, each behind
  its own button: turning a typed place name into coordinates, and reading the
  ground around you. Type the coordinates and skip the horizon and it opens no
  socket at all.

- [Network Inspector](network-inspector/) — see what your browser gives away to
  every site before you touch anything, from your keyboard layout and installed
  voices to a fingerprint of the machine, watch the page's own requests broken
  into DNS, TCP, TLS and wait time, measure the line, then opt in to an IP
  lookup, a WebRTC probe, a scan of the ports your own computer is listening on,
  and a sweep of the network around it.

Still on the list: geospatial tools.

### In the drawer

The general drawer, and every shop has one. What goes in it is not united by a
use case — it is united by not having a bench, which is a real category and the
only honest place to keep the jobs that are one job each.

Still on the list: odds and ends — webpage to PDF, an invoice photo to structured CSV, a slider
comparing two image versions, a signature photo to a transparent PNG, a
passport-photo sheet at exact print dimensions.

Each new tool lands in its own top-level folder, inside the area it belongs to,
and its card goes from a queue row to solid stock with a cast once it's built.
The area carries the register (`reg-N`), so a tool's ink is wherever the tool is
standing and the two cannot disagree; the area's band prints that ink as the
same small square a queued name wears, which is why the index needs no legend
for it.

A card carries the tool's name, one sentence of what it is for, two dates
in small print — the day the tool first landed and the day it last changed,
read out of git history by `tools/stamp-dates` rather than written by hand —
a pin that drives it and its area to the front, and its rung on the ladder
above: `<code class="plate-custody" data-custody="…">`, holding a five-square
meter and the rung's word. That is the whole of it. The card used to finish
that line with an em dash and a clause naming the hosts — `fetch — AWS terrain,
Carto, Open-Meteo, BigDataCloud` — a different sentence per tool, of a
different length, saying a different amount, so no two cards could be read
against each other and the mark stopped being a scale. A rating compares or it
is not a rating. The hosts are on the tool's own page, in full, named before
anything is sent, which is where a reader is standing when the answer matters.
One attribute sets both the filled-square count and the ink, and the key at the
foot of the page reads the same attribute, so a card and the key cannot drift
apart.

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
`workshop-pinned`, and pinned tools sort to the front of the index. The script
only sets a class; the sorting is two CSS rules, because a pinned tool now has
to clear two levels — it comes to the front of its own area, and its area comes
to the front of the page, or it would sit at the top of a bench the reader
still has to scroll to find. The index and the tool pages read the same list, so
pinning from inside a tool moves its card too.

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
5. Add a card for it to the root [index.html](index.html), inside the
   `section.area` whose bench the tool belongs to — the area carries the
   register class, so the card does not. A `div` in that area's `.plates` with
   `data-tool`, holding a `.plate.plate-live` — the name in an `h3` wrapped in
   `a.plate-open`, the pin, and one `.plate-say` sentence. Remove the tool's
   queue row if that area had one, and update that area's counts and the
   shop-floor line. If no existing area fits, the drawer does; a sixth area is
   a decision about the shop, not about the tool.
6. Give the card its rung. Copy a `code.plate-custody` from any existing card
   and set `data-custody` to the highest rung the tool actually reaches — a
   tool that keeps one thing on a server is `store` even if everything else it
   does is local. The word and the meter are the whole of the line: nothing
   about hosts, conditions or what is kept goes on the card, because a rating
   that varies in length per tool stops comparing. The five `<i>` squares are
   always five; the attribute decides how many are filled. Anything above
   `local` has to be named on the tool's own page, in its own words, before
   anything is sent or kept.
7. Commit, then run `tools/stamp-dates` and commit what it rewrites: it reads
   git history and presses two dates onto every card — the day the tool first
   landed, the day it last changed — and that script is the only thing that
   writes those lines. Run it again after any later change to a tool.

## License

Code in this repo is unlicensed (all rights reserved) unless stated
otherwise. The fonts in `assets/fonts/` are Hepta Slab and Zilla Slab (SIL
Open Font License 1.1) and Cousine (Apache License 2.0). See the `LICENSE-*`
files alongside them.
