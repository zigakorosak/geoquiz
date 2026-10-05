# Mistakes & Lessons

A working reference for the assistant. `DESIGN.md` says what the code is;
`LOG.md` says what changed and why; this file says **what went wrong in the
process of getting there**, so the same time and tokens don't get spent
twice.

Read this before starting a debugging round, especially a visual/rendering
one. Add to it whenever something takes more than one attempt.

---

## The single biggest lesson

**A bug reported twice means the theory is wrong. Stop theorizing and go
measure.**

The pin-mode "borders are visible" bug took **five rounds** and easily the
largest share of tokens in the project's history. Rounds 1–4 were each a
plausible mechanism, a confident fix, and a write-up — and each was wrong
or incomplete. Round 5 started by building actual visual ground truth
(rasterize the real SVG, analyze the pixels) and found the cause in one
pass.

Every round 1–4 cost more than round 5 did. The measurement tooling would
have paid for itself immediately.

**Rule:** the second time a user re-reports the same symptom, the next
action is *not* another fix. It's building a way to observe the actual
output.

---

## Verification playbook (things that worked — reach for these first)

### Rasterize and *look* at it
`rsvg-convert` is available locally, and the `Read` tool displays PNGs.
This is the highest-value tool for any rendering bug.

```bash
rsvg-convert -w 800 -h 500 in.svg -o out.png   # then Read out.png
```

Serialize the *real* `WorldMap` output rather than rebuilding an
approximation by hand — a hand-built "equivalent" SVG showed no bug while
the real one did, because the approximation didn't reproduce the real DOM.

Two gotchas when serializing for `rsvg-convert`:
- It does **not** resolve CSS custom properties. Substitute `var(--x)` with
  literal `:root` values first, or everything renders black/none.
- It needs `xmlns:xlink` declared, and the stylesheet wrapped in `CDATA`.

### Distinguish "real" from "artifact" programmatically
A naive scanline detector flagged every antialiased coastline pixel and was
useless. A **flood-fill from the image border** cleanly separated genuinely
enclosed interior gaps from real bays and straits.

### Measure incrementally, printing each step
For "which input dominates this result", exclude one item at a time and
print the metric:
```
baseline 184 → +Russia 291 → +France 442 → +Norway 476 → +Netherlands 734 → +Portugal 848
```
This found outliers (France/Netherlands bundling overseas territories) that
guessing would never have surfaced.

### Always check a control
When changing shared code, verify the *unaffected* path is bit-for-bit
unchanged (non-pin mode still builds 241 paths; World's `scaleExtent`
identical). Several times this was the thing that proved a fix was scoped
correctly.

---

## Recurring mistake patterns

### 1. Asserting instead of computing
Happened **twice**, the second time two rounds *after* writing this file:

- Claimed per-country paths stayed invisible in pin mode because "unpainted
  shapes don't receive pointer events" — never checked.
  `.world-map--clickable .country:not(…):hover` is specificity **(0,4,0)**
  and outranks `.world-map--pin-mode .country` **(0,2,0)**.
- Fixed "clicking the pin doesn't confirm" by cloning the hit-area circle
  into each ghost group and attaching a listener — without checking whether
  the clone could receive events at all. It couldn't:
  `.world-copy--ghost { pointer-events: none }` is inherited, and the clone
  had no class re-enabling it. Shipped a no-op fix and said it was done.

**Rule:** if a fix depends on a specificity / inheritance / precedence
claim, compute it explicitly. And after wiring a listener, verify the
element can actually *receive* the event — attaching one proves nothing.

### 1b. Explaining a symptom instead of fixing it
A stray grey triangle at the India/Pakistan/China trijunction was reported;
I looked it up, correctly identified it as Siachen Glacier (an id-less,
deliberately-excluded topology shape), and reported it as working as
designed. It was re-reported. It was in fact a regression *I* had
introduced hours earlier — a two-layer pin-mode landmass that painted
id-less shapes muted. The identification was right; the conclusion was
wrong.

**Rule:** correctly naming what a thing *is* doesn't answer whether it
*looks wrong*. If a user reports a visual defect, "that shape is
legitimate" is not a resolution — check what changed in how it's rendered,
especially against your own recent diffs.

### 2. "This can only help" — verify the direction of the effect
Added an 8px matching-color stroke to bury sliver artifacts, reasoning "a
stroke can only *add* coverage." True for a **gap**; exactly backwards for a
**hairline artifact**, which it made 8px thick and far more visible. The
"fix" amplified the reported symptom.

**Rule:** before widening/padding/thickening anything, state what the
defect actually *is* (missing pixels vs. extra pixels). They need opposite
fixes.

### 3. Changing event flow without tracing the whole path
Added `stopPropagation()` to stop a confirm click from re-dropping the pin.
It also stopped the click reaching `game.js`'s root listener, where
`suppressNextRootAdvance` was waiting to consume it — so the flag survived
and ate the *next* click. Result: rounds cost 4 clicks instead of 3.

**Rule:** `stopPropagation()` in a codebase with delegated/root listeners is
a cross-module change. Grep for who else depends on that event arriving.
Prefer a scoped one-shot flag over killing propagation.

### 4. Forgetting siblings in an element "family"
Twice, an element was added without the treatment its siblings already had:
- `capitalMarker` — never added to the zoom counter-scaling handler that
  `pinMarker` and `pinConfirmHitArea` had → it scaled with zoom.
- `pinConfirmHitArea` — never given a ghost `<use>` clone though `pinMarker`
  had one → clicking a ghosted pin didn't confirm.

**Rule:** when adding to a group of elements with shared per-tick or
per-copy handling, grep every site that enumerates the family
(`_makeUse(this.`, the `"zoom"` handler, `_reflow`'s re-projection block)
and confirm the new element belongs or explicitly doesn't.

### 5. Baking zoom-dependent values into static geometry
`HULL_PADDING` (3px) was applied once into a `<polygon>`'s points, then the
whole group got scaled by the zoom transform — so at 50× it rendered ~150px
and swallowed the country's own border. Strokes avoid this via
`vector-effect: non-scaling-stroke`; **geometry has no such escape hatch**
and must be counter-scaled by hand (`value / transform.k`) on every tick.

**Rule:** any constant expressed in px inside the zoomed `<g>` — padding,
radius, offsets — is a screen-size bug waiting to happen. Circle radii and
polygon points both need explicit `/ k`.

### 6. Calibrating a threshold at one viewport size
A sliver filter using an absolute `< 2px` thickness cutoff worked at
800×500 and silently let an artifact through at 1920×1080, because
`fitSize` scales everything. Switching to **aspect ratio** (scale-invariant)
fixed it permanently.

**Rule:** prefer scale-invariant measures (ratios, aspect) over absolute px.
If absolute px is unavoidable, test at ≥3 viewport sizes including a
portrait one.

### 7. Filtering by the wrong property
Considered removing merge artifacts by **area** — but Vatican City's true
area is *smaller* than several artifacts, so any area threshold that caught
them all would delete real countries. **Elongation** separated them cleanly
(artifacts 361:1 and 2799:1; widest real feature, Antarctica, 11:1).

**Rule:** before thresholding, print the sorted distribution for both the
things to keep and the things to drop, and confirm there's an actual gap.

### 8. Overclaiming in documentation
Wrote "not a mitigation, a structural fix" about the merge approach — and
was then proven wrong twice by remaining artifacts.

**Rule:** docs should say what was verified, not how confident it felt.
Avoid "fixes this entirely / can never recur" unless it's been exhaustively
checked.

### 9. Reaching for DOM hit-testing where geometry would do
"Click the pin to confirm" was built as an invisible circle over the pin
and cost **three rounds**: it only existed on the home copy (but wrap
ghosts often render the visible pin), then its ghost clone couldn't receive
events, and along the way its `stopPropagation()` broke the click-count
elsewhere. Replaced with a distance check inside the existing whole-map
click handler — which already folds clicks into home-copy coordinates, so
one comparison covers home and every ghost. That deleted the element, its
clone, its per-tick radius scaling, its CSS, and a state flag.

**Rule:** when the click handler already has the coordinates, prefer
`distance(click, target) <= r` over adding an element and delegating to the
browser's hit-testing — especially where `<use>` clones, shadow trees, or
inherited `pointer-events` are involved.

### 10. Trusting a test that can't fail
A full click-flow test passed while the bug was real: **jsdom has no
geometric hit-testing**, so `el.dispatchEvent(click)` always "hits" `el`
regardless of where it actually renders. That's exactly the class of bug
(wrong element under the cursor) the test appeared to rule out.

**Rule:** ask what a test would do if the bug were present. If dispatching
directly on the element under test, hit-testing is assumed, not verified —
check structurally instead (does the clickable element exist in the right
group?).

### 11. Trusting a manual zoomBehavior.transform() call in a test script
Called `zoomBehavior.transform(...)` directly to zoom a render script in
on a target country. That triggers d3-zoom's *real* start/zoom/end
gesture lifecycle (unlike the constructor's own `_suppressGestureHooks`
dispatch), which engages frozen-zoom — the intended "zoom" never actually
applied to the rendered geometry, only to a CSS `transform` on the `<svg>`
that (a) needs 200ms to bake, which a short script never waits for, and
(b) `rsvg-convert` doesn't reliably honor on the root svg element anyway.
Spent real time analyzing a crop as "France and Switzerland" that turned
out — confirmed only after cross-checking with `_findContainingId` — to
be Chad and Sudan.

**Rule:** in a test/render script, set the desired view via
`initialTransform` on the constructor (applied through `_reflow`'s own
suppressed dispatch), never via a post-construction `zoomBehavior
.transform()` call — that path is gesture-shaped by design, and this
project made zoom gestures deliberately expensive to fake.

### 12. Eyeballing a thin stroke through a compressed raster
Even with the zoom fixed, comparing a 1.5px colored stroke against a
0.5px dark one — through PNG compression, `Read`-tool display scaling,
and a busy coastline — was genuinely inconclusive by eye, in both
directions, across several crops. Kept staring at pixels instead of
switching approach sooner.

**Rule:** when a fix is a *precedence/ordering* claim (this one: which
DOM sibling paints last), don't stop at "does it look different" —
compute the ordering directly (index among siblings, or whichever
property the fix claims to change) and check it against every case that
matters (here: all 238 countries, not just the one being stared at).
Pixel comparison is for confirming *geometry* is right (shape, gaps,
holes); z-order/precedence bugs are cheaper and more conclusive to prove
structurally.

### 13. No real browser in this environment — plan around it, don't fight it
A hover cue built on plain CSS `:hover` was reported broken past a
certain zoom level. `which`/flatpak/snap/a filesystem search all turned
up no Chromium/Chrome/Firefox binary — genuinely nothing to drive, not
just nothing already configured. jsdom can't fill the gap either (no
real hit-testing — see #10). Spent real effort on structural elimination
(every zoom-dependent code path, checked for exceptions/NaN/CSS
overrides) before accepting the exact browser-internal cause was
unprovable here, one useful signal survived: clicking the same elements
kept working, only `:hover` broke — meaning whatever it was, was
specific to continuous pseudo-class re-matching, not hit-testing in
general.

**Rule:** when a report needs a real browser to directly observe and
none is available, don't keep spending turns theorizing toward a
confirmation that can't happen here. Use whatever *does* distinguish the
hypotheses (here: does clicking still work?) to point at the smallest
robust fix, then replace the suspect mechanism with one already proven
in this codebase (geometric containment, not DOM hit-testing — #9)
rather than patching the CSS and hoping. Verify the replacement
structurally instead (correctness at the reported zoom level, class
toggling, coalescing, perf headroom) — all provable without a browser.

---

## Environment gotchas (recurring time sinks)

### Inner-SVG elements don't reliably composite (Chromium)
Two rounds of zoom-perf work put `will-change: transform` on inner SVG
`<g>` groups and trimmed per-tick JS — and the lag survived, because the
actual cost was the browser repainting the whole path scene per tick:
Chromium largely ignores `will-change` layerization for *inner* SVG
elements. The fix that worked composites at the boundary the engine
respects — a CSS transform on the `<svg>` element itself (or an HTML
wrapper) during the gesture, baked into inner transforms once at settle.

**Rule:** for per-frame SVG pan/zoom, never expect inner `<g>` transforms
to be cheap. Freeze the SVG and apply the gesture delta as a CSS
transform on the svg/HTML container, then bake on settle. And keep zoom
listeners on an *untransformed* ancestor — d3's pointer math reads the
listener element's rect.

### jsdom harness boilerplate
```js
const dom = new JSDOM("<!doctype html><div id=c></div>");
global.window = dom.window;
global.document = dom.window.document;
global.ResizeObserver = class { observe() {} disconnect() {} };
global.SVGElement = dom.window.SVGElement;
global.performance = { now: () => Date.now() };  // NOT dom.window.performance
```

- `global.performance = dom.window.performance` **infinitely recurses**
  (jsdom's impl delegates back to `global.performance`). Use a plain stub.
- The per-round `setInterval` timer keeps node alive → end scripts with
  `process.exit(0)`.
- Scratch scripts must live **in the project directory** (or be run with cwd
  there) or `import "jsdom"` won't resolve.
- `npm install --no-save X` followed by `npm uninstall X` **prunes jsdom**.
  Re-install with `npm install --no-save jsdom` when imports start failing.

### Scratch script hygiene
Write them in the project root as `scratch-*.mjs`, and `rm -f` them in the
same turn they're finished with. (Established convention — `LOG.md` entries
say "deleted after, per usual".)

---

## Project-specific traps

- **`item.latlng` is a country centroid, not its capital.** Australia's is
  in the outback, nowhere near Canberra. Capital coordinates live in
  `capitalLatLng` (joined from `cities.json`).
- **`null` from `onSelect` means "no selection yet"** and disables Confirm.
  A definite-but-wrong answer must report a sentinel, never `null`.
- **Wrap ghost copies are not decorative.** A region's *default* framing can
  render via a ghost with zero panning (Asia does). Anything clickable needs
  a ghost clone with a listener.
- **`topojson.merge()` needs raw arc-level geometries**, not `feature()`
  output — that's what lets it dissolve shared borders. It also emits a
  couple of degenerate hairline artifacts that need filtering.
- **Region ≠ crop** (since the one-map refactor). Regions are `focusIds`
  (framing) + `playableIds` (muting). Don't reintroduce cropping.

### Browser-drive the real map for hit-testing bugs (Oct 2026)
"Can't select Singapore in region mode" was *not* mode-specific — jsdom
measurements of hulls/areas all looked fine and theorizing about the
region widget went nowhere. Ground truth came from Playwright
(devDependency now) driving the real app: the visible Singapore was a
*ghost copy*, and ghost clicks resolved geometrically with no hull
assist. Two sub-lessons:
- When sweep-testing clicks across all countries, bbox centers and
  "first grid point inside fill" both land on border pixels and produce
  dozens of false FAILs (plus antimeridian features where isPointInFill
  over the bogus full-width bbox lies). Use the deepest-inside grid
  point, and re-verify survivors zoomed-in at real coordinates before
  believing any of them.
- The hull hit-areas render above all country paths and their Voronoi
  clip bounds them at center midlines, not real borders — browser
  hit-testing therefore let Denmark's hull steal clicks on German soil
  long before this round. Any future hit-area change must keep DOM
  hit-testing and WorldMap._resolveIdAt agreeing, since ghosts use only
  the latter.

### "Can't select X" — pin down WHICH mode before measuring (Oct 2026)
"Can't choose Monaco in region select mode": a long round of map-click /
region-click probes (wheel, touch, pinch, live site) all showed Monaco
selecting fine. The likely real mode was drop-a-pin scored by Region,
which resolves by exact polygon containment with no assist at all.
Probe pitfalls hit along the way, each producing fake failures:
- In-game taps with a decoy that missed land (off-screen or ocean) made
  the next tap a re-click → confirm → advance cycle ("-,-,492" pattern).
  Use a click recorder (patch `WorldMap.prototype.setClickable` on the
  module URL the app actually loaded — vite adds `?t=`), or a decoy
  computed to sit on a neighbor's fill.
- Synthetic clicks round to whole px; at k=1 one px ≈ 33 km, so pin
  tests must zoom in first.
The same sweep surfaced a real, older bug: lon/lat point-in-polygon on
antimeridian-crossing rings (Russia, Fiji) treated them as globe-wide
latitude bands — pins/ghost clicks/hover in N Canada, Norway, Finland,
Iceland, Greenland → Russia; N Australia → Fiji. Fixed by unwrapping
such rings (`unwrapRing` in WorldMap.js).
- Follow-up: the actual Monaco complaint was desktop — "hover shows it,
  click does nothing". Cause: d3-zoom's default `clickDistance(0)`
  swallowed any click with ≥1px of mouse drift. Every earlier probe used
  perfectly still synthetic clicks, so none could see it. When testing
  clicks, ALWAYS include a jittered press (down → move 1–3px → up).
- Second follow-up: still broken for the user because they use FIREFOX
  (the only browser on this machine) and every probe ran Chromium.
  Firefox reports clicks on ghost <use> content with the <use> as
  event.target; the svg listener's `target === svg` guard dropped them.
  Lesson: on a "still broken" report, ask/verify the user's browser and
  test in it — `npx playwright install firefox` works here.
