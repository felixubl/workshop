# Felix' Workshop

A small collection of self-serve browser tools, hosted at
[workshop.fubl.org](https://workshop.fubl.org). No accounts, no build step, no
server: every tool runs entirely client-side, and the whole thing is open
source so that claim is checkable rather than just asserted.

## Tools

- [Pixel Art SVG Drawer](draw-svg/) — draw pixel art on a grid-snapped canvas,
  start from a classic sprite size or type your own, export exactly what you
  drew as a real SVG file.

The homepage ([index.html](index.html)) also lists a long line-up of
"coming soon" tool categories — PDF, image, SVG, QR/barcode, a random number
generator, audio, video, text/document, CSV/spreadsheet, developer, font,
color, archive, geospatial, calendar, email, and more. Each new tool lands in
its own top-level folder and swaps its card's badge from "Coming soon" to
"Live" once it's built.

## Stack

Plain HTML/CSS/JS per tool, no bundler, no framework. Shared chrome (fonts,
colors, buttons, cards) lives in [`assets/`](assets/) and is pulled in in the
[neo-retro](https://github.com/felixubl/neo-retro) design language:
JetBrains Mono body, Hepta Slab display, warm paper/ink palette, light/dark
via `data-theme`. See [`assets/tokens.css`](assets/tokens.css) for the
current values, and the neo-retro repo if the palette ever gets re-themed.

## Adding a new tool

1. Create `<tool-name>/index.html`, `style.css`, `script.js`.
2. Link `../assets/theme.js` (in `<head>`, before other stylesheets),
   `../assets/tokens.css`, and `../assets/base.css`; write only the
   tool-specific layout in the tool's own `style.css`.
3. Add a card for it to the root [index.html](index.html).

## License

Code in this repo is unlicensed (all rights reserved) unless stated
otherwise. The fonts in `assets/fonts/` are JetBrains Mono and Hepta Slab,
both SIL Open Font License 1.1 — see the `LICENSE-*.txt` files alongside
them.
