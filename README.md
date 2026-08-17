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

No tool is above `fetch` today: eight never open a socket, four read public
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

- [Fourier Bench](fourier-bench/) — take a sound apart into the sinusoids it is
  made of. Drop in a file, record through the microphone, or start from a
  signal whose answer is already known. What comes back is a spectrogram with
  the window in your hands, and a table of partials at one moment: frequency,
  amplitude, harmonic number, note name and the cents it sits off that note.

  The transform is written here —
  [`fourier-bench/fourier.js`](fourier-bench/fourier.js) is a radix-2
  Cooley–Tukey butterfly with the real-input packing that halves the work, five
  windows, and the overlap-add that goes back the other way. No library parses,
  transforms or rebuilds anything.

  A bin is not a partial, and most of the arithmetic is about that gap. A
  440 Hz tone read through 11 Hz bins has no bin of its own: it appears as a
  hump a few bins wide whose tallest point is at 442 Hz and whose height is
  short by up to 1.4 dB. So frequencies are interpolated — by a parabola
  through the peak, and, where a partial holds still long enough for the two to
  agree, by the phase it advanced between frames — and every amplitude is
  divided by the window's measured response at the offset the partial actually
  fell at. That is the difference between a table that is roughly right and one
  that agrees with the closed forms to four decimal places.

  A spectrogram cannot be checked by looking at it, so the analysis is run
  backwards and the page plays the result. Splitting the spectrum into the bins
  under the peaks and every other bin gives two sounds that add back to the
  original at −152 dB, which is the arithmetic's own floor: whatever the sines
  do not hold has to be somewhere, and that somewhere is audible. It is where
  the breath, the bow, the hammer and the room went. Separately, the table of
  partials is played back through one oscillator each with the spectrum thrown
  away, and the page prints how far that lands from the original rather than
  asking for trust. Both are exported as WAV.

  The claims are asserted in
  [`fourier-bench/selftest.js`](fourier-bench/selftest.js) against three things
  that know nothing about this code: a naive O(n²) transform straight from the
  definition, the window figures Harris published in 1978, and the series
  Fourier published in 1822 — a square is odd harmonics at 4/πn and the bench
  is wrong if it disagrees. Twenty-two assertions, in the browser at
  [`tools/verify/fourier-bench.html`](tools/verify/fourier-bench.html) and
  under node with `node fourier-bench/selftest.js`, off one set.

  Where it does worst is on the page too. At an onset the sound changes inside
  the frame measuring it, and no single spectrum describes a frame in which the
  answer changed; shorten the frame and the onset sharpens while the partials
  blur together. The line under the spectrogram prints that trade as a product
  which does not depend on the frame size at all.

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

  Two pens mark up a page. A **highlighter** in six pastels is written as
  `/BM /Multiply`, which is what a real highlighter does — the pen is a filter,
  not a coat of paint, so the ink under it stays black and only the paper takes
  the colour. A **blackout** is the opposite claim: opaque ink, *and the page's
  own instructions rewritten with everything under it removed* — the glyphs,
  any image lying wholly inside it, any drawing that does.

  That second half is the whole point, and it is the part no screenshot can
  show: a black rectangle painted over a name hides it from a reader and from
  nobody else, because the characters are still in the file and the first text
  extractor to come along hands them back. The rewrite is a second pass over
  the content stream keeping the state the renderer keeps, since nothing in a
  content stream says where a glyph lands — that follows from everything before
  it. Runs of operators it does not change are copied through byte for byte, so
  an inline image's binary stays intact and the diff between a page and its
  redacted twin is only what actually went. A glyph goes when the blackouts
  cover more than a third of its box; a grazed character stays and is painted
  over, which is why the tool says to cover a little more than you need.

  Marks live in the page's own entry rather than in a layer of their own, so
  turning, moving and undo carry them without a code path each.

  Alongside it, a metadata panel in the same spirit as the image cleaner: every
  field the file discloses about whoever made it — title, author, the program
  and version, the timestamps, the XMP packet beside the document, the file
  identifier — each with what it gives away, and a switch per field.

  Because "covered" and "deleted" look identical on screen and differ only in
  the bytes, the claim is [checked against the saved
  bytes](tools/verify/pdf-toolkit.html) rather than asserted: a blackout's word
  must be absent from the file, a highlight's must survive, and the page must
  carry exactly one set of instructions. That last one is a bug that happened —
  the rewrite was correct and `/Contents` pointed at it, while the original
  stream stayed in the file as an object nothing referred to, so the page
  looked right and `strings` still found the words. The same assertions run
  under node with `node pdf-toolkit/selftest.js`.

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

  The distance is one number over the whole word, so the page also asks which
  of the letters is responsible for it: each one is taken out of the root in
  turn and the word asked again. Removing a letter can never raise the answer —
  an alphabet that sorts a word still sorts what is left of it — so where the
  answer falls, that letter was carrying weight. Not all of them are. *zebra*
  costs two swaps and only *e* and *b* are carrying them; drop the *z*, the *r*
  or the *a* and it still costs two. It is not a decomposition and the page
  says so: the drops do not add up to the distance, and *vortex* costs a swap
  that not one of its six letters accounts for on its own.

  The page then takes the word down as far as it goes: past the *root* — the
  word with its repeats removed — to the **core**, the shortest run of the
  root's letters, in the root's order, that still costs the same. *zebra* is
  two swaps and so is *ebra*; *deutsch* is three and so is *dutch*.

  Its length is the invariant. *Which* letters usually is not, so the page
  prints every core of that length rather than picking one, and they are
  clickable: putting one in the field and watching the number at the top of the
  page stay put is the demonstration. *vortex* costs one swap and seven
  different pairs of its six letters each cost that same swap on their own.
  Over random roots, 59% have more than one shortest core.

  It has to be searched for. Dropping free letters one at a time leaves a word
  you cannot shorten *by one*, which is not the same as the shortest one —
  *hozrmw* peels down to *zrmw* when *ozm* costs the same two swaps. What keeps
  that search small is the audit above it: every carrying letter is in every
  core, since a run that has already left one out costs less than the whole
  root does, so only the free letters are in question. Every root up to seven
  letters agrees exactly with exhaustion over all its subsets — same length,
  same count, same set — in at most 104 searches, and the survey's worst word
  takes 29.

  This is the only expensive thing on the page: one search per letter where
  everything else is one search, and something over a second on the longest
  words in the survey. So it runs in twelve-millisecond slices and fills in as
  it goes. Underneath, finding the core is a largest-droppable-set problem and
  there is no polynomial answer to those, so the engine publishes real cores at
  every level and only claims none is shorter once it has ruled that out. A
  page that runs out of patience — five seconds of searching, which no real
  word comes near and a pasted alphabet does — therefore still has a true
  answer, and says plainly that it is the shortest *reached* rather than the
  shortest there is.

  At the foot of the page the same question is asked of thirteen languages at
  once: every headword of thirteen Hunspell spelling dictionaries — 2,210,779
  words — run through that engine.

  There is no standard dictionary across languages. Every language has its own
  authority and none of them publish a free machine-readable word list; what is
  standard is the *format*, Hunspell, which is what LibreOffice, Firefox and
  Chrome all spellcheck against. The sources are pinned to one commit of
  [wooorm/dictionaries](https://github.com/wooorm/dictionaries), which
  republishes 92 of them with identical packaging, so the delivery is uniform
  even though the editorial policy behind each list is its own. That shows in
  the entry counts — Turkish carries 371,009 headwords and English 49,510,
  which is a difference in how two spellcheckers are built rather than in the
  size of two languages — and it is why every share on the page is of that
  dictionary's own total.

  Thirteen of the 92 and not more, for two reasons. The engine reads A–Z, so
  every dictionary in another script is out entirely; generalising it is
  possible, since `solve()` already takes the alphabet as a parameter, but a
  33-letter alphabet has further to travel than a 26-letter one and the answers
  would not belong on the same axis. Of the Latin-script rest, some fold badly:
  the Galician file does not parse as headwords at all, the Vietnamese one
  loses three quarters of itself the moment tone marks fold away, and Catalan,
  Romanian, Hungarian and Basque each lose 7–9% of their own distinctions.
  `tools/abecedarian-corpus.mjs` names what was dropped and why.

  Two figures, and they cut the same numbers the other way up from each other.

  The first has the distance on the x axis: one bar per number of swaps, and
  each bar is made of the dictionaries the switches are on, every one
  contributing the share of its *own* words that need exactly that many. So a
  segment is a percentage and reads straight off the bar, and the outline of
  the whole run is the distribution — all thirteen peak at two or three swaps.
  The bar's total is those percentages added together and is not a share of
  anything, which is why that axis counts in points rather than per cent.

  The second turns it over: one bar per dictionary, a hundred per cent of every
  word it holds, so the words no ordering sorts are in the bar too — and what a
  reader sees is how little of a dictionary the question even reaches. They are
  the loosest figure in the survey, running from 61.2% of English to 94.5% of
  Turkish: a language that builds long words by stacking endings on them puts
  nearly all of them out of reach. Sorted by the coloured band, English at the
  top down to Turkish at the foot, so the figure reads as one falling shape
  rather than thirteen unrelated bars.

  Only 5,617 of the 2,210,779 words are already abecedarian — 0.254%.

  The survey also asks what each of the two reductions merges, and they behave
  nothing alike. Taking the repeats out merges almost nothing: nearly every root
  in the survey stands for a single word, because collapsing repeats only ever
  joins spellings that differ in a doubled letter and a dictionary rarely
  carries both. A family is therefore a set of spellings rather than of
  meanings: in English the biggest are Roman numerals (`xi` covers *xi, xii,
  xiii, xxi, xxii, xxiii*) and name variants (*Aaron, Aron, Arron*).

  Going on to the core merges by the hundred — `oe` is a core of 185 English
  words — and yet does not shrink the vocabulary at all: there are *more*
  distinct cores in the survey than there are roots to make them, because about
  half the roots have more than one shortest core and each of those is a word in
  its own right. A core's count is how many words hold it among their shortest,
  so the families overlap on purpose and do not sum to the word count.

  The two use different colour vocabularies, and that is the point rather than
  an oversight: what a segment *is* differs between them. In the first a
  segment is a dictionary, so colour is an identity — four inks, because four
  is how many clear the colour-vision gates pairwise and there is no fifth. A
  language keeps its ink while it is drawn; picking a fifth evicts whichever
  has been drawn longest and hands over that one slot, so the survivors are
  never repainted. In the second a segment is a distance, where 3 comes after 2
  and the order *is* the meaning, so colour is an ordinal ramp: one hue in
  eight monotone lightness steps, checked as a ramp rather than as a palette
  (monotone lightness, every adjacent gap ≥ 0.06, the end nearest the sheet
  clearing 2:1 against it, one hue throughout). Eight steps is what those gates
  allow while the pale end stays off the paper, so it ends at "7 or more";
  "none" is not a distance and takes a neutral off the ramp entirely.

  In both, every segment present is drawn big enough to see and what that costs
  comes off the largest one — in the second always "none", which runs from 61%
  to 94% and can afford it — so the smallest classes stay visible. In the
  second the floor, the gaps and the margins all scale with the width
  available, because a minimum in pixels means something different on a phone.

  A third, logarithmic figure used to sit between these two and carried the far
  tail distance by distance. It is gone; the tail lives in the first figure's
  own bands, in the second's last ramp step, in the record rows, and in the
  table.

  Under both is the far end named: the worst word in each dictionary, and every
  word tying for worst where the tie is short enough to print — the record is
  ten swaps, held by German's *Exportschiffbau* and *gastfreundlich* and
  Norwegian's *storbymeldinga* and *sympatibølgjer*. Any of them can be
  clicked, which puts it in the field at the top and works it out; the words
  are findings rather than a shelf of examples, which is why they sit at the
  end of the survey and not beside the field.

  Whatever is in the field is marked on both: a hairline down its band in the
  first, an outline round the band it falls in on the second.

  The counting is a build step, not a fetch:
  [`tools/abecedarian-corpus.mjs`](tools/abecedarian-corpus.mjs) surveys the
  thirteen lists offline — about eight minutes, Polish and Czech half of it —
  and writes the tallies to [`abecedarian/data/`](abecedarian/data/), a couple
  of hundred numbers rather than forty megabytes of word lists, which keeps the
  tool on `local`. It asserts its own arithmetic before writing: that each
  histogram sums to the sortable count, and that the record and the words
  holding it match the histogram's last column. Neither the inks nor the ramp
  are pressed from the site's plates: the plates are the index's category
  vocabulary, and green beside red is the one pair a red-green reader cannot
  separate. The inks were searched for against lightness, chroma, contrast and
  colour-vision separation over all six pairs, then searched again for the
  quietest set that still clears it; the ramp is an ochre at hue 70, which
  keeps the scale clear of all four of them.

  Under everything is the table, which is the figures' twin: a row per
  dictionary, counts only, one number to a cell. The figures work in two
  different denominators, and a table that printed a percentage would have to
  pick one of them and then explain which — counts need no denominator, and
  every share either figure draws can be got from them.

- [Neuron Bench](neuron-bench/) — build a neural network a neuron at a time and
  watch what each one adds. It starts where the whole subject starts: one neuron
  with an identity activation is a linear regression, and the page does not ask
  to be believed about that. It fits the closed-form least squares line on
  exactly the rows the network trains on and prints both answers side by side,
  where they agree to every digit shown.

  Then it takes that apart. A straight line cannot follow a curve, so the same
  neuron visibly settles for the best straight line and stops. Four points
  arranged as XOR cannot be split by any straight line, so one neuron sits at
  50% and a loss of exactly ln 2 — the loss of a model that has given up — while
  two hidden units solve it outright. A third lesson runs that same two-unit
  network from a different seed and it stays stuck at 50% forever, because two
  is the bare theoretical minimum for XOR and lands in a local minimum from many
  starting points. Solvable in principle and solvable in practice are different
  claims, and the page makes both.

  Four of the eleven lessons are failures, on purpose, because most of what is
  worth knowing here is a failure mode. Turn normalisation off and planting
  years near 1990 against trunk circumferences near 100 cm produce gradients so
  mismatched that no single learning rate works. Run ReLU at a learning rate of
  4 and seven of eight units go permanently silent — a unit pushed negative for
  every input has a gradient of exactly zero from then on — which the panels
  show as seven blank squares and one doing all the work. Start every weight at
  zero and all eight units receive identical gradients forever, so eight
  neurons have the power of one and every panel is the same picture. Starve a
  twelve-hundred-weight network of rows and the two loss curves separate:
  training loss falling while held-out loss turns upward.

  Underneath each plot is one panel per hidden unit, and the units of a layer
  share a colour scale rather than each being stretched to its own range. That
  is the difference between a picture and a lie: scaled individually, a unit
  contributing nothing looks exactly as strong as the one carrying the layer,
  and a dead unit looks busy. Above two inputs there is nothing to draw a
  boundary on, which is the ordinary case rather than a special one, so the
  panels become the unit's actual weights and the main plot becomes a confusion
  matrix or a predicted-against-actual scatter.

  The data is the Vienna [Baumkataster](https://www.data.gv.at/datasets/c91a4635-8b7d-43fe-9b27-d95dec8392a7?locale=en)
  — 53,740 trees across the eight commonest species — reached for through four
  problems: the ash regression this began as, a two-input surface, one pair of
  species that genuinely overlap so that no network gets them fully apart, and a
  four-way classification with no picture available. Six synthetic sets whose
  right answer is known in advance sit alongside them, and any CSV can be
  dropped in.

  The network, the training, the plots and the solver are written from scratch.
  Training runs in a Web Worker — the first on the site — so the tab stays live
  and there is no ceiling on how large a network someone wants to try. The
  gradient is checked against finite differences on every activation and loss
  pairing the interface can produce, in
  [`js/selftest.js`](neuron-bench/js/selftest.js), which also runs under node.

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
  Elements block from its NASA/GSFC page. The shipped catalogue is every solar
  eclipse from 2026 to 2035, read off those pages.

  The map is drawn from elevation alone, with water as the palest tone and land
  darkening in altitude steps. Scores use viridis rather than the site's
  plates: it is perceptually uniform and legible under every form of colour
  vision, and the field is data rather than page furniture. Works on a phone.

- [Eclipse Countdown](eclipse-countdown/) — the same arithmetic applied to a
  narrower question: from a given place, when is the next eclipse and what will
  it look like? A clock counts down to each phase beside a drawing of the Sun
  at the moment on the clock, with the Moon at its true separation and position
  angle and the horizon at true scale, so a Sun that sets mid-eclipse is drawn
  setting. Below, every phase with its local time, UT and Sun altitude. A
  preview plays the whole eclipse in 15 seconds.

  Above that sits every eclipse on file as a strip of cards, each drawing the
  Sun that eclipse leaves at your own place — total, annular, a graze, or
  nothing at all where the shadow misses. Picking one moves the whole report to
  it, and the pick travels in the link. The catalogue holds every solar eclipse
  from 2026 to 2035, partial ones included.

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
| workshop deviations | [`assets/site.css`](assets/site.css) | the complete list: halftone screen, the tilt, the ceiling lamp, the drawing surface's ground |

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

The mode control is the workshop's own, and it is the **ceiling lamp**: a
pendant hung on a flex from the top edge of the page, throwing its light down
the sheet to the spine. Light mode is the lamp on; dark mode is the lamp off and
the room with it. It replaces both of the system's mode controls — the swatch
and the pull cord — because once the light itself is drawn, a cord reaching for
an undrawn light is the smaller half of the same idea.

It is drawn in [`assets/site.css`](assets/site.css). The drawing is an inert
`span` at `z-index: -1`, so the light passes *behind* the wordmark instead of
washing over it, and the switch is a separate `[data-mode-toggle]` button over
the shade, which `mode.js` answers. The beam is not drawn to length: it is a
long box aimed well past the spine and cut there by the header's own
`overflow: clip` — `.masthead` on the index, `header` on a tool page — which is
what lands the light on the line at every width and at every angle.

**It swings.** Take hold of the shade and pull, and the fixture follows the hand
and then goes on swinging when it is let go: a real pendulum, integrated at
frame rate, so the period comes out of the drawing's own size — √(L/g), and the
half-size lamp on a phone swings half again as fast. The shade is hinged on the
end of the flex and lags it slightly, the way a weight on a cord does; the beam
is rigidly attached to the shade, so the pool of light on the spine slides and
lengthens as the lamp leans. The swing is bounded by the room the page has for
the LIGHT, measured at the press, so the beam never runs off the edge of the
header. A press that does not move is a click and flips the mode as before,
plus the shove the finger actually gave it — off-centre, so the rim rocks the
lamp and the middle does not.

Three scripts are the workshop's own. [`assets/lamp.js`](assets/lamp.js) is the
swing and nothing else: the mode still belongs to `mode.js`, and with the file
missing or under `prefers-reduced-motion` the lamp simply hangs straight and the
switch still works. [`assets/share.js`](assets/share.js) backs the
`[data-share]` button beside each tool title, which copies that tool's address.
[`assets/favourites.js`](assets/favourites.js) backs the pin: a `[data-pin]`
button toggles its tool in a `localStorage` list under `workshop-pinned`. The
script only sets a class; the sorting is two CSS rules, because a pinned tool
moves to the front of its category and its category to the front of the page.
The index and the tool pages read the same list.

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
   `../assets/preprint/js/controls.js`, `../assets/lamp.js`,
   `../assets/share.js` and `../assets/favourites.js`. The tool's script goes
   first, so anything it builds at startup is in the DOM when the controls are
   drawn.
4. Give the page the shared header: a `.back-link` and a `.title-row` holding
   `h1.tool-title` plus the `[data-share]` and `[data-pin]` buttons, which key
   off the folder name. Copy the `.lamp` span and the `.lamp-switch` button
   from another tool as the first children of `<header>`: the lamp hangs off
   that element's top edge and is clipped by it, which is why the page's top
   padding belongs to the header and not to `.wrap`. Copy the span whole — the
   rose, the flex, the head and the beam are four elements that turn about two
   points, and `assets/lamp.js` measures the geometry off them.
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
