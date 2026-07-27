# Felix' Workshop

A small collection of self-serve browser tools, hosted at
[workshop.fubl.org](https://workshop.fubl.org). No accounts, no build step, no
server: every tool runs entirely client-side, and the whole thing is open
source so that claim is checkable rather than just asserted.

## Tools

- [Pixel Art SVG Drawer](draw-svg/) — draw pixel art on a grid-snapped canvas,
  start from a classic sprite size or type your own, export exactly what you
  drew as a real SVG file.
- [Random Number Generator](random-numbers/) — draw from eleven distributions in
  up to ten dimensions, seeded and reproducible, with summary statistics and
  CSV/JSON export.
- [Image Metadata Cleaner](metadata-cleaner/) — read every field a JPEG, PNG or
  WebP is carrying (EXIF, GPS, XMP, IPTC, colour profile, embedded thumbnail),
  see what each one gives away, and choose field by field what to strip. Batch
  or single file, and lossless: the pixels are never re-encoded.

The homepage ([index.html](index.html)) also lists a long line-up of
"coming soon" tool categories: PDF, image, SVG, QR/barcode, audio, video,
text/document, CSV/spreadsheet, developer, font, color, archive, geospatial,
calendar, email, and more. Each new tool lands in its own top-level folder and
swaps its card's badge from "Coming soon" to "Live" once it's built.

## Stack

Plain HTML/CSS/JS per tool, no bundler, no framework. The design language is
**PREPRINT**: a printed sheet, then annotated by hand. Hepta Slab for display,
Zilla Slab for anything read at length, Cousine for anything the machine said,
three press plates instead of an accent colour, hard offset casts instead of
soft shadows, and one dark mode for every surface via `data-mode`.

Three CSS layers, in this order:

| layer | file | rule |
|---|---|---|
| the system | [`assets/preprint/`](assets/preprint/) | **vendored verbatim, do not edit.** Re-copy from the design-system project when it changes. |
| shared chrome | [`assets/base.css`](assets/base.css) | the classes every tool reuses, built only from `--pp-*` tokens |
| the workshop's own deviations | [`assets/site.css`](assets/site.css) | the whole list: halftone screen, category washes, sticker chips, the tilt |

Two shared scripts sit alongside them.
[`assets/theme.js`](assets/theme.js) sets `data-mode` before the first paint.
[`assets/controls.js`](assets/controls.js) draws the five widgets the browser
would otherwise style itself: the number field's spinner, the checkbox, the
colour swatch and its OS dialog, the menu a `<select>` opens, and the grey box a
`title` attribute produces. It works by enhancement, so the native `<input>` and
`<select>` stay in the DOM as the value and keep firing `input` and `change`. A
tool reads its controls exactly as if none of this existed, and a
`MutationObserver` picks up controls built after load. Use `data-tip` rather
than `title` for any tooltip.

The one vendored file the workshop rewrites is
[`assets/preprint/tokens/fonts.css`](assets/preprint/tokens/fonts.css), which
self-hosts the faces instead of requesting them from Google Fonts. The family
names it declares must not change.

## Adding a new tool

1. Create `<tool-name>/index.html`, `style.css`, `script.js`.
2. Link `../assets/theme.js` (in `<head>`, before the stylesheets), then
   `../assets/preprint/styles.css`, `../assets/base.css`, and
   `../assets/site.css`. Write only the tool-specific layout in the tool's own
   `style.css`.
3. At the end of `<body>`, load the tool's `script.js` and then
   `../assets/controls.js`, in that order, so anything the tool builds at
   startup is already in the DOM when the controls are drawn.
4. Add a card for it to the root [index.html](index.html), and move its badge
   from "Coming soon" to "Live".

## License

Code in this repo is unlicensed (all rights reserved) unless stated
otherwise. The fonts in `assets/fonts/` are Hepta Slab and Zilla Slab (SIL
Open Font License 1.1) and Cousine (Apache License 2.0). See the `LICENSE-*`
files alongside them.
