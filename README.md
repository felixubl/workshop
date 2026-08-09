# Felix' Workshop

A small collection of self-serve browser tools, hosted at
[workshop.fubl.org](https://workshop.fubl.org). No accounts, no build step, no
server: every tool runs entirely client-side, and the whole thing is open
source so that claim is checkable rather than just asserted.

There is exactly one place where a request leaves your browser, and it is the
subject of the tool rather than an exception to the rule: the Network Inspector
can look your IP address up with a third party, ask a STUN server what it sees,
and probe your local range. All three sit behind buttons, nothing is sent on
load, and the page says who it is about to talk to before you press anything.

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

The homepage ([index.html](index.html)) also lists a long line-up of
"coming soon" tool categories: PDF, image, SVG, QR/barcode, audio, video,
text/document, CSV/spreadsheet, developer, font, color, archive, geospatial,
calendar, email, and more. Each new tool lands in its own top-level folder, and
its card goes from a dashed outline to solid stock with a cast once it's built.
A card carries the tool's name and nothing else, plus a pin that drives it to
the front of the grid.

## Stack

Plain HTML/CSS/JS per tool, no bundler, no framework. The design language is
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
5. Add a card for it to the root [index.html](index.html). A card is the tool's
   name and nothing else — no description, no badge, and no `data-tip`, because
   a grid of nineteen that all speak when hovered is a grid that shouts. What
   the tool does goes in an HTML comment on the card. Swap `tool-card-soon` for
   `tool-card-live`, drop the `reg-N` class, wrap the `h3` in
   `a.tool-open`, and update the tally count.

## License

Code in this repo is unlicensed (all rights reserved) unless stated
otherwise. The fonts in `assets/fonts/` are Hepta Slab and Zilla Slab (SIL
Open Font License 1.1) and Cousine (Apache License 2.0). See the `LICENSE-*`
files alongside them.
