# Golden Hour Recon, and the workshop's first backend

Status: planned, nothing built. Written 2026-08-17 after a measurement session.
Nothing in this document is committed to beyond the four decisions marked as
decided.

Golden Hour Recon answers, for any point on earth and any day, when the sun
actually clears the skyline rather than the mathematical horizon, and therefore
when golden hour really starts and ends there. Terrain-corrected, not
almanac-corrected.

## Decided

1. The workshop gets **one shared backend**, not one per tool.
2. It is **workshop-only**, at `api.workshop.fubl.org`, not a general
   `api.fubl.org` shared with the other Hetzner apps.
3. It lives in a **separate repo**, not a `server/` directory here.
4. The governing rule: **the backend stores facts about the world, never facts
   about a user.** No accounts, no cookies, no saved projects, no sync.

Rule 4 is what keeps "workshop backend" from becoming "workshop platform".
Isolation happens at the data layer: one process, one route namespace and table
set per **dataset**, no shared domain models, and any dataset removable by
dropping its tables and deleting one route file. Note *dataset*, not *tool* —
see the next section for why that distinction turned out to matter.

## The lesson from Eclipse Recon: store the input, not the answer

Eclipse Recon already does almost all of this. `eclipse-recon/js/terrain.js`
reads the same DEM source, decodes it the same way, and applies the same
curvature and refraction model. `tools/crawl-vis.mjs` is a working crawler on a
scheduled GitHub Action, with a queue, a manifest and results committed as PNG
data tiles. So the workshop already has a backend of sorts: Actions is the
compute, committed PNGs are the storage, Pages is the CDN.

But none of that data is reusable, because **it stores the answer rather than
the input**. A committed tile holds the fraction of totality the local horizon
allows, for one specific eclipse. You cannot recover a horizon profile from a
totality fraction. The browser's IndexedDB scans have the same problem twice
over: `scanKey` includes `azCenter`, `azSpan`, `maxKm` and `eyeM`, so they are
keyed to the question and not the place; they only cover a 60 to 110 degree
sector around that eclipse's sun azimuth; and they sit in each visitor's browser
where nothing can collect them.

The horizon profile is the input, and it is worth storing forever:

- It is **expensive**: 2 to 3 MB of DEM tiles and a few hundred ms of ray-casting.
- It is **permanent**: terrain does not change.
- It is **shared**: golden hour asks when the sun crosses the skyline, eclipse
  recon asks whether the sun is above it at one instant, solar siting asks how
  much of the year a roof is shaded, astrophotography asks when a target clears
  the ridge. One dataset, four questions.

So the shared store holds a **canonical full-circle horizon profile per place**,
and every tool derives its own answer. Eclipse Recon then becomes a consumer
rather than an owner, its crawler fills the same commons, and Golden Hour
inherits every tile the eclipse crawler ever settled.

## What a server actually adds

Given Actions plus committed tiles already works, the server is justified by
exactly three things it cannot do:

1. **Accept writes from browsers.** A visitor's tab cannot commit to a repo.
   This is the crowdsourcing requirement and it is the real reason for a server.
2. **Grow without bound.** 14,818 committed tiles for one eclipse is fine. A
   global permanent horizon dataset is not, because git keeps every version of
   every binary forever.
3. **Serve partial queries** (bbox, per-cell) rather than whole tiles.

## The crowdsourcing model

Users who open the map and look at a location spend their own CPU computing the
horizon there, and the result is kept for everyone. A crawler fills the unpopular
places slowly in the background. Popular spots therefore settle almost
immediately, which is the desired behaviour.

This is not merely an optimisation. Land is about 149 million km². Even at 250 m
cells that is 2.4 billion cells, roughly 15 CPU-years at current speed.
**Precomputing the world is off the table**, so demand-driven filling is the only
option and the crawler must prioritise rather than sweep.

Writes are unauthenticated by construction, so three cheap defences stack:

- The computation is deterministic given place, DEM version and algorithm
  version, so a background worker can recompute a random sample and blacklist
  sources that disagree.
- Neighbouring horizons are highly correlated, so an outlier check against known
  neighbours catches most junk for free.
- A cell stays unconfirmed until a second independent submission agrees.

## Measured facts

All verified in a prototype session, not estimated.

**DEM source.** Must be the AWS terrain-tiles Terrarium PNGs
(`s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`): keyless and
serves `Access-Control-Allow-Origin: *`. Copernicus GLO-30 COGs are keyless and
support range requests but send **no CORS headers**, so they are unusable from a
browser. Decode is `R*256 + G + B/256 - 32768`.

**Cost per location.** A pyramid of z12 to 4 km, z10 to 25 km, z8 to 150 km is
26 to 34 tiles and 2 to 3 MB, 1 to 3 s to fetch and decode. Ray-casting 720
azimuths is about 200 ms unoptimised.

**Download amortises across a block, compute does not.** An 11x11 block from one
pyramid needed zero extra tiles but still about 203 ms per point, 24 s total. So
a client should submit a neighbourhood, but the neighbourhood is not free.

**Payload is tiny.** 720 samples at 0.25 degree resolution is 720 bytes raw, and
96 to 191 bytes after delta-coding around the ring then brotli. A million cells
is well under 1 GB.

**A fixed global grid does not work.** This is the one permanent decision and it
is still open. At Innsbruck a 100 m move shifts sunrise by 5.4 minutes and 250 m
shifts it by 9.3 minutes. This is real terrain, not sampling noise: the numbers
are identical whether the ray starts at 7.5 m, 60 m or 120 m. Flat Vienna is 0.1
to 1.0 minutes over the same distances. So **cell size must adapt to local
relief**, derived deterministically from coarse DEM so client and server agree on
the grid without coordinating. Flat areas get kilometre cells and high cache-hit
rates; alpine areas get 50 m cells and low ones.

**Range sampling is currently too coarse.** See issue #81. Growth of 1.09 per
step costs up to 1.36 degrees of horizon error at Innsbruck, worth 6.9 minutes.
Growth of 1.04 brings that to 0.7 minutes for 2.2x the samples, and 1.02 buys
nothing further.

## Conventions to keep

- Curvature and refraction: `drop = d²/(2R)·(1-k)` with `k = 0.13`. Equivalent to
  `d²/(2·R_eff)` with `R_eff = R/(1-k)`. Eclipse Recon already does this
  correctly.
- Sunrise and sunset: the NOAA geometric convention, centre altitude
  -0.833 degrees, reproduces published times exactly. Comparing *apparent*
  altitude to -0.266 is about 50 s early.
- Because the DEM ray-cast already applies refraction, the terrain crossing
  compares apparent solar altitude against `skylineAngle - 0.266` (the sun's
  semidiameter), not against the skyline angle itself.
- Below sea level reads as 0, because water forms its own horizon.

Validation checks worth repeating after any change: Innsbruck observer elevation
576 m against an actual 575 m, its maximum skyline 18.6 degrees at azimuth 334
degrees (the Nordkette), and a sea horizon of -0.07 degrees at Sylt against a
theoretical dip of -0.064 degrees for a 3 m eye height.

## An open question about the custody scale

The index's five-rung scale defines `store` as "something of yours is kept on a
server". A submitted horizon profile is **not** something of yours. It is a
computed fact about a public place with nothing identifying in it, so it is
strictly more private than `send`, which the scale ranks *below* `store`, yet it
does involve a permanent server write.

Golden Hour therefore needs a rung the scale does not currently have: contributes
an anonymous public fact, keeps nothing about you. That rung's wording is the
promise the server then has to keep, so it should be decided deliberately rather
than by picking the nearest existing label.

## Photo-refined horizons, later

Raised as a wanted feature: let users upload photos so trees and buildings refine
a cell, since the DEM resolves neither well.

The premise needs one correction. The DEM is DSM-derived, so it does capture some
built mass crudely at 30 m; 500 m north of Stephansplatz the skyline at the
sunrise azimuth reads 2.52 degrees rather than 0.08, which is a roughly 20 m
obstruction a few hundred metres out. What it cannot do is resolve individual
houses and trees, and it is least trustworthy in the near field, which is exactly
where obstructions matter most angularly: a 15 m tree at 100 m subtends 8.5
degrees, the same tree at 1 km subtends 0.9 degrees.

The hard part is camera pose, not sky detection. A phone compass is good to maybe
10 to 15 degrees, useless at a sharp skyline edge. The workable trick is to fit
the pose to the photo: render the predicted terrain ridgeline from the DEM, align
it against the detected ridgeline in the image, and solve azimuth, pitch, roll
and field of view from that fit. Anything occluding more than the fitted terrain
line is then the built environment, measured rather than guessed. This works best
in terrain, because terrain is what gives you a ridgeline to fit; in a flat city
there is nothing to fit against.

Merging many photos is not averaging and definitely not a maximum, since one bad
photo would poison a cell forever. It wants a robust per-azimuth percentile with
outlier rejection, because photos disagree for legitimate reasons: a passing
truck, a thumb on the lens, positions that differ within one cell, and deciduous
trees, which mean a cell genuinely has a summer skyline and a winter one.

**Firm recommendation: never store the photo.** Extract the skyline in the
browser and upload only the derived numbers plus the fitted pose. That keeps rule
4 intact and means no image moderation and no exposure from strangers' faces and
GPS tags. The workshop already ships a Metadata Cleaner; the photo tool that
never uploads a photo is the right shape for this site.

## Next steps, in order

1. **Generalise `eclipse-recon/js/terrain.js` into a shared `assets/horizon.js`.**
   Full 360 degrees, fixed parameters, keyed by place rather than by question, so
   the output is an asset instead of a scratch result. Fix issue #81's sampling
   in the same pass. Eclipse Recon switches to consuming it and gets more
   accurate as a side effect.
2. **Golden Hour Recon, client-only**, as the second consumer, reusing the
   Leaflet pane, `weather.js` and `bessel.js`.
3. **Calibrate the adaptive grid rule.** The one permanent decision; happens
   before a single row is stored.
4. **The service.** Go single binary, `net/http` routing, `/v1/horizon`, read and
   submit, binary responses, immutable caching. Blocked on knowing what already
   runs on the Hetzner VPS: existing Postgres, reverse proxy, deploy method.
5. **Repoint the crawler** at the horizon store instead of committing PNGs.
6. **Photo refinement** last.
