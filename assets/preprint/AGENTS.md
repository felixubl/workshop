# PREPRINT, vendored

The card that travels with a vendored copy of PREPRINT. In a consumer it sits
at `assets/preprint/AGENTS.md` and describes the directory around it, for
whoever lands there next, human or agent. If you are reading it at the root of
the system repository itself, it is the master of that card: start with
`readme.md` instead, which is written for here.

This directory is not editable. The next sync overwrites every file in it
except `tokens/fonts.css`, which was seeded once and is the site's own.
`VERSION` names the system commit this copy came from. To change the system,
change it at the source named in `colophon.json` and run `tools/push` there, or
run `tools/sync-preprint` here to catch up.

## The contract

The identity is short, and it is data: `colophon.json`, beside this file,
carries the exact values. In one paragraph: three plates and three markers that
stay put, one ground and one ink, one dark mode (`data-mode` on the root
element, set before first paint by `js/mode.js`), three faces with three jobs
(Hepta Slab displays, Zilla Slab is read at length, Cousine is what the machine
said), corners on the cut scale (2 / 3 / 4 / 6, pill for tags only), space on
4 / 8 / 12 / 20 / 32 / 52, rules in four weights and three fixed styles. No
gradients, no blur, no soft glow shadows, no hover lifts, no entrance
animations, no emoji. Body is 17px over 66 characters at 1.68, and micro never
goes below 13px.

Markers are fields behind ink, never ink: use `.mk--citron`, `.mk--pink` or
`.mk--cyan` from `core.css`, not a raw `background`. A plate in running text
below 18px hands over to its `--pp-plate-N-text` companion.

## The seven laws

Each has one licensed breach. Two breaches in one view cancel each other, so
budget one per view. A breach is declared where it happens, in a comment:

    /* breach(06): the sticker tilts 1.5deg, the thing depicted is loose */

| # | law | budget |
|---|---|---|
| 01 | corners follow the surface's scale | 1 / view |
| 02 | type sits on the scale | 1 / page |
| 03 | everything meets the column | 1 / section |
| 04 | two elevation levels | 1 / view |
| 05 | plates carry no fixed meaning | 1 / flow |
| 06 | nothing sits off-axis | 1 / page |
| 07 | density is uniform | 1 / page |

An undeclared deviation is drift, and the difference is whether you meant it.
`grep -rn "breach("` lists everything that was meant.

## Loading

    <script src="/assets/preprint/js/mode.js"></script>        <!-- in head, not deferred -->
    <link rel="stylesheet" href="/assets/preprint/styles.css">
    <link rel="stylesheet" href="/assets/preprint/core.css">
    <link rel="stylesheet" href="/assets/preprint/controls.css">    <!-- optional -->
    <link rel="stylesheet" href="/assets/preprint/surfaces/app.css"><!-- or reading.css -->
    <link rel="stylesheet" href="/assets/site.css">                 <!-- yours -->

Load `reading.css` or `app.css`, never both: `.btn`, `.note`, `.rail` and
`.head__row` name different objects in the two sheets, by design.

## What is yours

Layout, density, texture, and as many variables as you want under your own
prefix. Never restate ground, ink, plates or markers, and never invent a
`--pp-*` the system does not define. The site's whole deviation belongs in one
file the site owns, loaded last. Wire the vendored check into the harness and
it will say when any of this drifts:

    <script src="/assets/preprint/tools/conformance.js"
            data-layers="/assets/site.css"></script>

## How design travels

Three moves, and only three. **Vendor**: system to site, with the sync, which
is how everything in this directory arrived. **Promote**: site to system, when
a second surface wants the thing this site built, by changing the system at its
source. **Quote**: site to site, never. A pattern this site invented is either
promoted or it stays home. The full argument is `guidelines/transfer.md` in the
system repository.

Do not reproduce the system's reference surfaces. Build the surface the job
needs, and let the constants make it recognisable.
