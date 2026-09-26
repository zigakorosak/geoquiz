# Project Log

Newest entries at the top. See `DESIGN.md` for the architecture this log
refers to.

## 2026-09-26 — zoom-out overscan margin: the shrinking-raster gap goes away

Follow-up to the frozen-zoom round below: fast is fixed, but reported as
"zoom out looks weird, I want the whole screen constantly filled" —
zoom-in was already fine.

Diagnosis: the frozen raster is a picture of exactly what was on screen
at gesture start. Zooming OUT means CSS-scaling that picture down, which
shrinks it toward its own top-left corner — the area it stops covering
has nothing behind it. It's not a literal color mismatch (`.world-map`
and `.world-viewport` already share the ocean color), it's that a map
visibly shrinking into a smaller floating picture doesn't read as "the
map," even where the surrounding area happens to be the right color.
Zoom-in never showed this because growing a raster overflows the
wrapper (clipped), never falls short of it.

Fix: give the svg's own rendered box — and its viewBox — real margin
beyond the wrapper's visible window (`ZOOM_OVERSCAN_RATIO = 0.75`, so
75% extra on every side), positioned with a compensating `left`/`top`
offset so its content still lines up with the wrapper exactly at rest.
This isn't new content — the full dataset (and, horizontally, the ghost
copies) was already in the DOM at every zoom level; overscan just changes
how much of that existing scene the svg's own box reveals. So a zoom-out
gesture now keeps showing genuine geography instead of a static picture,
degrading only past a real burst (tolerance: `scale ≥ 1/2.5`, i.e. more
than a 2.5× zoom-out within one ~200ms gesture).

The one piece of actual new math: overscanning means the frozen-zoom CSS
transform's delta formula (`translate(...) scale(...)` on the svg) needs
a correction term. Derived by expanding `screen = boxPosition +
D(pixelInBox)` against the desired `screen = t.x + t.k·worldX` (full
algebra in `ZOOM_OVERSCAN_RATIO`'s own comment): `-margin·(scale−1)` per
axis, on top of the existing `t.x - scale·b.x`. This is exact at any
scale, not an approximation scoped to zoom-out — skip it and the map
drifts by hundreds of px at ordinary zoom factors, zoom-in included,
which is why it's applied unconditionally rather than only when shrinking.

Nothing else needed to change. The click handler, wrap-period math, ghost
translate math, hit areas, and `_defaultTransform` all already treated
the wrapper's own `getBoundingClientRect()` as the true `[0,width]×
[0,height]` window (unrelated to the svg's own box size) — margin only
had to be threaded through the one place that measures the svg's box
directly, the CSS transform delta.

Verified: overscan sizing (`_overscanX`/`Y`, viewBox, svg left/top/width/
height) matches the ratio exactly; a click landing mid-frozen-gesture
still resolves to the correct country (the real correctness proof, not
just that the numbers look right); the CSS transform's actual value
matches the derived formula recomputed independently; settle still bakes
and clears correctly with overscan in place; a resize recomputes the
margin and clears any in-flight freeze first; the wrap-seam pin-confirm
case and the identity-projection (US states, no wrap) path both still
work mid-frozen. All 10 wizard/gameplay e2e paths green, zero window
errors. `npm run build` clean.

## 2026-09-26 — frozen zoom: gesture ticks moved off the SVG entirely

Reported: still laggy when zooming fast, after two prior rounds of zoom
perf work. The diagnosis this time reaches the actual bottom: our JS per
tick was already near-zero, so the remaining cost had to be the browser's
own paint — and it was. Per-tick transform updates on inner SVG `<g>`
elements repaint the full ~240-path scene, because browsers (Chromium in
particular) don't reliably compositor-promote *inner* SVG elements even
under `will-change` — which is why the previous round's
`will-change: transform` on the copy groups helped less than expected:
the hint was being applied somewhere the engine largely ignores it.

The fix is the standard slippy-map technique. When a live gesture changes
`k`, the map freezes: inner groups keep the gesture-start transform, and
every further tick is a CSS transform on the `<svg>` element itself —
an ordinary compositable box in every engine, so each tick is pure
compositor work, zero SVG repaint. The delta is chosen so composed
positions equal `currentTransform` exactly, so clicks keep working
mid-gesture (verified). At settle (200ms), `_bakeFrozenZoom` applies the
final transform to the inner groups — the one vector repaint per gesture,
which is also what sharpens the view — and re-syncs d3's internal
transform if the deferred wrap-snap moved x (snapping mid-gesture would
visibly jump the frozen raster by a world-width; on the live path ghosts
mask that, on a frozen raster nothing does).

Structural consequences, each with a reason:
- A new untransformed `.world-viewport` wrapper hosts the zoom listeners
  — d3 reads pointer coordinates from the listener element's own rect,
  which must not move while the svg is CSS-transformed. It also clips
  and paints ocean, so the areas a scaled-down raster stops covering
  read as more ocean (not page background) until settle.
- The click handler's coordinate origin moved to the wrapper's rect for
  the same reason.
- `_reflow`'s programmatic transform dispatch (and the bake's own
  re-sync) suppress the gesture hooks — without that, construction
  itself entered frozen mode and the first paint spent 200ms blurry.
- Pure pans (k unchanged) stay on the live repaint path on purpose:
  measured acceptable, and they never show edge gaps.
- The prior round's `.world-map--gesturing .world-copy { will-change }`
  rule is gone — superseded, and per the above, largely inert anyway.

Trade-offs accepted, per the explicit "does not have to be instant"
guidance from the blur round: mid-gesture the view is a scaled raster
(blurry, and a fast zoom-out shows ocean beyond what was on screen at
gesture start), sharpening and filling in at settle.

Verified via jsdom, driving real d3 gesture dispatches: construction not
frozen; a zoom tick freezes (class on, inner transforms untouched, CSS
delta on the svg) and a second tick reuses the same base; a click
mid-frozen resolves to the right country; settle clears the CSS, bakes
k into the inner groups, restores marker radii, re-syncs d3 after a
forced wrap-snap; pure pans never freeze and update inner transforms
live; a reflow mid-freeze bakes first; destroy removes the wrapper. All
10 wizard/gameplay e2e paths green, zero window errors. `npm run build`
clean.

## 2026-09-26 — ghosts collapsed to one <use> each; round-world pin distances; Australia id bug resurfaced and fixed at the root

Two asks: zoom still "feels like it is loading" rather than snappy, and
pin-mode distances must treat the world as round — a pin in Chile aiming
at Australia should measure (and draw) across the Pacific, not the long
way over the map interior.

**Snappiness: ghost copies are now one element each.** The gesture-scoped
`will-change` from the previous round made zoom sharp-after-settle, but
promoting the layers at gesture *start* still rasterized everything —
and the bulk of "everything" was the ghost copies' ~480 per-country
`<use>` clones. Restructured: all home content moved into an inner,
untransformed `contentGroup` (the transform stays on the `homeGroup`
wrapper — referencing homeGroup itself would clone its transform and
double-apply it), and each ghost is now a single `<use>` of that group.
~480 rasterizable ghost elements → 2. Bonus: ghosts now mirror home
content *by construction* — the "forgot to clone the new element into
the ghosts" bug class (bit twice before: pin-confirm hit-area, capital
marker) is structurally gone. Ghost clicks, which previously rode on
per-clone listeners, are resolved geometrically instead: ghosts are
fully inert, a click over one falls through to the `<svg>` itself, and
the whole-map listener (now installed in every mode, not just pin mode)
folds x into the home period and runs `_findContainingId` — home paths
and hit-areas are more specific event targets and still handle their own
clicks, so nothing double-fires; ocean/terrain resolve to null and no-op.

**Round-world distances.** Three distinct fixes, found by testing the
actual Chile→Australia case rather than assuming one patch would do:

- *Longitude branch normalization* (`nearestPointOnSegmentKm`): segment
  endpoints are shifted ±360° onto the pin's own branch before the
  closest-point math, so the search measures across the antimeridian
  when that's shorter. (The capital distance needed nothing: haversine
  is periodic in longitude and always was shortest-path.)
- *Great-circle measurement*: with the branch fixed, the reported
  distance was still ~3,000km off — the local tangent-plane
  approximation is documented as short-range and at 140° of longitude it
  isn't one. The planar math now only picks the candidate point on each
  segment (error bounded by the segment's own few-km length); the
  distance to it is measured with `haversineKm`.
- *The `_geometryById` id collision*: still 14,521km vs a hand-computed
  true minimum of 8,961km — because the lookup map kept only the *last*
  feature per id, and Ashmore and Cartier Is. shares Australia's "036"
  (the exact quirk the hit-area pass has guarded against since the
  hitbox-audit round; this second map wasn't guarded). Every Australia
  reveal/distance was measuring against the tiny islet — including pin
  mode's post-confirm reveal, which drew the islet instead of the
  mainland. Same-id features are now merged into one MultiPolygon at
  construction, fixing containment, nearest-border, and the reveal
  outline in one place. (True nearest point from Chile turns out to be
  Macquarie Island at ~8,961km — genuinely part of Australia's polygon.)

The reveal line and capital marker draw the short way too:
`_projectWithWrap` converts a branch-shifted longitude into ± one
world-width of projected x, i.e. the line points into the neighbouring
ghost copy across the seam (verified: Chile→Australia line exits past the
home copy's left edge; capital marker lands at negative x in the left
ghost).

Verified end to end: Chile→Australia border reads exactly the
hand-computed 8,961km; Chile→Canberra 11,160km; Madrid→France still
~351km and inside-France still 0; ghost-position clicks in map-click mode
resolve to the right country with home-path clicks firing exactly once
and ocean clicks not at all; pin-mode's Australia reveal now includes the
mainland; all 10 wizard/gameplay paths green with zero window errors.
`npm run build` clean.

## 2026-09-26 — blurry-after-zoom fixed by scoping will-change to gestures; hull re-pad moved off live ticks

Reported: zooming in leaves the map blurry until a pan sharpens it, and
fast zooming still lags.

Both trace to the same thing: `will-change: transform` sat on the copy
groups *permanently*. That promotes each copy to a compositor layer, so a
zoom scales the layer's cached raster — cheap (good mid-gesture) but
inherently blurry when scaled up, and with the hint never removed the
browser had no reason to ever re-rasterize. The pan "fixing" it was just
an unrelated invalidation forcing the repaint that should have happened on
its own. This is the textbook just-in-time `will-change` pattern applied
backwards, and the fix is to turn it the right way around: a
`.world-map--gesturing` class (toggled from d3-zoom's own start/end
gesture events) carries the hint only while a gesture is live, and a
debounced settle (`GESTURE_SETTLE_MS` = 200ms, deliberately longer than
d3's ~150ms wheel-idle so a multi-notch wheel zoom is one gesture, not a
layer-thrash per notch) drops it afterwards. De-promoted, the SVG renders
as plain vectors through the current transform — sharp at any zoom by
construction. Explicitly per the request: sharpening a beat *after* the
gesture, never during it, so it costs no frames while moving.

The settle callback (`_onGestureSettle`) also took over the assist-hull
re-padding — the ~80-polygon `points` rebuild that previously ran on live
zoom ticks (throttled to 2% k-steps, still ~25 times across a 2x pinch).
It now runs exactly once per gesture. Mid-gesture the hulls keep the
previous padding, which is unobservable: they're invisible hit-assists,
and nobody is clicking a microstate mid-pinch. Live zoom ticks are now
just the transform updates plus two marker-radius attributes.

Note on reusing d3-zoom's start/end events: an earlier round removed
these handlers when killing the `optimizeSpeed` trick — the removal was
about that trick specifically, not the events, which remain the correct
(and only) gesture-lifecycle hook. Programmatic `zoomBehavior.transform`
calls emit the same lifecycle, so a `_reflow` also triggers one harmless
settle pass.

Verified via jsdom, driving the real zoom behavior: the gesturing class
is present across a 20-tick zoom burst and gone ~200ms after it stops;
hull `points` writes during the burst are exactly 0 and exactly 1 at
settle, with `_lastHullPadK` syncing to the final k; back-to-back
gestures inside the settle window keep the class alive (no thrash);
`destroy()` with a settle pending doesn't fire on a dead map. Six
representative end-to-end game paths re-run green, zero window errors.
`npm run build` clean.

## 2026-09-26 — perf: pan/zoom tick costs cut, map topology deferred to game start

Two asks: smoother zooming/panning, and stop loading "everything" before
the player has even picked a map.

**Deferred topology.** Measured first: the map topology is 756KB — 88% of
the countries dataset's total payload — while the items file the wizard
actually needs for its region/sovereignty counts is only 102KB.
`datasets.js` now caches and fetches the two halves separately
(`loadItems` / `loadTopology`, both promise-cached so concurrent callers
share one in-flight fetch, with failed fetches evicted so a retry after a
network blip actually retries). `goToRegionOrSkip` awaits only
`loadItems`; the topology's first request happens on `startGame`'s own
Loading screen, right before the map mounts. Verified with a fetch spy
driven through the real wizard: at the region step only `countries.json`
has been requested (counts render correctly from it), `world-50m.json`
first appears after the sovereignty pick, and the game mounts fine.

**Pan ticks stripped to the minimum.** Everything in the zoom handler
past the transform updates exists to counter-scale against `k` — marker
radii, assist-hull re-padding — and `k` doesn't change during a drag. One
`k === _lastCounterScaleK` check now skips all of it on pure pans
(verified: 50 pan ticks → zero hull/marker attribute writes, was 50×~80
polygon string rebuilds). Hull re-padding also tolerates 2% k-drift
before re-running (≤0.06px error in a 3px margin), so a continuous
2x→4x pinch re-pads 25 times instead of 50.

**Off-screen ghost culling.** Once zoomed in even slightly, the two wrap
ghost copies — each a full extra copy of ~240 country elements — sit a
whole world-width off-screen, yet the browser still had to consider them
every frame. `_applyTransform` now hides a ghost (`visibility: hidden`,
deliberately not `display: none` — skips paint and hit-testing without
compositor-layer teardown churn at the boundary) whenever its entire
span lies outside the viewport, and stops updating its transform while
hidden. Verified per-ghost independence on the one case where it matters:
Asia's default framing renders its content *via* the left ghost — that
one stays visible while the right one culls; at k=1 both stay visible
exactly as before.

Full 10-path end-to-end suite re-run green with zero window errors after
all three changes. `npm run build` clean.

## 2026-09-26 — full-project audit: 4 rounds, 9 fixes

Asked to sweep the whole project for issues repeatedly until clean. Four
passes: (1) a full read of all 21 source files, (2) a second read of
everything the first pass hadn't scrutinized, (3) a behavioral sweep
driving all 10 wizard-path × game-mode combinations end to end in jsdom,
(4) behavioral verification of the round-2 fixes plus a TODO/console.log
sweep. Round 3/4 surfaced nothing new beyond one harness artifact (jsdom
SVG elements have no `.click()` — dispatch a MouseEvent instead; the app
was fine), which is the signal the audit had converged.

Fixes, roughly by severity:

- **Pin confirm broke at the antimeridian seam** (`WorldMap.js`). The
  whole-map click handler folds every click's x modulo into the home
  period, but measured the distance to the pin *linearly* — a pin near
  lon 180 (Fiji) with a click visually 4px across the seam folded to the
  far end of the period, measured ~a full world-width away, and re-dropped
  instead of confirming. The x-difference is now computed modularly
  (shortest way around). Regression-tested with exactly that Fiji case.
- **"Play Again" silently dropped `pinTarget`** (`game.js`). A
  Capital-scored pin game replayed as Region-scored, because the summary's
  replay call re-listed every config field by hand and this one was
  missing. Verified by playing a capital game to summary, replaying, and
  confirming the feedback still says "from the capital".
- **Summary lines were wrong for Capitals games** (`game.js`). A missed
  round rendered as "France: wrong (was France)" — the item's *name* as
  label with itself as the correction, and the actual prompt ("Paris")
  nowhere. Lines are now labeled by the question value the player was
  shown ("Paris: wrong (was France)"), and the correction is dropped when
  it would just echo the label (name→location games now read "France:
  wrong"). Verified behaviorally in both directions.
- **mapExplore leaked a WorldMap on back-during-load** (`mapExplore.js`).
  The dataset fetch resolving after Back built the map into a detached
  node, whose ResizeObserver kept the whole topology alive. A `cancelled`
  flag now skips construction.
- **Zero-count wizard options could start an empty game** (`gameWizard.js`).
  A region/sovereignty option whose count is 0 would construct a
  QuizSession with an empty pool and crash the round screen on
  `getValue(undefined)`. No option is actually zero with today's data,
  but the count is already computed for every label, so `disabledFn:
  count === 0` on all three counted steps (region, sub-region,
  sovereignty) makes it unreachable. Dataset-switch entries (US States,
  count `null`) stay enabled since `null !== 0`.
- **404s surfaced as JSON parse errors** (`datasets.js`). `loadDataset`
  now checks `r.ok` and throws "Failed to load <url>: HTTP <status>"
  instead of letting an HTML error page hit `r.json()`.
- **Two `haversineKm`s with opposite argument orders** (`inputs.js` takes
  `[lat, lon]`, `WorldMap.js` takes `[lon, lat]` — same name, both
  module-private, a collision waiting for the first cross-module
  refactor). The inputs one is now `haversineKmLatLon`, with the
  convention spelled out at the definition.
- **Stale comments from the one-map refactor**: the dashed-border block
  and `isAskable` still described the removed hard-crop model; `game.js`'s
  `playableIds` comment still listed Siachen/Indian Ocean Ter. as muted
  (they're `.country--terrain` now); `inputs.js` still described the
  deleted pin hit-area element. All updated to match the code.

Also checked and found genuinely fine (listed so the next audit doesn't
re-litigate them): the favicon (exists in `public/`, Vite rewrites the
base correctly — checked `dist/index.html` before "fixing" it),
`settings.js`'s parse fallback, `screenKit`, `engine`'s shuffle/round
logic, both generator scripts, pin-mode `markResult`'s single-reveal
invariant (two-argument marking is unreachable there and documented as
such), and the summary/back-navigation listener guards. `npm run build`
clean; all 10 end-to-end paths green with zero window errors.

## 2026-09-26 — pin mode for Countries: it already worked, but the wizard hid it behind a nonsense question

Asked to add pin mode to the Countries subject — borderless map, correct if
the pin lands inside the country. Checked before building anything: that
path already existed and worked (Countries → Name → Location on the Map →
Drop a pin → Region), and "Region" scoring is exactly the described
behaviour.

So the feature wasn't missing; its *discoverability* was. After picking
"Drop a pin" the wizard asked "Score the pin against the region, or the
capital?" — and in the Countries subject "Capital" is incoherent: the
prompt is a country's name, and pinning its capital is a different game
than the one just chosen. A question that shouldn't have been asked at all
made the mode look like it belonged to something else.

Fixed by only asking when the answer can be meaningful:
`offersCapitalPinTarget` checks whether `capital` is in the subject's own
`attributeKeys` (core/subjects.js) — true for Capitals, false for Countries
— reusing the same attribute scoping every other wizard step already keys
off rather than special-casing subject keys, so a future subject gets the
right behaviour without touching this. When false the step is skipped and
`pinTarget: "region"` is used directly, mirroring how
`goToAnswerKindOrSkip` already skips the answer-kind step when there's only
one option.

Deliberately did *not* stop at "it already works" — that's the failure
mode logged in MISTAKES.md §1b one round earlier (correctly identifying
something and calling it resolved, when the complaint was really about how
it presented).

Verified via jsdom: Countries → Name → Location now goes straight from
"Drop a pin" into the region step with no target question, while Capitals →
Capital → Location still offers Region/Capital. End-to-end Countries
pin round confirms the map renders borderless (1 `path.country` — the
post-confirm reveal only), a pin inside the target scores "Correct! You
were 0 km from its border", and a pin in the wrong country scores
"Correct answer: Åland Islands. You were 5115 km from its border".
`npm run build` clean.

## 2026-09-26 — the "triangle" was mine after all; pin confirm rebuilt without DOM hit-testing

Both items re-reported after the previous round said they were handled.
Both were genuinely still broken, and the first one I had actively
misdiagnosed.

**The India/Pakistan/China triangle — a regression I introduced, not
"working as designed".** Last round I looked this up, found Siachen Glacier
at exactly that trijunction, confirmed it's one of two id-less topology
shapes deliberately excluded from `countries.json`, and reported it as
intended behaviour. That was wrong, and the giveaway was in my own earlier
work: it only *looks* like a stray grey triangle because the two-layer
pin-mode landmass refactor (same day) started painting it muted. The
overlay filter was `f?.id && playableIds.has(f.id)` — id-less features fail
the first clause, so the muted base showed through them while every
neighbour was normal land. Pre-refactor, pin mode merged everything into a
single uniformly-coloured landmass and nothing stood out.

Root issue: "not in play" was being used for two different things. A
*country that's out of play* should be muted (that's the whole point of
`--unplayable`); *terrain that isn't a country at all* should just look
like ground. Split into a third state: id-less features now get
`.country--terrain` (ordinary land fill, no pointer events) in map-click
mode, and are included in pin mode's playable-overlay merge. Both stop
them reading as artifacts.

Worth noting for next time: the report said "still visible", and I'd
previously answered it with an explanation rather than a fix. The
explanation was even *correct* about what the shape is — and still
useless, because the actual complaint was about how it was painted.

**Pin confirm — the ghost-clone fix didn't work; replaced the whole
approach.** Last round's diagnosis (the pin is often rendered by a wrap
ghost copy, which had no clickable hit-area) was right, but the fix wasn't:
cloning `pinConfirmHitArea` into each ghost group can't work, because ghost
groups are `pointer-events: none` wholesale and the clone carried no class
to re-enable it. I'd added the listener and not verified the element could
actually receive events — exactly the "asserting instead of computing"
pattern `MISTAKES.md` was written about, two rounds after writing it.

Rather than keep chasing `<use>` shadow-tree hit-testing semantics, dropped
DOM hit-testing entirely. The whole-map click listener already folds every
click back into the home copy's coordinate space to support wrapping, so it
now just measures the distance from there to the current pin and treats
anything within `PIN_RADIUS_PX + PIN_CONFIRM_PADDING_PX` (screen px, scaled
by the live `transform.k`) as a confirm. One check, automatically correct
for the home copy and all ghosts, no hit-testing involved.

That deleted more than it added: `pinConfirmHitArea`, its ghost clone, its
per-zoom-tick radius counter-scaling, its two CSS rules, and the
`_pinConfirmClickInFlight` flag (which only existed to stop the confirm
click from also re-dropping the pin — the handler now just returns early).

Verified via jsdom: map-click renders exactly 2 `.country--terrain` paths
(Siachen + Indian Ocean Ter.) and 0 `--unplayable` in a World game;
Siachen's own coordinates test *inside* Asia's playable-overlay merge, so
nothing mutes it; and the confirm flow — drop, re-click same spot →
confirm, click ~8px off → still confirm, click far away → re-drop — behaves
correctly. Critically, repeated the confirm test with the view shifted a
full world-width so the pin is rendered by a *ghost* copy: still confirms,
still doesn't re-drop. That's the exact case the previous approach failed.
`npm run build` clean.

## 2026-09-26 — pin confirm didn't fire: the visible pin can be a ghost, which had no click listener

Reported: clicking the just-dropped pin (or the same spot again) didn't
confirm. First check — a full click-flow test driving the real `WorldMap`
+ `game.js` — passed cleanly, which turned out to be a false negative:
`jsdom` doesn't do real geometry-based hit-testing, so dispatching a click
"at" a screen coordinate by calling `.dispatchEvent()` directly on an
element always hits that exact element regardless of whether its actual
rendered position matches the coordinate. That masks precisely the class
of bug where the *visually correct* element to click isn't the one a real
browser's hit-test would find.

Root cause, found by checking structurally which elements get cloned into
wrap ghost copies: `pinMarker` gets a `<use>` clone in each ghost group (so
it's *visible* there), but `pinConfirmHitArea` — the actual click target
behind it — never did, and had no click listener anywhere but the home
copy. Wrap is now enabled for every region, not just World (an earlier
round), so the pin the player *sees* on screen can easily be a ghost's
rendering rather than the home copy's own. Clicking that visible-but-
ghosted pin had nothing behind it to catch the click, so it fell through
to the whole-map listener and re-dropped the pin instead of confirming.

This isn't only a drift-after-panning case, either — checked directly with
zero user interaction: Asia's own *default* framing already renders via
its left ghost copy, not home (its region centroid sits far enough from
the projection's own lon=0 reference that `_wrapTransform`'s drift check —
which only guarantees *some* copy covers at least half the viewport, not
that home specifically does — leaves home's own span entirely outside
`[0, viewport width]` from construction). Europe's default framing happens
to still be home-covered; Asia's isn't, unprompted.

Fixed by cloning `pinConfirmHitArea` into each ghost group too, with the
*same* click-handler function (extracted to `_handlePinConfirmClick` so
home and every ghost share one implementation rather than risking two
copies drifting apart) attached to each clone — mirroring exactly how
country-ghost click listeners already work outside pin mode.

Verified via jsdom (deleted after, per usual, this time including the
false-negative test that prompted digging further): confirmed Asia's home
copy span doesn't overlap the viewport at its own default zoom (zero
panning); confirmed both ghost groups now carry a `pinConfirmHitArea`
clone; dispatching a click directly on a *ghost's* clone (not home's own
element) now correctly invokes the confirm callback, and a second
dispatch confirms the bubbled click still gets consumed by
`_pinConfirmClickInFlight` rather than also re-dropping the pin. `npm run
build` clean.

## 2026-09-26 — Asia's zoom, the India/Pakistan/China "triangle", and a real hit-area bug

Three reports at once.

**Asia zoom.** Same problem as Europe's own framing round, same fix:
Russia counts toward Asia (`ASIA_BONUS`, core/regions.js) and its topology
shape spans the antimeridian (the map's full width), which dominates any
fit that includes it. Measured (jsdom): excluding it from `fitExclude`
takes the fit scale from 1.25x world scale to 2.91x, and the resulting
frame's own anchors (Kazakhstan/Indonesia/Japan/Türkiye) needed nothing
further, unlike Europe's six-member list. `core/regions.js`'s Asia entry
gained `fitExclude: new Set(["Russia"])`; Russia stays fully in the region
and fully playable.

**The "triangle" between India, Pakistan, and China.** Not a bug — it's
Siachen Glacier (lon 76.77–77.80, lat 35.11–35.66, exactly the Kashmir/
Karakoram trijunction), one of two topology shapes with no ISO id
(`scripts/generate-data.mjs`'s own documented exclusions, alongside Indian
Ocean Ter.) that render permanently muted and never playable, by design —
a real, disputed, literal glacier/military zone that's deliberately not
folded into any country's territory. Confirmed by direct lookup, not
memory: it's the only unmatched shape anywhere near that location. Left
as-is; flagged to the user as what it actually is rather than assumed to
need fixing.

**Selected-country border, actually a real bug.** Reported as inconsistent
borders on selection — "not all light blue and thicker, some oddly
missing." Root cause found by rendering the *real* SVG (a new technique:
serialize `WorldMap`'s actual output with the real style.css inlined —
CSS custom properties substituted with their literal values first, since
`rsvg-convert` doesn't resolve `var()` — and rasterize with `rsvg-convert`,
which is available locally) rather than reasoning about the DOM in the
abstract. San Marino/Monaco/Vatican-style assisted countries showed a
correctly-colored but wildly *oversized* hexagon at high zoom, big enough
to visually swallow the real border entirely — not missing, buried.

Cause: `HULL_PADDING` (the tiny-country hit-area's 3px assist margin,
`_computeHull`) was baked into the hull's static `<polygon>` geometry once
per `_reflow`, in the same pre-zoom coordinate space every country path's
`d` lives in. The whole home/ghost group is then visually magnified by
the interactive zoom transform, so that fixed 3px scales right along with
everything else — fine at the default view, but at `MAX_ZOOM` (50x) the
same 3px reads as ~150px on screen. Split hull computation into two
steps — `_computeHull` (unpadded, cached per-country as `_hullBaseById`)
and a new `_padHull` (the padding-application step, now cheap to redo) —
and re-run `_padHull` with `HULL_PADDING / transform.k` on every zoom
tick, the same counter-scaling technique the pin marker's own radius
already used. The hull's *shape* still scales naturally with zoom, like
any country path; only the constant assist margin around it doesn't.

Verified: rendered San Marino's selection highlight at k=12 before and
after — before, a hexagon viewer-scale enough to overlap Croatia; after,
a compact, properly-proportioned shape. Measured the hit-area's actual
on-screen extent across k=1→50 directly: grows only ~3x over that range
now (driven by San Marino's own real, tiny shape naturally growing with
zoom, which is correct) instead of the ~50x proportional growth the fixed
padding caused before. `npm run build` clean.

## 2026-09-26 — capital-target reveal marker didn't counter-scale with zoom

Reported: on confirm in "Capital" pin-target mode, the revealed capital
marker was much too large — it should behave like the pin marker itself,
staying a constant on-screen size regardless of zoom.

It simply never had that logic. `pinMarker`'s "zoom" handler counter-scales
its `r` on every tick (`PIN_RADIUS_PX / transform.k`) so it lives in the
same zoomed/panned `<g>` as every country path without visually growing or
shrinking; `capitalMarker`, added in a later round for `revealCapitalDistance`,
only ever got `r` set once at construction and was never added to that
same handler — an omission, not a deliberate difference. Fixed by adding
the identical counter-scaling line for `capitalMarker` alongside
`pinMarker`'s own.

Verified via jsdom: `capitalMarker`'s radius now matches `pinMarker`'s
exactly at every zoom level tested (4 at k=1, 0.5 at k=8, back to 4 at
k=1). `npm run build` clean.

## 2026-09-26 — one map for every region: regions become framing + muting, not crops

Requested: make every map really be the same map, with regions expressed
as disabled countries and different default zooms rather than separate
maps — motivated by the World map refusing to zoom in past a certain
point.

That symptom had a structural cause worth stating plainly. A region used
to be a **hard crop**: non-members were dropped from the geojson entirely
and the projection was re-fit to whatever remained. `scaleExtent`'s `k=1`
means "whatever `fitSize` produced", so k meant something different in
every region — Europe's own fit is ~5.7x tighter than the world's, so a
nominal 10x ceiling was ~57x of world scale in a Europe game but only 10x
in a World game. The World map wasn't bugged; it was measuring zoom
against a much wider baseline.

Now: **one region-independent projection** (always `fitSize` against the
whole dataset), and a region expresses itself as two much smaller things —
`playableIds` (which features are in play, already existing machinery) and
the new `focusIds` (what the initial view frames itself on).
`_defaultTransform` turns the focus set's projected bounds into a plain
zoom/pan transform, which is what a fresh map opens at and what a genuine
resize resets to. `scaleExtent` becomes an absolute `[MIN_ZOOM, MAX_ZOOM]`
= `[1, 50]`, identical everywhere: k=1 is always the whole dataset, and 50
comfortably exceeds the tightest view any old per-region maximum allowed
(Europe's ~46x world-scale), so nothing that used to be reachable stopped
being reachable while the World map gained real zoom-in range.

Deleted along the way, all of it now unnecessary: `filterIds` and the
cropping it drove; `fitIds`/`_fitGeojson`; the second throwaway `fitSize`
call and the derived `scaleExtentMin` that existed only to let players
zoom back out past a narrowed default framing; and the `translateExtent`
widening that propped that up. `game.js`'s `mapFeatureIds` +
`fitFeatureIds` collapse into one `focusIds`.

Two consequences that needed handling rather than just falling out:

- **Pin mode had no way to show "disabled".** It draws merged landmass
  paths, not per-country ones, so out-of-region land would have looked
  identical to in-region land. Now it renders two merged layers:
  `pinLandmass` (whole dataset, muted) with `pinPlayableLandmass` (the
  playable subset, normal land color) on top. The muted layer is
  deliberately the *whole* world rather than the remainder, so the layers
  overlap along the region boundary instead of abutting — no sub-pixel gap
  can let ocean through as a seam, the failure mode this file has several
  entries about.
- **The tiny-country hit-area assist was calibrated against the wrong
  count.** Its reference area is `viewport / feature count`, and it used
  the *playable* count — fine when playable and rendered were the same
  set, badly wrong now: a 54-country Europe measured against the viewport
  the full ~240 countries are drawn into inflated the "typical country"
  reference ~4x and would have flagged ordinary countries as needing a
  microstate assist. Switched to the rendered count, which is also exactly
  what the ratio constants were originally calibrated against.

Verified via jsdom: all three of World/Europe/Oceania now share one
identical projection scale (148.03) and render all 241 features, differing
only in playable count (238/54/23) and starting transform (k=1.00 / k=5.73
/ k=1.00), with `scaleExtent` a uniform `[1, 50]`; out-of-region countries
are present but absent from `featuresById` (rendered, not clickable), and
a pin dropped on Japan in a Europe game correctly resolves to `null` while
one on France resolves to France; pin mode's two merged layers come out
with the playable overlay a proper subset of the muted base in Europe and
effectively equal to it in World; hit-area assist counts land at 81 for
World (matching the figure from the earlier hitbox-audit round, i.e.
unchanged) and 13 for Europe, all genuine microstates/archipelagos; US
states (identity projection) still has wrap off and its own framing. Full
end-to-end gameplay re-run for World and Europe × map-click and pin-drop:
3 clicks per round in every combination, correct scoring, and a pin on the
target's capital reporting "0 km". `npm run build` clean.

## 2026-09-26 — pin-drop rounds cost four clicks instead of three

Reported: a pin-drop round needed four clicks, with two clicks on land
required after confirming, instead of the intended drop → confirm →
advance.

Cause was the `stopPropagation()` added when click-the-pin-to-confirm was
built. `game.js`'s `attemptConfirm` arms a one-shot
`suppressNextRootAdvance` flag on every confirm, because a confirm
triggered by clicking something *other* than the action button is itself a
click that will go on to bubble to the root "click anywhere advances"
listener — without the flag, that single click would both confirm and
immediately advance, and the result would never be visible. The flag is
designed to be consumed by that very click. Stopping propagation meant it
never arrived, the flag stayed armed, and it then ate the player's *next*
click — the intended advance — so advancing took two clicks. (Pre-existing
reclick-to-confirm paths, map-click and multiple-choice, never had this:
they let the click bubble normally.)

Removed the `stopPropagation()`. The one thing it was legitimately
preventing — the same click also reaching the whole-map listener and
re-dropping the pin where it already is — is now handled by a one-shot
`_pinConfirmClickInFlight` flag that the map's own click listener checks
and clears. Deliberately explicit rather than leaning on `clickEnabled`
being flipped false by `showResult` part-way through the same event's
propagation: that happens to be true today, but it's exactly the kind of
implicit ordering that breaks quietly later.

Verified by driving the real `renderGame` + `WorldMap` with dispatched
`MouseEvent`s and counting: a pin-drop round is now 3 clicks via the
re-click-the-pin path (drop → Confirm enabled; confirm → button becomes
"Next"; advance → Round 2) and 3 via the Confirm-button path, with the
advance click working on open sea as well as land. Map-click mode
regression-checked the same way (select → re-click to confirm → advance)
and is also still 3. One incidental finding, left alone as correct: a pin
dropped in open ocean reports no selection and so can't be confirmed,
which is why the first version of the test appeared to stall — clicking
actual land behaves as intended. `npm run build` clean.

## 2026-09-26 — pin mode borders, round 5: stop hiding country paths, stop creating them

Fifth report of borders in pin mode when zoomed. Four previous attempts
had each fixed a real, measurable thing and still not resolved it, so this
round started by building actual visual ground truth instead of reasoning
about the DOM: `rsvg-convert` is available locally, so a script now
serializes the **real** SVG `WorldMap` produces (ghost copies and all,
with the real `style.css` inlined) and rasterizes it, plus a flood-fill
analyzer that fills "ocean" inward from the image border so that genuinely
enclosed interior gaps can be told apart from real bays and straits (a
naive scanline detector flagged every antialiased coastline pixel and was
useless).

That said clearly: **the rendered geometry is already perfectly clean.**
Zero enclosed artifacts at k=8–10, at multiple pan positions, and a direct
check confirmed `merge()` is doing its job — every probe across contiguous
Afro-Eurasia (Paris, Berlin, Warsaw, Madrid, Rome, Moscow, Beijing, Delhi,
Cairo, Lagos, Nairobi) lands in the *same single merged polygon*, index 0.
There are no internal country borders in the landmass geometry to render.

So the landmass was never the problem — which pointed at the ~241
per-country `<path>` elements that pin mode was still creating and merely
*hiding* with `fill: none; stroke: none`. Checking the cascade properly
(something I had asserted but never verified) showed why that was fragile:
`.world-map--clickable .country:not(.country--unplayable):hover` has
specificity (0,4,0) and **outranks** the pin-mode rule's (0,2,0). Those
paths staying invisible rested entirely on a subtle argument about
unpainted shapes not receiving pointer events — the kind of browser
hit-testing detail I'd already been wrong about repeatedly, and exactly
the sort of thing that behaves differently under a zoom transform.

Rather than keep chasing it: pin mode now **doesn't create per-country
paths at all**, nor their ghost `<use>` clones — 241 paths + 482 clones →
0 on the world map. `pinLandmass` is the whole map, plus one shared
`revealPath` that `markResult` draws the post-confirm target into. No
element exists that could paint a country border, so no stylesheet rule
can bring one back, whatever the cascade or the hit-testing does. Two
supporting changes: `_playableIds` (a plain `Set`) now carries the
playable gate `featuresById`'s keys used to double as, and
`_mark`/`_forEachMarked`/`clearMarks`/`_reflow` branch on `pinMode` to
drive `revealPath`. Sizeable DOM/perf win too, incidentally.

Verified: pin mode renders exactly 1 `path.country` (the reveal, with no
`d` until marked) and 0 `country-ghost` clones, while a non-pin map still
builds all 241 paths, 482 ghost clones, its hit areas, and still marks
both correct *and* wrong countries on `markResult`; pin-drop resolution
still finds the right country through the new `_playableIds` gate; the
reveal draws, survives a reflow, and fully clears (geometry as well as
classes, so an unclassed `revealPath` can't paint via the base `.country`
rule); rasterized the refactored pin mode at k=9 panned right and
confirmed zero enclosed artifacts and a visually solid, seam-free
landmass. `npm run build` clean.

Note the two prior rounds' fixes are both still in place and still
correct — the `merge()` hairline-sliver filter and the merged-path
approach itself. This round removed a *different* cause that had been
masked behind them.

## 2026-09-26 — pin mode "borders", round 4: they were never borders — merge() emits map-spanning hairline artifacts

Reported still visible at "a combination of enough zoom and being enough
to the right." The previous round's merge-into-one-path change did
genuinely fix the original bug (two independently-antialiased adjacent
paths disagreeing on a shared edge), so this had to be something else —
and measuring properly instead of theorizing again turned up a completely
different cause, and one that had been mischaracterized twice:

**These were never seams *between* countries at all.** `topojson.merge()`'s
own output contains two **degenerate hairline polygons** — artifacts of
dissolving shared arcs that don't perfectly cancel. At an 800×500 fit, one
spans **799.6px, the entire map width, at 0.29px thick** (10 points, aspect
ratio ~2799:1); the other spans 604.0px at 1.67px thick (43 points, aspect
~361:1). They're *extra land* drawn across open ocean, not gaps — thin
bright streaks. Sub-pixel and so invisible at the default zoom, but their
size is fixed in the path's own coordinate space, so they scale with the
zoom transform: several px thick at the far end of `scaleExtent`, reading
exactly like a stray border line. A streak running the full width of the
map also explains why it looked position-dependent — panning horizontally
moves along it, so whether one is in view (and how thick it looks) depends
on both zoom and pan.

**The previous round's mitigation was actively making it worse.** That
round added an 8px matching-color `stroke` to `pinLandmass`, reasoning
that a wide self-stroke "can only ever add coverage." True for a *gap* —
but exactly backwards for a hairline *artifact*: an 8px stroke turns a
0.29px streak into an ~8px band. The mitigation was amplifying the very
thing being reported, which is why the seam appeared to survive a fix that
should have buried it.

Fixed properly by removing the artifacts from the geometry, where the
problem actually lives: `_withoutMergeSlivers` drops whole polygons whose
outer ring is both extremely elongated *and* spans a large fraction of the
map (`MERGE_SLIVER_MIN_ASPECT` 50 / `MERGE_SLIVER_MIN_SPAN_FRACTION` 0.1).
Both conditions are required, and neither would be safe alone: Antarctica
is legitimately wide-and-short (aspect 11.2), so a pure aspect test would
delete it; real tiny islands are extremely thin without spanning anything
(longest ~6px), so a pure thinness test would delete those. `pinLandmass`'s
stroke went back down to 1px — still useful for its original, narrow
sub-pixel-gap job, no longer pretending to handle artifacts.

Two measurement lessons worth keeping, both of which changed the
implementation:

- **Aspect ratio, not absolute px thickness.** The first version of the
  filter used a `< 2px` thickness cutoff, which worked at 800×500 and
  silently let *one of the two artifacts through* at 1920×1080 and
  2560×1440 (the 1.67px one exceeds 2px once `fitSize` scales up) — caught
  only because the test ran across several viewport sizes. Aspect ratio is
  scale-invariant, so one measurement characterizes every viewport.
- **An area filter would have been unsafe**, checked concretely rather
  than assumed: Vatican City's own true spherical area (`d3.geoArea`) is
  *smaller* than several sliver rings, so an area threshold catching every
  artifact would risk deleting real tiny countries. Elongation separates
  them cleanly where area can't.

Verified via jsdom + direct geometric measurement (deleted after, per
usual): across every polygon spanning >10% of the map, the two artifacts
measure aspect 2799 and 361 while the widest real feature (Antarctica)
sits at 11.2 and nothing else exceeds 2.4 — the chosen cutoff of 50 lands
in that empty gap with 7x/4.5x margins on either side. Confirmed exactly 2
polygons dropped at all four viewport sizes tested (800×500, 1920×1080,
2560×1440, 500×800) and no remaining hairline longer than ~19px anywhere;
confirmed via point-in-polygon that Vatican City, Malta, San Marino,
Antarctica, mainland France, far-east Russia, and New Zealand all remain
inside the filtered landmass. Re-ran the prior rounds' checks too: Europe
crop still merges and keeps its widened `scaleExtent`, landmass stays the
bottom paint layer in the home group, non-pin-mode maps still never create
it at all, and capital-target scoring still resolves correct/too-far/wrong
as before. `npm run build` clean.

## 2026-09-26 — pin mode border seam: stop faking "one shape," actually merge into one

User reported the seam was back under a specific combination: panning
right and zooming in slightly. Two earlier attempts (matching-color
stroke, then a wider matching-color stroke) were both mitigations for the
same root cause without fixing it: rendering N independent per-country
`<path>`s that merely share a fill color is never actually "one shape" —
it's N shapes that *usually* look like one, and any sub-pixel antialiasing
mismatch between two adjacent ones (which varies by exact pan/zoom state,
device pixel ratio, and possibly which of home/ghost copy is rendering
it) can still show through as a hairline seam. No amount of stroke-width
tuning rules that out for every possible alignment — the previous round's
"bump the width" fix could only ever reduce how often it was visible, not
guarantee it never was.

Replaced the whole approach: `WorldMap.js` now builds one single merged
`<path>` (`pinLandmass`) via `topojson.merge()` over every currently-
rendered feature, instead of relying on individual per-country paths to
visually blend. `merge()` works at the arc level — topojson's whole
storage model is built around exactly this (a shared border between two
features is stored once, referenced by both), so it can identify which
arcs are internal (shared between two merged features, and therefore
dissolved) vs. external (part of the true outer boundary, kept) in a way
that's no longer possible once geometry has already been converted to
plain projected GeoJSON coordinates (`feature()`, what every other code
path uses). The result has no internal edges between originally-adjacent
countries left to seam at, in *any* pan/zoom/ghost-copy state — not a
mitigation, a structural fix. Added `_rawGeometriesForMerge`: the same
`filterIds` crop already applied to build the regular (GeoJSON) `geojson`
property, applied in parallel to the *raw* topology geometry objects
`merge()` actually needs, using an extracted `keepIndex` predicate so both
stay in sync by construction rather than by coincidence.

Individual per-country `<path>`s still exist (still needed for the
post-confirm target reveal, `markResult`'s `.country--correct`), but now
contribute nothing at rest: `.world-map--pin-mode .country`/
`.country--unplayable` dropped to `fill: none; stroke: none` (down from a
fill+matching-stroke). Turned out to also retire the entire hover-
highlight bug class for free: an unpainted shape (`fill`/`stroke` both
`none`) doesn't receive pointer events at all in SVG, so it can no longer
register a `:hover` in the first place — the CSS's dedicated hover-reset
rule and cursor-inherit rule from that earlier fix are gone too, since
there's nothing left for either to apply to. `pinLandmass` is inserted
first in the home group and cloned (via the same `<use>` ghost mechanism
every other pin-mode element already uses) first in each wrap ghost copy
too, so it's always the bottom layer, everything else — the invisible-
until-revealed country paths, the pin marker, the border/capital-distance
reveal lines — draws on top of it.

Verified via jsdom (deleted after, per usual): `pinLandmass` gets a real,
non-trivial `d` attribute for both an unrestricted world map and a
region-cropped one (Europe); it's the first child of the home group and
of both ghost groups (bottom of paint order); a ghost `<use>` clone
referencing it exists in both wrap directions; `markResult`'s target
reveal still correctly marks the specific country's own path
`.country--correct`; a non-pin-mode `WorldMap` never creates or appends
`pinLandmass` at all (`_rawGeometriesForMerge` stays `null`). Also re-ran
the pin-radius, click-to-confirm, and capital-target-scoring checks from
the last two rounds to confirm none of them regressed from this
insertion-order/reflow change. `npm run build` clean.

## 2026-09-26 — pin-drop scoring: choose Region or Capital as the target

Follow-up to the same day's border-seam/click-to-confirm round below — a
reported seam sighting in Capitals-subject pin mode turned out to be the
same mechanism already fixed there (not subject-specific), so no separate
fix needed. The substantive addition this round: a new pin-drop scoring
choice.

**Region vs. Capital pin-target.** Asked whether landing in the right
country but far from its capital should still count as correct under a
new "Capital" scoring option — confirmed it should require actual
proximity to the capital, not just the country. This meant a real
correctness change, not just a feedback-text one, so it touched the whole
pin-drop path:

- *Data*: `capitalLatLng` didn't exist anywhere upstream — world-countries'
  own `latlng` is a rough centroid (Australia's sits in central Australia,
  nowhere near Canberra), and no already-used package has real capital
  coordinates. Added `cities.json` (GeoNames-derived, CC-BY-4.0) as a new
  devDependency and joined it against each country's own `capital` name
  (ISO alpha-2 + normalized-name match); resolved all 238 countries with a
  capital automatically or via a small, explicit override table for the
  handful cities.json spells differently (Myanmar, Western Sahara,
  Kiribati, South Georgia, British Indian Ocean Territory, United States)
  — see DESIGN.md's "Data" section for the full list and reasoning.
  Spot-checked several resolved coordinates directly against known
  real-world values (Paris, Moscow, Canberra, Washington D.C., Tokyo) —
  all correct to five decimal places, i.e. genuinely the join's own city-
  level precision, not a coincidence.
- *Wizard*: a new step, `gameWizard.js`'s `showPinTargetStep`, shown only
  after "Drop a pin" is picked (parallel to multiple-choice's "how many
  options" follow-up) — "Region" (existing, still default) or "Capital".
  Threaded through as `pinTarget` the same way `answerOptionCount` already
  was; cleared alongside the existing "map-pin → map-click" downgrade when
  switching to US States (identity-projection, no pin mode there anyway).
- *Correctness*: rather than teaching `QuizSession`/`attributes.js`'s
  engine a second, distance-based notion of correctness, `inputs.js`'s
  map-pin `onClick` handler pre-computes it and reports a guess value that
  the *existing*, unchanged `guessId === item.id` check already interprets
  correctly: `item.id` itself when within `CAPITAL_CORRECT_RADIUS_KM`
  (50km) of the capital, the actual (wrong) `containingId` if it's a
  different country, or — this took a moment to get right — a dedicated
  sentinel (`TOO_FAR_FROM_CAPITAL`), *never* `null`, when it's the right
  country but too far from the capital: `null` specifically means "no
  selection yet" to `game.js` and disables the Confirm button, which would
  have made a deliberately-far-but-definite wrong guess unconfirmable.
- *Reveal*: `WorldMap.js` gained `revealCapitalDistance`, alongside the
  existing `revealBorderDistance` (both now share a `_revealLineTo` helper
  for the line-drawing/re-projection plumbing) — draws a small
  `.capital-marker` at the capital's own exact point plus a line to it,
  using a real `haversineKm` great-circle distance rather than the border
  case's local-plane approximation (a capital can be genuinely far from
  the pin, where flattening the earth locally would start introducing
  real error). Shown regardless of correct/wrong, unlike the border-case
  line, since the precise distance is worth seeing either way.

Verified via jsdom throughout (deleted after, per usual): the full
capital-target decision tree (within radius → correct; right country, far
from capital → sentinel, confirmable, wrong; wrong country → its own id,
wrong; "Region" mode unaffected) exercised directly against France;
`revealCapitalDistance` against a real Marseille→Paris pin drop returns
~660km (matching the real great-circle distance) and positions the
capital marker/line correctly; the full wizard click-path (Countries →
Name → Location → Drop a pin) confirmed the new "Region"/"Capital" step
actually appears; `npm run generate-data` confirms every country with a
capital now resolves a `capitalLatLng`; `npm run build` clean.

## 2026-09-26 — pin mode: fully cover the border seam, click-the-pin-to-confirm

Two requests, both pin-drop mode (noticed while playing the Capitals
subject specifically, though the underlying mechanism is shared with
Countries — nothing about either fix is subject-specific).

**Border seam, still faintly visible.** The matching-color stroke fix
(pin mode's base country rule gets `stroke: var(--map-land)`, same as its
`fill`, to paint over the antialiasing gap between adjacent same-color
shapes) used a 0.75px `non-scaling-stroke` width — thin enough that a
sub-pixel rounding mismatch between two independently-antialiased
adjacent edges could still leave a faint sliver of the seam showing
through at some zoom levels/device pixel ratios. Bumped to 2.5px: still
invisible (identical color to the fill either way), just wide enough to
guarantee full coverage regardless of rounding.

**Click the pin to confirm.** Added a `pinConfirmHitArea` — an invisible
circle in `WorldMap.js`, always `PIN_CONFIRM_PADDING_PX` (10px) larger
than the pin marker's own current radius and kept in sync with its
position everywhere the marker itself is updated (`_dropPinAt`, the
`_reflow` re-projection block, the "zoom" handler's radius sync) — as a
separate, generously-padded click target layered on top of the
deliberately-tiny visible marker (4px radius, too small to reliably
re-click directly). Its own click handler calls `stopPropagation()`
before invoking a new third `setClickable` argument (`onPinConfirm`),
which `inputs.js`'s map-pin renderer wires straight to `ctx.onConfirm` —
`stopPropagation` matters because without it, the same click would also
bubble up to the whole-map listener and immediately re-drop the pin at
that same spot right after confirming. Clicking anywhere else on the map
still just repositions the pin, exactly as before — this is additive,
not a replacement for that.

Verified via jsdom (deleted after, per usual): dropping a pin then
dispatching a click event directly on `pinConfirmHitArea` fires the
confirm callback exactly once and the regular click callback zero times
(confirming `stopPropagation` worked); hit-area radius reads `14` (`4 +
10`) at the default zoom level, matching the constants. `npm run build`
clean.

## 2026-09-26 — let Europe's tighter default zoom still be zoomed *out* of

Confirmed the previous round's Europe framing was correct as a *default*,
but flagged a regression it introduced: zooming out was capped at that
same tight default, with no way back to the full crop (Russia, the
overseas territories, etc.) at all — the zoom behavior's `scaleExtent` was
a flat `[1, 10]`, and `k=1` means "whatever `fitSize` just produced," so
tightening the default framing tightened the zoom-out floor by exactly
the same amount, with nothing to zoom back out *to*.

Fixed in `WorldMap.js`'s `_reflow`: compute `scaleExtentMin`, the ratio
between what fitting the *full* crop would have scaled to vs. what the
narrower `fitIds`-based fit actually produced (a second, throwaway
`fitSize` call against the full geojson, reading `.scale()`, immediately
overwritten by the real fit against the narrowed one), and set
`scaleExtent` to `[scaleExtentMin, 10]` instead of `[1, 10]`. Also widened
`translateExtent` to the full crop's own `pathGen.bounds` rather than the
plain `[0,width]×[0,height]` box — otherwise the wider zoom level
`scaleExtentMin` now permits would exist in principle but the pan clamp
would still refuse to scroll to any of it. Both are exact no-ops (ratio
`1`, bounds already ~= the viewport box) for every dataset without a
`fitIds` narrowing — verified World's own `scaleExtent`/`translateExtent`
are bit-for-bit unchanged. The *default* zoom itself (what a fresh round
starts at, and what "keep zoom" resets to) is untouched — still the tight
`k=1` fit; only the floor below it moved.

Verified via jsdom (deleted after, per usual): Europe's `scaleExtent()`
now reads `[0.217, 10]` (matches the previously-measured 184/848 ratio);
simulating a zoom to that minimum and reading back `currentTransform`
confirms it applies cleanly; Russia remains in `featuresById` throughout
(nothing about crop membership changed, only how far you can zoom to see
it); World's `scaleExtent`/`translateExtent` confirmed identical to
before. `npm run build` clean.

## 2026-09-26 — remove the panning speed trick entirely, tighten Europe's framing to its real anchors, rename "Click the map"

Three follow-ups to the same day's earlier round, after the first attempt
at each didn't go far enough.

**Panning border artifact, actually fixed this time.** The previous
round's fix for pin mode's border seam (giving `.world-map--pin-mode
.country` a `stroke` matching its own `fill`, so antialiasing blends over
the seam instead of leaving a hairline gap) introduced a new, opposite-
looking artifact while actively dragging: adjacent same-color edges
flickered against each other, reading like two coplanar surfaces
"z-fighting". Cause: panning already applied `shape-rendering:
optimizeSpeed` for perf (an even earlier round), which turns antialiasing
*off* — with it off, the matching-color stroke fix has nothing to blend
into, and adjacent paths' crisp edges shift by sub-pixel amounts
differently frame to frame. The first attempt at a fix only scoped
`optimizeSpeed` away from pin mode specifically, but the report came back
that map-click mode (real, always-visible borders — no seam-hiding trick
at all) showed the same flicker on its own thin borders while panning.
Root cause was the speed trick itself, not something pin-mode-specific,
so removed it outright — no more `.world-map--panning` class, no more
`shape-rendering: optimizeSpeed` rule, no more `start`/`end` zoom-gesture
listeners in `WorldMap.js`. The anticipated perf benefit ("a phone GPU can
fall behind repainting ~240 paths") was never concretely measured to
begin with, and a visual bug reported twice outweighs a hypothetical one.

**Europe framing, actually tight this time.** The previous round's
exclusion set (`{"Russia", "France", "Norway", "Spain"}`, scale 476) still
wasn't the real answer — asked to re-anchor specifically on Cyprus
(south), Georgia (east, tolerating some cutoff), Iceland (west, same),
and definitely not Svalbard (north), measuring where those four actually
landed turned up two further, bigger outliers than any found so far: the
Netherlands' single topology shape bundles Aruba/Curaçao/Sint Maarten in
the Caribbean (~56° of longitude and ~20° of latitude from the mainland —
the single biggest offender of any Europe member), and Portugal's bundles
Madeira and the Azores (~600km further west than the Portuguese
mainland's own westernmost point, and further south too). Excluding both
on top of the existing four brings the fit scale to 734, then 848 (vs.
184 with nothing excluded) — and with all six excluded, the *remaining*
members' own natural extremes land almost exactly on the requested frame
with no further hand-picked bounding box needed: Cyprus anchors the
south, Georgia the east, Iceland the west, Finland the north (nowhere
near Svalbard, which projects far above the viewport entirely). `core/
regions.js`'s `EUROPE_FIT_EXCLUDE` is now `{"Russia", "France", "Norway",
"Spain", "Netherlands", "Portugal"}`.

**Rename.** The wizard's `"map-click"` answer-type label — "Click the
map" — is now "Select region" (`gameWizard.js`'s `answerKindLabels`), per
direct request; "Drop a pin" is unchanged.

Verified via jsdom (deleted after, per usual): each exclusion's
incremental effect on `projection.scale()` measured directly (184 → 291 →
442 → 476 → 476 → 734 → 848, one country added at a time); Cyprus/
Georgia/Iceland/Finland all project at or just inside the final 800×500
viewport's edges, Svalbard well outside it, and all six excluded
countries' own mainland capitals (Madrid, Lisbon, Amsterdam, ...) still
comfortably in view. `npm run build` clean.

## 2026-09-26 — fix static-map border seam, hide the wrong-guess country, constant-size pin, standard Europe framing, wrap everywhere

Five requests in one round: a real bug (borders reappearing at rest but
not while panning), two pin-mode reveal/size refinements, Europe's
starting zoom, and generalizing infinite scroll to every region.

**The border seam bug.** Root cause wasn't the previous round's hover-fill
fix being wrong — it was a second, unrelated rendering artifact: two
adjacent `<path>`s of the identical fill color still anti-alias their
shared edge independently, leaving a hairline seam of ocean color showing
through exactly along real country borders, but *only* when the renderer
is doing full antialiasing — panning/zooming already switches to `shape-
rendering: optimizeSpeed` for smoothness (an earlier round), which
happens to turn antialiasing off and hides the seam, which is exactly why
it looked like borders vanished while moving and reappeared at rest.
Fixed by giving pin mode's base country rule a `stroke` equal to its own
`fill` (small `non-scaling-stroke` width) — paints over the seam instead
of leaving it to antialiasing, with zero visual change since the color
matches exactly.

**Don't reveal the wrong country.** `inputs.js`'s map-pin `showResult` now
always calls `map.markResult(null, correctId)` regardless of the actual
guess — pin mode never shows the shape of the country the pin actually
landed in, only ever the target's, matching "only show country outline
when confirmed (and only that country)" from two rounds ago more
strictly than the previous round's fill-only compromise did. The now-
unreachable `.world-map--pin-mode .country--wrong` CSS rule was removed.

**Constant-size pin.** The marker's radius was scaling with the map's own
zoom transform (it lives in the same `<g>` every country path does) —
`vector-effect: non-scaling-stroke` fixes this for strokes but not a
circle's radius, so `WorldMap`'s zoom handler now sets `r` directly on
every tick to `PIN_RADIUS_PX / transform.k`, cancelling the group's own
scale back out. Baseline went to 4px (up from 2px, per "slightly larger
when zoomed out, but constant regardless of zoom" — not scaling was the
main ask, the baseline bump is secondary). Removed the stylesheet's own
`r` declaration, since CSS `r` (a real geometry property since SVG2)
would otherwise outrank the JS-set attribute and freeze the size.

**Standard Europe framing.** Fitting the map to Europe's whole bbox
zoomed out far enough to include Russia's full eastern extent (Russia
counts as Europe here, an existing override) — nothing like a normal map
of Europe. Added `WorldMap`'s `fitIds`, a narrower id set used *only* for
the initial `fitSize` call, independent of `filterIds` (the actual
crop/render/click set, unchanged) — `core/regions.js`'s new `fitExclude`
(currently just `{"Russia"}` on Europe's leaf) and `game.js`'s derived
`fitFeatureIds` thread this through. Russia is still fully in the region,
still clickable, just not part of what decides the starting zoom/pan —
reachable by panning right, same as always. Verified the scale actually
changes (jsdom: ~184 with Russia counted in the fit vs. ~290 without, a
meaningfully tighter frame) and that Russia's own `<path>` is still
present either way.

**Wrap everywhere.** `wrapEnabled` no longer requires an uncropped world
view (`!filterIds`) — it's now just "not the pre-projected US-states
topology," so every region (Europe, Asia, a single continent, ...) tiles
infinitely left/right the same way an unrestricted World view already
did. A cropped region's "world-width" is just whatever that region's own
bbox renders to, tiling next to itself — it doesn't reconstruct a real
globe, just guarantees no wall to hit while panning, in any mode, per the
explicit "in general" ask.

Verified via jsdom throughout (deleted after, per usual): Europe's
`projection.scale()` differs as above; `wrapEnabled`/3-copy structure now
true for a Europe-cropped map (previously only true for World); pin
marker `r` reads `4` at `k=1` and `1` at a simulated `k=4` zoom-in;
`markResult(null, correctId)` leaves the actually-wrong country
unmarked while still marking the correct one. `npm run build` clean.

## 2026-09-26 — pin mode: kill the hover-highlight "border leak", draw a pin-to-border line, shrink the pin further

User reported borders were still visible in pin mode after the previous
round's fix. Root cause wasn't the border stroke itself (already `none`)
— it was `.world-map--clickable .country:not(.country--unplayable):hover`,
a rule that predates pin mode and wasn't scoped to exclude it: hovering
any individual country path still changed its fill on its own, and since
neighboring countries don't light up together, the fill boundary between
a hovered country and its neighbor reads exactly like a border, even with
zero `stroke` anywhere. Added a same-specificity override,
`.world-map--pin-mode .country:not(.country--unplayable):hover { fill:
var(--map-land) }` (plus a matching `cursor: inherit` so the crosshair
cursor set on the map root isn't fought by each path's own `cursor:
pointer`), placed later in the file so it wins the tie. Pin mode now
genuinely renders as one undifferentiated landmass while answering — no
stroke, and no fill change either, on hover or otherwise.

Also restored (having gone too far removing it entirely last round) the
post-confirm reveal: `.world-map--pin-mode .country--correct` gets its
`stroke` back — only the *target* country's outline draws, exactly per
the original ask two rounds ago ("only show them after answering by
showing only the target country's border"); `.country--wrong` stays
fill-only, no stroke, so a miss never reads as two countries both getting
"confirmed" outlines.

New: a literal line from the dropped pin to the nearest point on the
target's border, drawn only for a wrong guess (never for a correct one,
which is always already inside). `WorldMap.distanceToBorderKm` — added
last round, returned only a number — became `revealBorderDistance(id)`:
same nearest-point search (`featureNearestBorderPoint`, extended from the
distance-only version to also return the winning point, converting the
local tangent-plane closest-point back to real lon/lat via a new
`localKmToLonLat`), but now also projects and draws a `<line
class="pin-border-line">` between the pin and that point, re-projected on
every `_reflow` alongside the pin marker itself so it tracks
resize/zoom correctly. `inputs.js`'s `map-pin` renderer no longer tracks
its own `lastLon`/`lastLat` — `revealBorderDistance` reads the map's own
already-tracked `pinLonLat` directly, one less thing to keep in sync.

Pin marker radius went 3px → 2px (stroke-width 1 → 0.75) — still "much
smaller" than the original 5px per this and the prior round combined.

Verified via a throwaway jsdom script (deleted after, per usual): dropping
a pin in Madrid and revealing against France returns ~351 km and sets the
line's `x1/y1/x2/y2` to real projected coordinates with `display` cleared;
dropping a pin in Paris and revealing against France returns exactly `0`
with the line's `display` left at `none`. `npm run build` clean.

## 2026-09-25 — smaller pin marker, single-outline reveal, border-distance feedback

Three pin-drop-mode requests: shrink the dropped-pin marker, only reveal
the *target* country's outline after answering (not the wrong guess's
too), and measure the post-confirm distance figure against the target's
actual border rather than its centroid — with an inside guess reporting
exactly 0 km rather than some nonzero distance to a point elsewhere in the
country.

**Pin size**: `WorldMap.js`'s `pinMarker` radius and `style.css`'s
`.pin-marker { r }` both went from 5px to 3px (stroke-width 1.5 → 1 to
match).

**Single-outline reveal**: `.world-map--pin-mode .country--wrong` already
had no border before this round's fill-vs-stroke read — turns out it *did*
draw one (`stroke: var(--wrong)`), same as `.country--correct`. Removed
it: a wrong guess now shows only as a red fill patch on the otherwise
still-borderless landmass, while the correct country's own outline (the
only one now drawn) is what actually gets revealed. `.country--correct`
itself was untouched — that's the one deliberate exception the borderless
mode was already built around.

**Border-distance**: previously, `map-pin`'s feedback measured a
great-circle distance (`haversineKm`, `inputs.js`) from the dropped pin to
the target item's `latlng` field — its centroid. This meant a pin dropped
well inside a large or oddly-shaped country (Brazil, Chile, ...) could
still report "you were 400 km away" despite being a correct guess, which
reads as contradictory feedback. Replaced with a new `WorldMap.distanceToBorderKm(lon,
lat, id)`: returns 0 if the point is already inside the feature (reusing
`pointInFeature`, the same point-in-polygon test `_findContainingId`
already relies on for `containingId`), otherwise the minimum distance to
any edge of any ring of any part of that feature's real outline. Distance-
to-segment itself uses a local tangent-plane flattening centered on the
pin's own latitude (`lonLatToLocalKm`) so the actual closest-point search
is plain 2D geometry rather than needing a full geodesic segment-distance
routine — accurate enough for a "how far off" readout given how short a
border segment is relative to the earth's curvature. `haversineKm` and the
`item.latlng`-based calculation in `inputs.js` were deleted outright (no
longer called from anywhere); the `latlng` field itself stays in
`countries.json` since `generate-data.mjs` still writes it and nothing else
depended on removing it.

Verified via a throwaway jsdom script (deleted after, per usual) against
the real `world-50m.json` topology: a point in central Paris resolves to
exactly 0 km against France's id; a point in central Madrid resolves to
~351 km against France's border (plausible — Madrid is roughly that far
from the nearest point on the French border, not from Paris); a point just
north of the Pyrenees resolves to ~12 km, i.e. genuinely close to the
border as expected; an unknown id returns `null` (guarded against in
`inputs.js` so `Math.round(null)` — which JS silently coerces to `0` —
never masks a real lookup failure as a false "0 km"). `npm run build`
clean.

## 2026-09-25 — full hit-region audit: fix over-large "redundant" hulls (Portugal et al.) and an id-collision bug

User reported Finland has a "weird polygonal hitbox that is redundant"
and asked for a full audit of every country's hit-region.

Checked Finland directly first: it doesn't qualify for a hit-region at
all under the current code (its largest part, mainland Finland, is
252.87px² — nowhere near LARGEST_PART_TIER2_RATIO's threshold), so
whatever the user saw wasn't from the code as it stood at the time of
the report — most likely a stale cached bundle from an earlier, more
permissive iteration of this same qualification logic (see the
2026-09-24 archipelago-hitbox-fix entries). Didn't chase that further;
instead took "check if the hitboxes make sense" as a genuine invitation
to audit all 238 countries' actual qualification data rather than one
report, which turned up two real, fixable issues:

**Over-large hulls for countries that don't need one.** Computed
hull-area-to-real-area ratios for every currently-qualifying country and
found Portugal's hull was 18× its own real area (924.85px² for a
51.51px² country) — bigger, in absolute terms, than Philippines' hull
(730.28px² for a country nearly 3× Portugal's size), despite Portugal
not being any kind of real archipelago. Root cause: the existing
single-tier "is the largest part small enough" check couldn't
distinguish Portugal (mainland 0.030× the even-split reference,
*barely* under the old 0.035× cutoff) from Philippines (Luzon, 0.031×,
also barely under) — they're nearly tied on that one signal. What
actually separates them is the *second*-biggest part: Philippines'
Mindanao is 0.88× the size of Luzon (a real second landmass); Portugal's
Azores are 0.008× mainland Portugal (a negligible speck ~52px away that
the hull nonetheless has to stretch to cover). Rebuilt the qualification
logic around two tiers instead of one: genuinely tiny largest parts
(under 0.018×) still qualify unconditionally — this is what keeps
Washington DC-scale cases (Rhode Island, Delaware) and every small
archipelago (Vanuatu, Bahamas, ...) working exactly as the previous
round left them — but a *moderate*-sized largest part (0.018–0.035×)
now additionally needs a real second part (≥0.15× the largest) to
qualify. Fixes Portugal, Croatia, Ireland, Cuba, Malawi, South Korea,
Panama, and similar "one dominant mainland plus an afterthought"
countries; verified every originally-requested country (Maldives,
Philippines, Bahamas, Vanuatu, Solomon Islands, Trinidad and Tobago, the
microstates, ...) and the previous round's US-states fixes (DC, Rhode
Island, Delaware, Hawaii) all still qualify exactly as before. Total
assisted countries: 95 → 81.

**Australia/Ashmore and Cartier Is. id collision.** Found while auditing
the ratio table — an entry labeled "Australia" with a hull 12,000× its
supposed real area turned out to be a pre-existing topology quirk
(flagged but deliberately left alone in an earlier round): Ashmore and
Cartier Is. carries Australia's own id ("036") rather than one of its
own, and `hitAreasById`'s one-entry-per-id map let whichever of the two
features `_reflow` processed last silently decide the shared entry's
qualification — in practice, Ashmore and Cartier's own tiny shape
overwriting mainland Australia's correct, non-qualifying one every
render. Given the broader audit surfaced it as a real, visible case (not
just a theoretical one), fixed it this time: a `processedHitAreaIds`
set in `_reflow` skips every occurrence of an id past the first. Both
shapes still resolve clicks correctly either way — confirmed directly,
clicking each dispatches the same id — only which one gets to shape the
*hit-region* changes.

Verified via jsdom: `_largestPartAreas` (renamed from `_largestPartArea`,
now returns both the biggest and second-biggest part) and the two-tier
qualification check tested directly against real geometry for every
named example above; confirmed Australia's hit-region is correctly
hidden and both id-036 shapes independently dispatch clicks resolving to
the same id; re-ran the complete "must stay assisted" list from every
prior hitbox round (both datasets) with none missing. Scratch scripts
deleted after, per usual.

## 2026-09-25 — fix selected-country color (grey, not blue) — a side effect of the contrast round

User reported a "Could not load game data" error trying Capitals → US
States, which didn't reproduce across an extensive set of jsdom-driven
navigation paths (both question/answer orderings, map-click, pin-mode
downgrade, multiple-choice, text-guess, full round confirm + advance) —
confirmed by curl that the deployed `us-states.json`/topology files
themselves were fine. User then confirmed it actually works; likely a
transient issue (deploy propagation, network hiccup, or a stale cache),
not a real bug — left as-is rather than chasing further.

Real, separate bug: `.country--selected` (the provisional-pick state,
before confirming) used `--accent-dim` as its fill — a dark, desaturated
blue that read fine against the *old* near-black land fill, but reads as
plain grey against the lightened `--map-land` from the previous "better
contrast" round. Changed to a translucent `--accent` (the brighter blue)
instead, which reads as clearly blue at a glance — checked by actually
computing the blended RGB result (`#4d76c9`), not just eyeballing the CSS.

## 2026-09-25 — infinite horizontal scroll, map contrast, smoother panning

Three requests: make the World map scroll infinitely left/right instead
of stopping at an edge, improve the map's contrast, and make panning/
zooming feel smoother (mobile specifically named as where it's roughest).

**Contrast**: measured before touching anything — WCAG-style luminance
contrast between the map's ocean (page `--bg`) and land (`--surface-
raised`) fill was only 1.31:1, and country stroke vs. fill 1.15:1, both
confirmed too low to reliably tell land from water or one country from
its neighbor. Introduced dedicated `--map-ocean`/`--map-land`/`--map-
land-muted`/`--map-border` variables (deliberately separate from the
general `--bg`/`--surface-raised`/`--border` trio buttons/cards use,
which reads fine as-is leaning on its own border+spacing) and picked new
values landing at ~2.9:1 (ocean/land) and ~3:1 (land/border), verified
with the same contrast-ratio script rather than eyeballed.

**Infinite scroll**: the biggest piece. `WorldMap.js` now renders three
side-by-side copies of an unrestricted World view's content (disabled
for a continent-cropped view or the identity-projected US states map,
which don't tile into a seamless loop) — a "home" copy with real click
listeners/hit-areas, flanked by two ghost copies built from SVG `<use>`
references to the home copy's own paths, one world-width to either side.
`<use>` re-renders its target live (including dynamically toggled
classes like `markResult`'s `.country--correct`), so ghosts stay in sync
automatically; each ghost country also got its own click listener
reporting the same id its home path would, once testing surfaced that
relying solely on keeping the home copy "close enough" to the viewport
would leave up to half the visible map unclickable at any given moment.
`translateExtent`'s x bound goes to `[-Infinity, Infinity]` (confirmed
directly against d3-zoom's own `defaultConstrain` source that this
degrades to a no-op rather than producing NaN); every "zoom" tick then
runs through a `_wrapTransform` step that snaps the render by exactly one
world-width whenever the home copy drifts more than half a world-width
off-register — invisible on screen since a ghost already occupies
whatever position the snap shifts to.

Found and fixed a real correctness bug during this work, not after:
pin-drop mode's click handler converts a screen click to lon/lat via
`currentTransform.invert(...)`, which is only correct for a click that
visually landed on the *home* copy — one landing on a ghost needs its x
folded back into the home copy's own coordinate range first (a plain
modulo), since ghost content is a geometric repeat of the same geography
one or more world-widths over. Caught by reasoning through the coordinate
math before writing a test for it, then confirmed with an actual
simulated click at an extreme wrap offset.

**Smoothness**: a pan/zoom gesture in progress now toggles a
`.world-map--panning` class (bound via `zoomBehavior.on("start"/"end",
...)` — a bug caught by its own test: these are d3-zoom's *own*
dispatched gesture events, not native DOM ones, so the first attempt,
bound via the selection's `.on(...)` the same way `dblclick.zoom` is,
silently never fired at all) that sets `shape-rendering: optimizeSpeed`
for the gesture's duration — trading edge antialiasing for faster
per-frame repaints while the player is looking at the whole shape moving,
not any single edge. `will-change: transform` on each copy group is the
complementary compositor hint. Repainting ~240 country paths (more,
counting wrap's ghost copies) at full quality on every drag/wheel tick on
a phone GPU is the likely actual source of the reported jank; a full
Canvas/WebGL rewrite would help more but is out of scope for this round.

Verified via jsdom: `wrapEnabled` correctly true only for an unrestricted
naturalEarth1 view (false for a continent crop and for US states);
correct 3-copy vs. 1-copy DOM structure; clicking a ghost country fires
with the same id its home path would; `_wrapTransform`'s snap math
checked directly across a range of drift/zoom-level combinations, plus
`_applyTransform`'s ghost positioning formula; the pin-mode wrap-modulo
fix verified with a simulated click at an extreme (home shifted a full
world-width) offset, correctly resolving to the clicked country either
way; markResult/highlight/hit-area-assist regression-checked against the
pre-wrap behavior; full wizard-driven end-to-end runs for a World-mode
map-click game (3 copies), a Europe-scoped game (1 copy, wrap correctly
off), and a World-mode pin-drop game (3 copies, pin mode + wrap
together); the start/end panning-class bug caught by directly invoking
the registered handlers and checking the class actually toggled, after
which the fix was confirmed the same way. Scratch scripts deleted after,
per usual — real click-drag smoothness itself is, like the rest of this
map's interaction feel, unverifiable without a real browser.

## 2026-09-25 — Capitals subject (countries and US states)

User asked for a Capitals subject with the same categories as Countries,
including US state capitals within the US states game.

Reused the existing `countries` dataset (world-countries already
provides a `capital` field per item — confirmed all 238 items, no new
fetch needed) rather than standing up a separate dataset: added a
`capital` attribute (`attributes.js`, text prompt, typed/multiple-choice
answer, same shape as `name`) and gave `subjects.js` entries their own
`attributeKeys` override (`["name","location"]` for Countries,
`["capital","location"]` for Capitals) that `gameWizard.js` now prefers
over the dataset's full list — this is what keeps the two subjects
scoped to different question/answer options despite sharing one dataset.

For US states, `us-atlas` (unlike `world-countries`) carries no attribute
data beyond id/name, so state capitals are hand-curated directly in
`generate-us-states-data.mjs` (all 50 states + DC's topology names cross-
checked against the actual feature list first, not guessed) and
`us-states.json` regenerated. District of Columbia gets `capital: null`
deliberately — it's a federal district, not a state, with no capital of
its own.

That null surfaced a real gap: the existing wizard/engine pipeline
assumed every item has a value for every attribute (true for name/
location, not for capital). Fixed generically rather than special-casing
DC: `gameWizard.js`'s new `isAskable(item, questionAttr, answerAttr)`
filters the final playable item set (and the region/sovereignty step
counts, so the displayed number matches what the player actually gets)
to items with a non-null value for both the chosen question and answer
attribute — applied to `dataset.items`, deliberately *not* to
`regionItems` (used for the map's hard crop), so an excluded item like DC
still renders muted on the map rather than vanishing and leaving a hole,
exactly like a sovereignty-excluded territory already does. This same
filter also correctly excludes the three countries with no recorded
capital (Antarctica, Macau, Heard Island and McDonald Islands) from
Capitals-subject rounds, found while checking data completeness before
writing the filter rather than after a bug report.

Verified via jsdom, driving the actual wizard through real button clicks
(`fetch` mocked to the real `public/data/*.json` files): subject step
lists Capitals as enabled; picking it scopes the question step to
Capital/Location (not Name); switching to US States mid-flow with
Capitals active correctly shows "Round 1 / 50" (DC excluded) and a real
state capital as the first prompt; DC still renders on the map as a
muted/unplayable shape rather than being hard-cropped out; Countries
subject's own question step is unaffected (still Name/Location only).
Scratch scripts deleted after, per usual.

## 2026-09-25 — hit-area thresholds made scale-relative (fixes tiny US states, e.g. DC)

User reported small US states — Washington DC named specifically — are
hard to hit on mobile, where there's no hover to compensate for a
too-small tap target.

Measured first rather than guessing: at the US states map's actual
render scale (Albers-projected, fit to 800×500px), DC's own area is
~4.4px² — comfortably *larger* than every country microstate's area
(Vatican City 0.0004px², Monaco 0.007px², ..., Mauritius 0.94px²), so
the existing `AREA_THRESHOLD_SINGLE` (1.2px², a fixed value calibrated
only against the countries dataset in an earlier round) never flagged it
as tiny at all — a real, confirmed gap, not a near-miss. Root cause:
`WorldMap` renders both datasets into the same 800×500px viewport, but
the world map divides that space among ~240 countries while the US
states map divides it among only 51 states — so the "same" px² area
means very different things on the two maps, and any fixed px²
threshold calibrated against one dataset can't transfer to the other.

Fixed by replacing both hit-area qualification constants
(`AREA_THRESHOLD_SINGLE`, `LARGEST_PART_CAP`) with ratios
(`AREA_RATIO_SINGLE`, `LARGEST_PART_RATIO`) measured against a new
per-render reference, `evenSplitArea = (viewport width × height) /
playable feature count` — the area each feature would have if the map
were divided evenly among all of them. Recalibrated against *both*
datasets together this time (previous rounds only checked the countries
dataset): confirmed Washington DC's ratio (0.00057×) lines up almost
exactly with Mauritius's (0.00056×) under this normalization — strong
validation that even-split-area is the right common scale, not a
coincidence — and picked `AREA_RATIO_SINGLE` (0.0007) and
`LARGEST_PART_RATIO` (0.035) to sit cleanly between each dataset's own
boundary cases (Mauritius/Luxembourg and DC/Rhode Island for the first;
Philippines/Greece and Hawaii/Massachusetts for the second — Hawaii
qualifying for hull-fill as a genuine archipelago is a bonus this
surfaced, not something specifically asked for, but harmless and correct
under the same logic). `HULL_BBOX_CAP` (the antimeridian/far-exclave
safety cap) stays a fixed px value on purpose — it's guarding against a
hit-region spanning too much of the *viewport*, which doesn't depend on
how many features share it.

Verified via jsdom: re-ran the full existing countries regression suite
(named archipelagos/microstates still assisted, large/sprawling
countries still excluded, total assisted count 93→95, an expected small
shift from recalibrating against a slightly different but equally
principled methodology) and confirmed District of Columbia, Rhode
Island, and Delaware now get assisted on the US states map while
Connecticut, Massachusetts, Ohio, Texas, Alaska, and California
correctly don't; also checked DC's actual hit-region size (~8.8×9.4px,
up from its raw ~3.6px bbox) and confirmed it's still correctly
Voronoi-clipped against its real neighbors (Maryland, Virginia). Scratch
scripts deleted after, per usual.

## 2026-09-24 — pin-drop click coordinates: fix the actual bug real-browser testing would have caught

User reported pin mode didn't work on the live site, and asked to
double-check the correct/wrong map transparency again.

**Transparency**: re-read every rule touching `.country--correct`/
`.country--wrong` (base and pin-mode-specific) and the cascade around
them — `fill-opacity: 0.6` is set with nothing else in the stylesheet
overriding it at equal-or-higher specificity, and the underlying
`--correct`/`--wrong` color values are reasonable, moderately-bright
colors that read as visibly translucent (not "solid-looking despite the
opacity") against this app's dark background. Source looks correct; no
change made here. (If it still doesn't look translucent, the likely
explanation is the same as pin mode below — a browser holding onto the
pre-fix cached build — since it was already live at the end of the
previous entry.)

**Pin mode**: found a real bug in the click-to-lon/lat coordinate
conversion this sandbox's jsdom-based testing structurally could not have
caught before now. The original code (`pointer(event, this.pathsGroup)`,
from `d3-selection`) relies on that group's `getScreenCTM()` composing
*both* the SVG's viewBox scaling and the paths group's own live zoom/pan
`transform` attribute into one matrix in a single read — correct in
principle, but harder to be fully confident about across real browsers
than doing the two steps explicitly, and `getScreenCTM` isn't implemented
in jsdom at all, so this exact code path had only ever been exercised by
calling the resulting callback directly (bypassing the coordinate math
entirely) — see the previous entry's own "unverified... no real browser"
caveat, which turned out to be hiding a real bug rather than just an
untested-but-fine path.

Replaced with two separate, individually simple steps: `getBoundingClientRect()`
(well-supported everywhere, and — unlike `getScreenCTM` — actually
implemented in jsdom) gives the click's position relative to the SVG's
own top-left corner; since `_reflow` always sets `viewBox="0 0
clientWidth clientHeight"` to match the SVG's own rendered CSS size
exactly, that's already 1:1 with SVG user-space px, no separate viewBox
conversion needed. `this.currentTransform.invert(...)` — `d3-zoom`'s own
purpose-built tool for exactly this — then separately undoes the current
zoom/pan on top of that. Also hardened the pin marker's radius as a
direct SVG attribute (`r="5"`) rather than relying solely on the CSS `r`
property (broadly supported, but no reason to lean on it alone when
setting the attribute directly costs nothing).

Because `getBoundingClientRect` (unlike `getScreenCTM`) *is* implemented
in jsdom, this was actually properly testable this time: mocked the
SVG's bounding rect to a known screen offset, dispatched a real
`MouseEvent` with `clientX`/`clientY` computed from a known lon/lat
projected forward, and confirmed the click handler recovers the exact
original coordinates and resolves to the correct country — both at
identity zoom *and* under an arbitrary applied pan/scale transform
(previously impossible to verify end-to-end at all). Also re-ran the
full existing pin-mode/map-click/us-states regression suite to confirm
nothing else broke. All scratch scripts deleted after, per usual.

## 2026-09-24 — pin-drop answer mode, region/sovereignty item counts, keep-zoom default

Three requests in one round: a new "drop a pin" way to answer location
questions (borderless map, reveal + distance-from-target on confirm),
show each region/sovereignty option's actual item count in the wizard
("All (236)"), and make "keep zoom between rounds" the first-listed and
default Settings option instead of "reset every round".

**Keep zoom default**: `core/settings.js`'s `defaults.keepZoom` flipped
`false` → `true`; `ui/settingsScreen.js`'s `zoomOptions` array reordered
so "Keep zoom between rounds" is first (its button, not "reset", is what
now shows pre-selected the first time Settings is opened).

**Region/sovereignty counts**: previously `loadDataset` only ran at the
wizard's very last step (`startGame`), after every choice — including
region and sovereignty — was already made, so there was no item list yet
to count against at the point those options are actually shown. Moved
the load to `goToRegionOrSkip` (right after answer type is settled)
instead, threaded the loaded items through the rest of the wizard's
config, and added `regionCount()`/`withCount()` helpers used by all three
affected steps' `labelFn`s. A region's count sums whichever of its
children match, for a branch (Africa, America); an option that switches
to a different dataset entirely (Caribbean → US States) shows no count,
since there's nothing to count in the current dataset's terms.
`startGame` still re-awaits `loadDataset` itself for the final build (a
no-op given the loader's own cache) rather than trusting the earlier
load blindly, and still owns `loadSettings` (a display-time concern, not
something any wizard step needs).

**Pin-drop mode** (`location`'s new `"map-pin"` answerKind): the biggest
piece. Player drops a pin on a map rendered with `WorldMap`'s new
`pinMode: true` — no per-country click targets, borders, or hit-area
assists, since a pin can land anywhere, not on a discrete feature — via
one whole-map click listener that resolves screen coordinates through
both the SVG's viewBox scaling and the current zoom/pan transform
(`d3-selection`'s `pointer(event, pathsGroup)`) back to the untransformed
space `projection.invert()` expects. Which country (if any) the resulting
lon/lat point falls inside is resolved by a plain ray-casting
point-in-polygon test directly on the raw GeoJSON ring coordinates
(`_findContainingId`/`pointInFeature`, new in `WorldMap.js`) — no SVG
geometry APIs, so it's unaffected by zoom/projection and is plain
unit-testable. That resolved id is reported via the exact same
`onSelect(id)` channel as map-click, so `QuizSession`/`attributes.js`'s
existing id-equality `checkAnswer` needed zero pin-specific changes —
only `inputs.js`'s new `"map-pin"` renderer differs, adding a
great-circle distance (`haversineKm`, using items' existing `latlng`
field from world-countries) between the dropped pin and the target
country to the post-confirm feedback text, on top of the outline reveal
`map.markResult` already provides.

Scoped to datasets with real geographic coordinates only:
`gameWizard.js`'s `availableAnswerKinds` prunes `"map-pin"` back out
whenever `datasetMeta.projection === "identity"` (US states' pre-
projected Albers topology has no lon/lat to invert a click to) — kept out
of `attributes.js` itself so that module stays dataset-agnostic. Caught
one real edge case while implementing this: answer type is picked
*before* region, but region can switch the active dataset entirely
(Caribbean → US States), so a player could pick "Drop a pin" while still
on the countries dataset and only then navigate to US States — verified
this actually reached `startGame` with an invalid `answerKind` before the
fix; `showSubRegionStep`'s dataset-switch branch now re-validates
`answerKind` back down to `"map-click"` at the exact point of switching.

Verified via jsdom scratch scripts (project root, deleted after):
`_findContainingId` resolving real coordinates correctly (Paris → France,
Berlin → Germany, mid-Pacific → null), pin marker placement/
repositioning across a reflow, the `onClick` callback signature end to
end by capturing `WorldMap.prototype.setClickable`'s callback (real DOM
click-to-lonlat math needs `getScreenCTM`, which jsdom doesn't
implement — same boundary already documented for click hit-testing
elsewhere in this file), the `inputs.js` widget's distance output
cross-checked against an independently-written haversine calculation,
the wizard's region/sub-region/sovereignty labels showing correct counts
by driving `startGameWizard` through real button clicks with `fetch`
mocked to the actual `public/data/*.json` files, the US-States exclusion
and the answerKind-correction edge case (drove the wizard through "Drop a
pin" then "US States", confirmed the resulting game screen used
`map-click` behavior, not `map-pin`), and the Settings default/ordering
change. Whether a real click's coordinates resolve correctly through
`getScreenCTM` in an actual browser is, like the rest of this map's click
handling, unverified in this sandbox.

## 2026-09-24 — archipelago hit-area fix, take two: scope way back down

User reported "a lot of hitboxes are broken now" right after the previous
entry's change, plus a separate, unrelated complaint that the map's
correct/wrong fill colors (green/red) were solid instead of translucent.

**Fill colors**: straightforward — `.country--correct`/`.country--wrong`
in `style.css` now also set `fill-opacity: 0.6` (not plain CSS `opacity`,
so the border stroke stays fully solid and only the fill fades).

**Hitboxes**: the previous entry's qualification rule ("any country with
2+ parts qualifies, regardless of size") was the bug. Counted it directly:
118 of the dataset's 238 playable countries have 2+ parts (any country
with even one stray offshore islet in the 50m topology resolution
counts), so the fix had accidentally put a convex-hull hit-area over
*half the world* — including Russia, Canada, USA, China, Brazil,
Australia, India, and every other large country with a scattering of
tiny coastal/arctic islands. A hull spanning a whole continent's bbox,
clipped only against other countries' single bbox-center points, is a
bad approximation for a huge, irregularly-shaped country — this is almost
certainly what the user was seeing as "broken."

Recalibrated with actual data instead of guessing again: computed each
multi-part country's *individual part* areas (splitting the MultiPolygon
apart and running `pathGen.area` on each piece), sorted by total area, and
read down the list for the value that would need to separate "wanted"
from "not wanted." The fraction-based idea considered along the way
(exclude if one part is >50% of the total) doesn't work — Indonesia's
biggest island is only 28% of its total area yet is obviously still huge
and easily clickable (250px²) — but a **pure absolute size** cutoff on the
single biggest part does: Philippines' biggest island (Luzon, 51.46px²)
needs to stay under the cutoff, Greece's (60.75px²) needs to stay over it,
and every huge country's biggest part is already in the thousands of
px², nowhere near either number. Landed on `LARGEST_PART_CAP = 55`,
replacing the old "parts >= 2 always qualifies" rule — see the updated
comments in `WorldMap.js` and "Map" in `DESIGN.md` for the full
qualifying logic and the exact numbers behind it.

Re-ran the same jsdom verification as before against this new rule:
confirmed the 25+ genuinely-tiny/archipelago countries from the original
ask (Maldives, Philippines, Bahamas, Vanuatu, Solomon Islands, Comoros,
Cape Verde, Tonga, Micronesia, Marshall Islands, Wallis and Futuna, Saint
Vincent and the Grenadines, Antigua and Barbuda, Brunei, Trinidad and
Tobago, and the original microstates) still qualify, and separately
confirmed every large/sprawling country (Russia, Canada, USA, China,
Brazil, Australia, France, Chile, Ecuador, New Zealand, Netherlands) plus
the previously-overreaching UK/Norway/Greece/Indonesia/Japan/Malaysia no
longer do. Total assisted countries dropped from 118 to 93 out of 238
playable — the remaining 93 include a number of smaller countries not
originally named (Croatia, Denmark, Ireland, Portugal, Cuba, South Korea,
...) whose own biggest part is modestly sized; left these in rather than
hand-excluding them, since they're compact, safe under the same rule that
correctly excludes the sprawling cases, and getting the same gap-fill
benefit for them isn't a regression.

While debugging, found and documented (but deliberately did not fix) an
unrelated, pre-existing, single-instance data quirk: the topology assigns
Ashmore and Cartier Is. the same id ("036") as Australia itself, so they
collide in `WorldMap`'s per-id maps. Confirmed this is the *only* such
collision in the whole dataset, and that it's functionally harmless
either way (Ashmore and Cartier Is. genuinely is Australian territory, so
either feature correctly resolves clicks to "Australia") — not the cause
of this round's bug report, not touched.

## 2026-09-24 — archipelago hit-area fix (Maldives, Philippines, and similar)

User reported Maldives' hit-area was too small/tough to click, named
Philippines as a similar case, and asked that the fix generalize ("check
for similar country sizes") rather than special-case just those two.

Investigated with throwaway `node -e` scripts (measuring `pathGen.area`/
`pathGen.bounds`/part-count for every country at the real ~800px map
scale) before writing any code, per this project's usual calibrate-first
approach:

- Maldives' bounding box (2.65px) was actually *past* the old
  `TINY_THRESHOLD` (1.5px), so it got **no** assist circle at all despite
  having smaller true area (0.032px²) than several countries that did —
  a real bug, not just "needs to be bigger". Its two atolls sit only
  ~2.65px apart on the projected map.
- Philippines isn't tiny (139.99px² total, largest single island alone
  ~51px²) — its problem is 48 separate parts with no gap-filling between
  them, a different failure mode than "too small".
- Kiribati (785px bbox) and Fiji (800px) are antimeridian-wraparound
  artifacts in the topology data, not real archipelago shapes — any fix
  needed to explicitly exclude these rather than build a hull from them.

Replaced the old bbox-threshold-triggered `<circle>` mechanism in
`WorldMap.js` with a padded-convex-hull `<polygon>` mechanism: any
single-blob country under a calibrated area cutoff (`AREA_THRESHOLD_SINGLE`,
covers the same microstates as before — Vatican City, Monaco, San Marino,
etc.) or any country with 2+ separate parts (covers Maldives, Philippines,
Bahamas, Vanuatu, Solomon Islands, Comoros, Cape Verde, Tonga, Micronesia,
Marshall Islands, Wallis and Futuna, Saint Vincent and the Grenadines,
Antigua and Barbuda, and more) gets a convex hull built from all its
projected ring points, padded outward 3px from its centroid, as its
click target — naturally filling the water between a country's islands,
not just sizing up each part individually. A bbox safety cap
(`HULL_BBOX_CAP`, 150px) excludes the Kiribati/Fiji degenerate cases.

The generalization also pulls in larger multi-part countries (UK, Norway,
Greece, Croatia, Indonesia, Japan, Malaysia, Brunei) that weren't part of
the original ask — left in deliberately rather than hand-excluded, since
the existing Voronoi-cell clipping (already used to keep neighboring
microstates' assist circles from overlapping) generalizes cleanly to stop
these larger hulls from reaching into a real neighbor's territory too
(e.g. Brunei's hull naturally spans the gap between its two enclaves,
which is Malaysian territory — clipped to Brunei's own Voronoi cell before
rendering). This needed widening the Voronoi diagram from "just the tiny
countries" to every playable country's bbox-center, so an un-assisted
ordinary neighbor still bounds an assisted country's hull.

Verified via jsdom scratch scripts (written to the project root so
`node_modules` resolution worked, deleted after): confirmed every named
target country now shows an assisted hit-area, confirmed Kiribati/Fiji
stay excluded, confirmed the previously-excluded ordinary small countries
(Luxembourg, Cyprus) still aren't assisted (no regression), confirmed
click events still fire with the correct id after swapping the hit-area
element from `<circle>` to `<polygon>`, and confirmed the us-states
dataset (identity projection, single-part features only) still reflows
without error. Whether the padded hulls are visually well-sized and the
Voronoi clip genuinely prevents overlap in a real renderer is unverified —
no real browser available in this sandbox (see "Environment notes" in
DESIGN.md).

## 2026-09-24 — deploy is manual-only, by request

User confirmed the live deploy works, then asked that it only upload to
the site when explicitly asked — not automatically on every push to
`main`. Removed the `push` trigger from `deploy.yml`, keeping only
`workflow_dispatch`; from here, shipping a change live is a deliberate
"Run workflow" (Actions tab, or `gh workflow run "Deploy to Namecheap"`),
not a side effect of committing.

## 2026-09-24 — git init, GitHub remote, deploy pipeline to Namecheap

First time this project has been under version control — previously
relied entirely on the local `archive/` tarball convention. User wants it
on GitHub and live on their existing Namecheap (cPanel) site.

- `git init`, initial commit (33 files — everything except `node_modules`/
  `dist`/`archive`, which were already gitignored; added `archive` to
  `.gitignore` too, since real git history now supersedes what those
  tarball snapshots were standing in for). Remote added:
  `https://github.com/zigakorosak/geoquiz`.
- Target is a subdirectory, `<domain>/geoquiz/`, not the domain root —
  added `vite.config.js` (didn't exist before, Vite was running on pure
  defaults) with `base: "/geoquiz/"`. Verified in a real build rather than
  assuming: checked the built `index.html`'s script/link tags *and*
  grepped the built JS bundle for the `import.meta.env.BASE_URL`-prefixed
  data-fetch URLs from `datasets.js` — both correctly resolved to
  `/geoquiz/...` before treating this as done.
- No Node/npm guaranteed on the shared cPanel host, so the build has to
  happen elsewhere: added `.github/workflows/deploy.yml` — builds on
  GitHub's runner (guaranteed clean Node environment) and FTPS-uploads
  `dist/` to `public_html/geoquiz/` on push to `main`. Documented the
  one-time secret setup (FTP_SERVER/FTP_USERNAME/FTP_PASSWORD as GitHub
  repo secrets, plus recommending a cPanel FTP account scoped to just
  that subdirectory rather than the full-access login) directly in
  `DESIGN.md` under a new "Deployment" section, rather than adding a
  third markdown file — the project convention is exactly two.
- Deliberately did **not** handle the credential-bearing steps myself:
  this machine had no SSH key, no git config, and no `gh` CLI at all
  (confirmed by checking, not assumed) — pushing to GitHub and adding the
  FTP secrets both need the user's own authentication, and FTP passwords
  specifically shouldn't be typed into a chat session regardless of who's
  capable of handling them. Asked two questions before touching anything
  irreversible: what "the site" actually was (Namecheap/cPanel, not
  GitHub Pages) and where in it this should live (a subdirectory,
  `public_html/geoquiz`) — both had real consequences for `vite.config.js`
  and the workflow's `server-dir`, not just cosmetic ones.
- User installed and authenticated `gh` CLI on this machine; pushed both
  commits. The remote repo turned out non-empty (a single GitHub-generated
  `README.md` from repo creation) — merged with `--allow-unrelated-
  histories` rather than force-pushing over it, since there was a safe,
  non-destructive option available.
- Two real deploy bugs surfaced only by actually running the workflow and
  reading its logs, not by reasoning about the config in the abstract:
  1. `SamKirkland/FTP-Deploy-Action@v4` doesn't exist as a tag (only exact
     versions do) — pinned to `v4.4.0`.
  2. `FTP_SERVER` set to `ftp.zigakorosak.com` (what cPanel's "Configure
     FTP Client" panel showed) failed DNS resolution — confirmed
     independently with `nslookup` rather than assuming the secret was
     mistyped, which showed genuine `NXDOMAIN`, while the bare domain
     `zigakorosak.com` resolved fine. That `ftp.` subdomain record simply
     doesn't exist; switched to the bare domain.
  3. `server-dir: /public_html/geoquiz/` was wrong once the *account's
     own* FTP login root turned out to already be scoped to
     `public_html/geoquiz` (visible in cPanel's FTP Accounts "Path"
     column) — the path was being applied twice, nesting a duplicate
     `public_html/geoquiz` inside itself, confirmed by fetching the live
     (broken) URL and seeing a directory listing rather than the app.
     Changed `server-dir` to `./` (the FTP root) and added
     `dangerous-clean-slate: true` to clear the stray nested folder — safe
     specifically because this FTP account's root is scoped to only this
     app's directory, not shared with anything else on the site; flagged
     this as a destructive step and got explicit confirmation before
     running it, same as any other action that alters a live external
     system.
- Live and verified end-to-end at `zigakorosak.com/geoquiz/`: fetched the
  page and confirmed it's the actual app (not a redirect stub or
  directory listing), then fetched the JS bundle, CSS, both dataset JSON
  files, and the favicon individually (following the site's existing
  www-redirect) to confirm every asset the app depends on actually loads,
  not just the HTML shell.

## 2026-09-24 — US States (the second real dataset, and the first non-country one)

- Asked first where this should live before building anything, since it
  had real architectural consequences either way: a new top-level Subject
  (like Countries), or a region-level choice nested under America. User
  confirmed the latter — a 4th sibling alongside North America/South
  America/Caribbean in the America sub-region screen, switching to a
  states-level map and skipping the country-specific Sovereignty step
  (doesn't apply to states).
- **Data**: `us-atlas` (ISC, same maintainers/format as `world-atlas`,
  already in use). Used its pre-projected `states-albers-10m.json` (51
  features: 50 states + DC) rather than the raw `states-10m.json` (56
  features — the extra 5 are territories: Puerto Rico, Guam, American
  Samoa, Northern Mariana Islands, US Virgin Islands, scattered across the
  Pacific/Caribbean, which Albers USA's fixed three-conic multiplex isn't
  built to project and which aren't "US States" anyway). New script,
  `scripts/generate-us-states-data.mjs`, mirroring the existing
  `generate-data.mjs` pattern. Minimal item schema (`{ id, name }`) since
  nothing currently reads more than that.
- **WorldMap gained a `projection` option**: `"naturalEarth1"` (default,
  raw lon/lat, used for countries) or `"identity"` (pass-through, for
  us-states' already-Albers-projected topology — needs `fitSize` to scale
  it to the viewport, not project it a second time). Resolved from a
  string key so `datasets.js` never has to import d3 directly, consistent
  with how `dashedBorders` and other map config already flow through
  `dataset.*` → `prompts.js`/`inputs.js` → `WorldMap`.
- **New dataset entry**, `us-states`, with `supportsRegionFilter` and
  `supportsSovereigntyFilter` both false. Deliberately has no entry in
  `subjects.js` — it's never picked from the Subject step, only reached
  via `regions.js`.
- **`regions.js`**: America's `children` gained a 4th entry, `{ key:
  "us-states", label: "US States", datasetKey: "us-states" }` — no
  `match`, since it isn't a filter over the countries dataset like its
  three siblings, it switches datasets entirely.
- **`gameWizard.js`**: `showSubRegionStep` now checks for a picked child
  with `datasetKey` and, if present, swaps `config.subject`/`meta` to the
  new dataset and re-enters the *existing* `goToRegionOrSkip` chain rather
  than needing a bespoke skip path — since `us-states` declares neither
  region nor sovereignty support, that chain already knows to skip both
  and go straight to the game. The skip-chain machinery built for "some
  datasets don't need every step" turned out to generalize cleanly to
  "and some region choices don't even keep the same dataset," with no new
  plumbing beyond the one `if (r.datasetKey)` branch.
- **Small generalization**: the `name` attribute's wizard-facing label was
  hardcoded "Country Name" — harmless when only Countries existed, but
  visibly wrong once picking "Name" as a question/answer type could lead
  to playing US States instead. Renamed to just "Name" (this label is
  never shown during actual gameplay, only in the wizard's own buttons —
  see "Attributes" in `DESIGN.md`).
- Verification: `npm run build`, dev-server checks on every touched/new
  file including the two new data endpoints, and jsdom tests: the
  generated data itself (51 items, Alaska/Hawaii/DC present, no
  territories), the full wizard path (Subject → Q&A → America → US States
  skips straight to a live game with all 51 states rendered and real path
  geometry on each — confirming the identity-projection wiring actually
  produced usable coordinates, not just that it didn't crash), multiple-
  choice distractors scoped to states only (never leaking a country name
  in), back navigation out of the America sub-region screen, and a
  regression pass confirming the ordinary North America / South America /
  Caribbean paths through the same screen are unaffected. All thrown away
  after use. Never having a real browser available is a real gap here in
  particular — the Albers USA layout (Alaska/Hawaii inset placement,
  relative state sizes) is exactly the kind of thing that's fine
  geometrically (valid path data, as confirmed) but could still look off
  in ways only a rendered screenshot would catch.

## 2026-09-24 — fix: grayed-out answer controls swallowed click-to-advance

User reported: after answering in multiple-choice mode, clicking one of
the now-grayed-out option buttons didn't advance to the next round the
way clicking anywhere else on screen does.

- Root cause: `showResult` was setting the native `disabled` property on
  the option buttons (and, same bug, the text-guess `<input>`). A disabled
  form element doesn't dispatch a click event at all in a real browser —
  the event never fires, so it never bubbles to `game.js`'s root "click
  anywhere advances" listener. Map-click never had this bug: it gates
  clicks through its own `clickEnabled` flag rather than the native
  `disabled` attribute, so its click events always fire and bubble
  normally regardless of game phase.
- Fixed both widgets the same way map-click already worked: track
  lock state as a plain flag the widget's own handler checks (`locked` for
  multiple-choice, `readOnly` for the text input — readonly inputs still
  dispatch click events, only `disabled` ones don't), instead of using the
  DOM's native disabling. Visual "grayed out" look now comes from a CSS
  class (`.menu-option--locked`) rather than `:disabled` styling.
- Verification gap worth naming: jsdom doesn't reproduce this bug at all
  — dispatching a synthetic click on a `disabled` button via
  `element.dispatchEvent()` fires and bubbles normally in jsdom, unlike
  real browsers, which suppress the click during native user interaction
  with a disabled element. Confirmed this directly with an isolated
  jsdom check before relying on it further. So the jsdom test written for
  this fix can only confirm the new mechanism is wired correctly (no
  native `disabled` attribute present, locked state tracked separately,
  clicking a locked control does advance the round) — it cannot confirm
  the original bug was reproducible in this environment, only that it's
  real per the HTML specification and standard browser behavior. This is
  the clearest case yet of this sandbox's testing limits actually
  mattering for correctness, not just cosmetics.
- Otherwise verified normally: `npm run build`, dev-server checks, and
  the jsdom test above for both multiple-choice and text-guess, plus
  confirming normal answering-phase selection/reclick-confirm still work
  unaffected by the new `locked` guard. Thrown away after use.

## 2026-09-24 — reorder wizard: subject first, then question/answer, then region

User asked for subject to come before question/answer type (previously
question → answer → subject → region → sovereignty; now subject →
question → answer → region → sovereignty).

- Straightforward reorder in `gameWizard.js` — same continuation-passing
  back-navigation pattern, just chained in the new sequence.
- This wasn't purely cosmetic: it resolved a limitation flagged (in both
  `DESIGN.md` and code comments) since the wizard was first built —
  question/answer type used to read from the *global* attribute registry
  because the subject wasn't known yet at that point in the flow. Now
  that subject comes first, both steps read
  `resolveAttributes(meta.attributeKeys)` — scoped to whatever the chosen
  subject's dataset actually supports. With only one subject (countries)
  this doesn't change what's shown today, but it removes a known rough
  edge for whenever a second subject with a different attribute set gets
  built, rather than leaving it as deferred work.
- Verification: `npm run build`, dev-server check, and a jsdom test
  confirming the full new order end-to-end (subject → question → answer →
  answer-kind → option-count → region → sub-region → sovereignty → live
  game, with the right round count and multiple-choice option count),
  plus back-navigation at both ends (question step back → subject step;
  subject step back → home). Thrown away after use.

## 2026-09-24 — correction: the overlap runs Europe→Asia, not Asia→Europe

Follow-up to the previous entry — the user corrected the direction of the
transcontinental overlap and gave a fuller target table (per-region
"country count" vs. this app's "game all"/"game sovereign" figures) to
pin it down precisely: Georgia, Türkiye, Cyprus, and Russia should be
**Europe-only** for Europe's own count, and *additionally* shown when
playing Asia — the reverse of what got built last time (which made them
count for both regions symmetrically, treating Europe as the one gaining
a bonus).

- Reverse-engineered the mechanic from the numbers rather than just the
  prose, since "all only European, but also shown in Asian mode" is
  ambiguous on its own: the target table has Europe's "game all" figure
  exactly equal to its "country count" figure (53 = 53, no inflation),
  while Asia's "game all" (53) exceeds its own "country count" (49) by
  exactly 4 — the four named countries. That confirms Europe owns them
  outright and Asia only gets a bonus, not a symmetric pairing.
- Implemented as two name sets in `regions.js`: `EUROPE_ONLY` (Georgia,
  Türkiye — excluded from Asia's own `match`, added to Europe's) and
  `ASIA_BONUS` (all four — added to Asia's `match` on top, regardless of
  their real region). Cyprus and Russia needed no override for Europe
  (already natively `region: "Europe"` in world-countries), only for the
  Asia-bonus addition.
- Resulting counts: Europe 54, Asia 52 — consistently one over the user's
  53/53 target in both cases, same "off by exactly one" pattern as the
  first attempt. Verified this is arithmetically real (not a bug) by
  computing it directly rather than by hand. Didn't chase it further to
  force an exact match — flagged the discrepancy plainly instead of
  guessing which single country to additionally adjust; cheap for the
  user to name if they want it closed.
- Verification: `npm run build`, dev-server check, a jsdom test
  confirming a live wizard-launched Asia game's round count and rendered
  map both match `getRegion("asia").match()` exactly and include all four
  countries as clickable shapes, and a direct check that Africa's and
  America's splits are still disjoint (unaffected by this change). Thrown
  away after use.

## 2026-09-24 — Georgia/Türkiye also playable under Europe

User provided target per-region counts (Europe 53, Africa 58, America 52,
Asia 49, Oceania 24) to check against; ours summed to 234 vs. their 236,
with Africa matching exactly and the other four each off by 1 in a
pattern that didn't look like a simple reclassification (those preserve
the total). Rather than guess which countries to move — real-world
country-to-continent classification is exactly the kind of judgment call
worth getting from the user directly rather than assuming — asked how
they'd like to reconcile it. They named the specific countries: Georgia
and Turkey should be "also" in Europe.

- Read "also" literally: these are transcontinental countries (Georgia —
  Caucasus; Türkiye — Bosphorus splits it between Thrace and Anatolia),
  so they should be playable under *both* Europe and Asia, not moved
  exclusively to one. Added a `TRANSCONTINENTAL_EUROPE` set to
  `regions.js`, matched by name (`"Türkiye"`, the actual stored name —
  world-countries updated from "Turkey" in the 2022 rename; confirmed by
  searching the generated data since a literal "Turkey" lookup missed).
  Europe's `match` now also includes these two; Asia's is untouched
  (still matches on `region === "Asia"`, which already covered them).
  This is the first and only intentional overlap in the region tree —
  every other split (Africa North/South, the three Americas buckets)
  stays a strict partition, checked as such.
- Result: Europe 52 → 54, Asia unchanged at 50. Doesn't land exactly on
  the user's 53/49 (an exclusive-move interpretation would have, roughly)
  but matches what was actually asked — flagged this rather than quietly
  reinterpreting "also" to force the numbers to line up. America (51 vs.
  target 52) and Oceania (23 vs. target 24) are still open; the user can
  name countries for those the same way whenever they want to.
- Verification: `npm run build`, dev-server check, and a jsdom test
  confirming a live wizard-launched Europe game's round count and
  rendered map both include Georgia/Türkiye, and a live Asia game's count
  is unchanged (54 Europe / 50 Asia, not 52/48 or any variant that would
  indicate they'd been moved instead of duplicated). Thrown away after
  use.

## 2026-09-24 — multiple-choice answer mode (2–6 options)

- **`attributes.js`**: `answerKind` (a single string per attribute)
  became `answerKinds` (a list) — `name` now declares
  `["text-guess", "multiple-choice"]`, `location` stays `["map-click"]`.
  This is what lets one attribute support more than one way to answer
  with it; `game.js` no longer reads a fixed kind off the attribute, it
  receives whichever specific kind the wizard resolved to.
- **New `"multiple-choice"` widget** (`inputs.js`): draws `optionCount`
  buttons — the correct value plus distractors drawn from `dataset.items`
  (so they're always plausible members of whatever region/sovereignty is
  actually in play, not random countries from anywhere), all shuffled.
  Reused the exact same select-then-reclick-to-confirm interaction as
  map-click (click an option to select it, click it again to confirm,
  click a different one to change the pick) rather than inventing a new
  interaction model, so every answer widget in the app now behaves the
  same way. Correct/wrong options highlight green/red after confirming,
  same as the map does. Exported `shuffle` from `engine.js` (previously
  module-private) to reuse it here instead of duplicating the algorithm.
- **Two new wizard steps**, both conditionally shown: after picking an
  answer attribute, if it has more than one `answerKinds` entry, a "how
  do you want to answer with the [X]?" step appears (skipped entirely for
  `location`, which only has one); if "Multiple choice" is picked, a
  "how many options?" step follows with buttons for 2–6. Both steps
  reuse the same back-navigation pattern as every other wizard step.
- Small-pool safety: a tiny region (e.g. a 3-country test case) playing
  6-option multiple choice caps at however many distractors actually
  exist rather than crashing or padding with anything fake.
- Verification: `npm run build`, dev-server checks, and jsdom tests
  covering the widget directly (option count, no duplicates, correct
  answer always included, select/reselect/reclick-confirm, correct/wrong
  highlighting, the small-pool cap) and the full wizard path (the two new
  steps appear with the right labels/options only when expected, and are
  skipped for `location`), plus a regression pass confirming the
  pre-existing text-guess and map-click paths are unaffected. All thrown
  away after use. Still no real browser to see how the option buttons
  actually lay out or feel to tap.

## 2026-09-24 — full navigation rewrite: home/games/map/settings, multi-screen wizard

The biggest single change so far — replaced the entire single-page menu
with a proper multi-screen app structure, per a detailed spec: main
screen (Games/Map/Settings) → games flow as five sequential full screens
(question type, answer type, subject, region [+ sub-region for Africa/
America], sovereignty) → play.

- **Home screen** (`ui/home.js`): three destinations. `main.js` shrank to
  a ~20-line router with no URL/history handling — the whole app is one
  page, screens just replace `#app`'s contents.
- **Games wizard** (`ui/gameWizard.js`, new): every choice that used to be
  a section on one scrolling menu page is now its own full screen, with
  Back navigation all the way to home. Built on a new shared
  `renderChoiceScreen` (`ui/screenKit.js`) so every choice screen in the
  app — home, each wizard step, later settings — looks and behaves the
  same. Back-navigation uses continuation-passing (each step's `goBack`
  closure just re-renders itself) rather than a history stack; simple,
  and it fell out naturally from how the old menu.js already threaded
  callbacks around.
- **Subject step + `core/subjects.js`** (new): only "Countries" is real;
  Capitals/Flags/Emblems/Currencies/Cities are listed disabled with a
  "Coming soon" hint, per the requested roadmap. Deliberately kept
  separate from `datasetMeta` — a subject doesn't need a real dataset to
  be listed, only to be picked.
- **Region hierarchy expanded** (`core/continents.js` → `core/regions.js`,
  renamed since it's no longer flat): Africa now splits into North/
  Southern Africa (UN's "Northern Africa" subregion vs. everything else —
  no finer split available). America now splits into North/South/
  Caribbean instead of North/South, with Central America folded into
  North (traditional continent boundary) and Caribbean now its own
  bucket. The Trinidad and Tobago/Grenada → South America override from
  two rounds ago is preserved and now excludes them from Caribbean too
  (checked all three Americas buckets stay mutually exclusive and still
  cover every Americas country).
- **Sovereignty step replaces the extra-territories toggle**
  (`core/sovereignty.js`, new): "All" vs. "All Sovereign," using the
  `independent` field `world-countries` already provided but the app
  never read before. This is a real simplification, not just a rename —
  "All Sovereign" excludes ordinary dependent territories (Puerto Rico,
  Bermuda, Hong Kong, ...) *and* Kosovo/Somaliland/Northern Cyprus (none
  have `independent === true`) with one principled filter, replacing two
  overlapping concepts (a general non-sovereignty notion and an ad hoc
  per-country flag) with one. 193 of 238 items are sovereign — close
  enough to the commonly-cited ~195 world states to trust the field means
  what it's supposed to. `isExtraTerritory` stays in the generated data
  as provenance metadata; nothing filters on it anymore.
- **Settings screen + `core/settings.js`** (new): the zoom-persistence
  choice moved out of the per-game wizard into a real, localStorage-backed
  global preference — a Settings screen implies something durable, not
  re-asked every game. `gameWizard.js` reads it at the very last step
  (`loadSettings()`, alongside `loadDataset()`) rather than asking.
- **Map explore screen** (`ui/mapExplore.js`, new): free-explore mode —
  the whole world, every item clickable (including extra territories,
  unconditionally — no sovereignty filter in explore mode), click a
  country to see its name, no quiz mechanics. Reuses `WorldMap` exactly
  as the game screens do.
- `game.js`'s `continent`/`continentItems` props renamed to `region`/
  `regionItems` throughout, matching the broader concept now that
  "region" covers sub-continent splits and World, not just continents.
- One small defensive fix enabling all of this to be tested: `datasets.js`
  read `import.meta.env.BASE_URL` unguarded, which only exists under
  Vite's build-time `define` — changed to `import.meta.env?.BASE_URL ??
  "/"`, a no-op under Vite (always defined there) but lets the module load
  in plain Node for testing.
- Verification: same no-real-browser constraints as every round, but this
  was the largest surface-area rewrite so far, so testing was
  correspondingly broader. jsdom scripts covering: the full happy path
  (home → all 5 wizard screens → live game) for both a leaf region
  (Europe) and a branch region with its sub-screen (Africa → North
  Africa), sovereignty actually changing the round count, back navigation
  at every level (including the sub-region-specific back target), the
  subject step's disabled/enabled rendering, map explore (all items
  clickable, name-on-click, back-to-home), settings (persists via
  localStorage, reflects on re-render, and — checked as a real
  integration, not just in isolation — actually reaches a wizard-launched
  game's `keepZoom` behavior end-to-end via a real `WheelEvent`), and a
  final pass confirming the timer, dashed border, Voronoi hit-circles, and
  reclick-confirm from earlier rounds all still work launched through the
  new wizard instead of the old menu. All thrown away after use. This is
  by far the least-verified round yet in terms of what a real browser
  would actually show — the screen-to-screen navigation logic is well
  tested, but none of the new screens' actual visual layout, spacing, or
  feel has been seen rendered at all.

## 2026-09-24 — Trinidad/Grenada to South America, dashed disputed border, fix Kosovo hole

- **Trinidad and Tobago (+ Grenada) reclassified to South America**:
  world-countries files both under "Caribbean" subregion (so they'd land
  in North America under the existing rule), but both sit on/right off
  the South American continental shelf and are commonly grouped there.
  Added an explicit `SOUTH_AMERICA_OVERRIDES` name set in `continents.js`
  rather than a subregion rule, since world-countries has no finer split
  to key off. Verified NA/SA are still mutually exclusive and still sum to
  all 51 Americas countries after the move.
- **Dashed Serbia/Kosovo border**: used topojson's `mesh(topology,
  object, filter)` to extract *just the shared arc* between the two
  countries — not Kosovo's whole outline — since topology format stores
  a shared border once and `mesh()` with an id-pair filter returns
  exactly that. Made it data-driven (`dashedBorders: [["688", "UNK"]]` on
  the countries dataset in `datasets.js`) rather than hardcoding "Kosovo"
  inside `WorldMap.js`, consistent with keeping that module dataset-
  agnostic. One pre-built `<path class="border--disputed">` per
  configured pair, recomputed each `_reflow`; clears itself if either
  side isn't part of the current continent crop.
- **Fixed: Kosovo (and Somaliland, Northern Cyprus) disappearing entirely
  in continent mode with extra territories off** — a real bug, not just a
  cosmetic gap. Root cause: `game.js`'s continent hard-crop
  (`mapFeatureIds`) was being derived from `dataset.items`, which already
  had the extra-territories toggle applied — so choosing e.g. "Europe"
  with the toggle off didn't just mute Kosovo (as World mode already did
  correctly), it hard-cropped it out of the topology entirely, leaving a
  literal hole in Serbia's territory instead of a muted shape. Fixed by
  having `menu.js` compute `continentItems` (continent match only, extra
  territories always included) separately from `dataset.items` (continent
  + toggle), and having `game.js` build the hard crop from `continentItems`
  while the soft gate (`playableIds`, already correct) still comes from
  `dataset.items`. This is the same fix needed to make the dashed border
  above survive continent mode too — the border check depends on both
  countries still being part of the rendered topology.
- Verification: same no-real-browser constraints as every round. `npm run
  build`, dev-server checks, and jsdom tests: the shared-border mesh
  renders a real path in World mode, still renders when continent-cropped
  to Europe (both sides present), clears cleanly with neither side present
  (Oceania crop, no crash), and — the actual regression test for the bug —
  a live `game.js` run with Europe + toggle off confirmed Kosovo now
  renders muted (`.country--unplayable`) with the full continent shape
  count on the map, instead of being missing from it. Plus a full
  regression pass (South America's new membership through the real
  continent-crop/reclick-confirm/feedback flow, keep-zoom, and the
  Voronoi hit-circle clipping) confirming the `WorldMap` group-ordering
  changes (a new `.border-lines` group inserted between country paths and
  hit-circles) didn't break anything built in earlier rounds.

## 2026-09-24 — smaller hitbox + Voronoi split for overlapping microstates

- Shrank `HIT_DIAMETER` from 8px to 6px — a further, smaller tweak on top
  of last round's recalibration.
- **Overlapping tiny-country hitboxes now split along the line equidistant
  between them** instead of one arbitrarily winning by DOM order. Real
  clusters exist in the data — checked by computing actual pairwise
  distances between all ~40 tiny-country centers at a reference map size:
  the Lesser Antilles has half a dozen microstates within a few
  hit-circle-radii of each other, and Saint Martin/Sint Maarten are
  literally the same island split Dutch/French (0.13px apart pre-hitbox).
  Added `d3-delaunay`: every reflow, computes a Voronoi diagram over just
  the currently-tiny centers and clips each hit-circle (SVG `clip-path` →
  a `<clipPath>`/`<polygon>` pre-built per playable feature at
  construction, points updated each reflow) to its own cell. A country
  with no nearby tiny neighbor gets a cell far bigger than its own circle,
  so the clip is applied uniformly to every tiny circle but is a pure
  geometric no-op when there's nothing to split against — no separate
  overlap-detection branch needed.
- Verification: same no-real-browser constraints as every round — this
  one has a real gap worth naming. `npm run build`, dev-server checks,
  and a jsdom test verifying the *geometry* is correct (each of an
  overlapping pair's Voronoi cell contains its own center but not the
  other's, via point-in-polygon; an isolated country's cell fully
  contains its own circle) plus a full regression pass (reclick-confirm,
  continent crop, keep-zoom, wrong-answer feedback) confirming the
  `_reflow` restructuring didn't break anything else. What's **not**
  verified: whether a real browser's `clip-path` actually restricts
  pointer hit-testing to the clipped region the way the design assumes
  (it does per spec and in every evergreen browser, and jsdom doesn't
  implement real hit-testing at all to check against) — this is the one
  piece of this whole feature that genuinely needs a human clicking
  around the Caribbean in an actual browser to be sure it feels right.

## 2026-09-24 — recalibrate hitbox size/scope; name the guessed country on wrong

- **Hitbox was too generous**: the threshold for "this country is tiny,
  give it an assist circle" was 18px, which — measured against the real
  dataset — turned out to catch dozens of ordinary small-but-visible
  countries (Luxembourg, Cyprus, Kosovo, Qatar, Jamaica, Bahrain, ...) that
  didn't need one and shouldn't get a big invisible clickable blob. Wrote
  a one-off script projecting the whole dataset at a reference map size to
  see actual bounding-box sizes rather than guessing: true microstates
  (Vatican City 0.02px, Monaco 0.12px, San Marino 0.25px, Liechtenstein
  0.54px, Malta 0.84px, Bahrain 1.16px, Mauritius 1.37px) sit well under
  2px, while Luxembourg (1.82px) already reads as a normal small country.
  Landed on a 1.5px cutoff (`TINY_THRESHOLD`) — tight enough to exclude
  Luxembourg — and shrank the resulting hit-circle itself from 18px to 8px
  diameter (`HIT_DIAMETER`), so even a qualifying country gets a modest
  assist rather than a large target that could swallow a neighbor's
  clicks. Split what was one constant into two, since "how tiny is tiny"
  and "how big is the resulting target" are different questions.
- **Wrong map-click answers now name the country you picked**: previously
  only the map coloring (red/green) indicated right/wrong for a map-click
  answer, with no text — you could see *a* country turned red without
  necessarily being sure which one, especially a small one. Added a
  feedback line ("You picked X — correct answer: Y"), looking the guessed
  id up in `dataset.items` for its name.
  - This needed a small structural change: giving the map-click widget a
    text feedback line meant it could no longer just append into its own
    `container` alongside the map (a flex row centered on the map — a text
    line sharing that row would fight the map for space). Added a
    dedicated `.feedback-area` slot in `game.js`, passed to answer widgets
    as `ctx.feedbackContainer`, separate from their main `container`.
    text-guess's existing feedback moved there too for consistency (no
    behavior change for it).
- Verification: same no-real-browser constraints as every round.
  `npm run build`, dev-server checks, and jsdom tests: hitbox sizing
  against the real dataset (both "should get one" and "should NOT get
  one" cases), the wrong-answer feedback text end-to-end through the real
  `game.js` flow, and a regression pass over continent cropping (prompt
  map this time, not just answer map), extra-territories gating,
  text-guess feedback, and keep-zoom. One test assertion about the timer
  initially failed on a cold run — traced to `WorldMap` construction
  taking ~210ms the first time in this Node/jsdom process (JIT/parsing
  warmup), long enough to eat into the 100ms timer interval's own
  deadline before the test's wall-clock check ran. Confirmed as a test
  artifact of this environment, not an app bug (real browsers construct
  it in low single-digit ms), and not something to design around. All
  scripts thrown away after use.

## 2026-09-24 — tiny-country hitboxes, full-length games, extra territories

- **Tiny-country hitbox**: countries like Monaco, Vatican City, and San
  Marino render at sub-pixel size on a world map and were nearly
  unclickable. `WorldMap` now lays out an invisible oversized `<circle>`
  hit-area (min 18px diameter) on top of any country whose projected
  bounding box is smaller than that, sized/positioned in `_reflow` from
  `pathGen.bounds()`. Selection/highlight/result state now applies to both
  the real path and its hit-circle, since the real shape is often too
  small to see a fill change on at all.
- **Always all countries**: `QuizSession`'s round count now defaults to
  the full size of whatever's in play (`dataset.items.length`) instead of
  a fixed 10 — removed `DEFAULT_ROUND_COUNT`. A continent game covers all
  of that continent; a world game covers all 235 (or 238 with extra
  territories on).
- **Extra territories setting**: new opt-in menu toggle (off by default)
  for Kosovo, Somaliland, and Northern Cyprus. Kosovo already had full
  data in `world-countries` (name, capital, region, ...), just no `ccn3` —
  joined by topology feature name instead, using its own `cca3` ("UNK") as
  id. Somaliland and Northern Cyprus aren't in `world-countries` at all,
  so they're hand-curated in `generate-data.mjs` (capital, region,
  approximate coordinates — public knowledge, not guessed) with synthetic
  ids. All three get their topology feature's `id` patched at generation
  time so map and data always agree. The other two originally-unmatched
  shapes (Indian Ocean Ter., Siachen Glacier) aren't real governed places
  and stay permanently excluded regardless of the setting.
  - This needed a second, independent filtering concept in `WorldMap`
    beyond the existing continent hard-crop: a `playableIds` **soft
    gate**, always derived from the current game's actual item list. A
    feature is only interactive/normally-styled if its id is in
    `playableIds` — independent of whether the topology assigned it an id
    at all — so Kosovo can exist in the topology year-round but only be
    clickable when the setting is on, rendering muted (exactly like
    Indian Ocean Ter. always has) when it's off. `filterIds` (hard crop,
    continent-only) and `playableIds` (soft gate, always active) now both
    get passed through `game.js` → `prompts.js`/`inputs.js` → `WorldMap`.
- Verification: same no-real-browser constraints as every round so far.
  `npm run build`, dev-server checks on every touched file, and jsdom
  tests: one exercising the three new features directly against
  `WorldMap`/`QuizSession` (hit-circle sizing/click/marking, playable-vs-
  muted for the extra territories, full item count as round count), plus
  a full regression pass confirming continent cropping, re-click-confirm,
  the timer, and keep-zoom (via a real `WheelEvent`, not a programmatic
  transform call) all still work after the `WorldMap` restructuring. All
  thrown away after use. Still no real browser to confirm actual tap
  precision on the tiny-country hitboxes on a phone.

## 2026-09-24 — fix: keep-zoom setting was a no-op; disable double-click-zoom

User-reported: "keep zoom doesn't work" and "double click should not zoom".

- **Root cause of keep-zoom not working**: `ResizeObserver` fires its
  callback once, asynchronously, right after `observe()` is called — even
  when the container hasn't actually changed size. `WorldMap`'s callback
  unconditionally reset zoom to identity, so a moment after construction
  (well after the constructor's own synchronous initial layout had
  correctly applied `initialTransform`), that spurious first async
  callback fired and silently reset it back to identity. The setting
  looked wired correctly end-to-end but the zoom was being clobbered
  microseconds after being set. Fixed by tracking the last size actually
  laid out for and only resetting when a callback reports a size that's
  genuinely different — verified with a jsdom `ResizeObserver` stub that
  reproduces the real async-first-callback behavior (a plain no-op stub,
  used in earlier testing, couldn't have caught this, since it never fires
  at all).
- **Double-click-to-zoom**: d3-zoom binds this by default, and it
  conflicts with the re-click-to-confirm feature — a quick double click on a
  country reads as both two "click" events and one "dblclick" event, so
  confirming a guess could also trigger an unwanted zoom-in. Unbound via
  `selection.on("dblclick.zoom", null)`; wheel/pinch/drag zoom untouched.
- Also noticed while testing (not a bug, just documenting): the topology
  data has one country, Australia (id `036`), split across two separate
  geometry entries sharing the same id — likely mainland vs. an offshore
  territory in how `world-atlas` triangulated it. Both fragments behave
  identically for click/highlight/selection since they share an id; only
  affects a raw DOM path count, not gameplay.
- Verification: a jsdom `ResizeObserver` stub that mimics the real
  fire-once-async-after-observe behavior (not a no-op), confirming the
  carried-in transform survives that spurious callback while a genuine
  size change still resets it; a `dblclick.zoom` unbind check; and a full
  `game.js` integration run using an actual `WheelEvent` (not a
  programmatic transform call) to confirm a real zoom gesture correctly
  carries into round 2 when the setting is on. All thrown away after use.
  Still no real browser available to confirm the feel of an actual pinch
  or double-click on a touchscreen.

## 2026-09-24 — timer, confirm-on-reclick, continent-cropped map, zoom setting

- Added a per-round timer (`.game-timer` in the header): starts each round,
  stops at confirm, shown live to 0.1s. Total and average time now appear
  in the end-of-game summary alongside score.
- Map-click answers now confirm on a second click of the *same* already-
  selected country (not just via the action button) — clicking a
  *different* country still just changes the pick, matching how "click the
  country again" was described. Required threading `onConfirm` into the
  map-click widget, which it now calls directly.
- Continent mode now actually crops the map, not just the question pool:
  `WorldMap` takes an optional `filterIds` set and drops everything else
  before fitting the projection, so choosing e.g. Oceania both asks only
  about Oceania and visually shows only Oceania (no more picking Fiji off
  a map of the whole world). World mode is unaffected (no filter, full
  globe, unplayable disputed territories still shown for context).
- Added a "keep zoom between rounds" menu setting (only shown for datasets
  that actually use a map). `WorldMap` gained `initialTransform` (start
  zoomed there instead of at identity) and `getTransform()`; `game.js`
  captures the outgoing round's transform and feeds it into the next
  round's map when the setting is on. Off (default) behaves as before —
  every round starts at identity zoom.
- **Real bug found and fixed via testing**: confirming by re-clicking the
  map (as opposed to clicking the action button) is itself a click event
  that goes on to bubble up to the round's "click anywhere advances"
  listener. Without a guard, that single click would confirm *and*
  immediately advance in the same tick — the result (correct/wrong
  feedback) would never actually be visible before the next round loaded.
  Fixed with a one-shot `suppressNextRootAdvance` flag set by
  `attemptConfirm` and consumed by the root listener. Caught this with a
  jsdom integration test driving the actual `game.js`/`inputs.js` code
  (isolating the widget alone didn't reproduce it — the bug was in how the
  click event's bubble phase interacts with `game.js`'s listener, not in
  the widget itself), then verified the fix with the same repro.
- Verification: same no-real-browser constraints as before. `npm run
  build`, dev-server checks on every touched file, a WorldMap-level jsdom
  test for the zoom-persistence and continent-cropping primitives
  directly, and jsdom integration tests driving `game.js` end-to-end
  (timer ticking and freezing, re-click-confirm, continent-restricted
  rendering, and a regression pass over the existing select/reselect/
  confirm-via-button/click-anywhere flow) — all thrown away after use.
  Manual zoom/pinch feel, the timer's visual placement, and general layout
  still need a human check in an actual browser.

## 2026-09-24 — continent filter, select/confirm/next flow, map zoom

- Added a continent filter (`core/continents.js`): World (default) plus
  Africa/Asia/Europe/Oceania/North America/South America, matched against
  `world-countries`' `region`/`subregion` fields. North America is defined
  as the "Americas" region minus South America's subregion (i.e. includes
  Central America + Caribbean), since `world-countries` doesn't split
  Northern America out as its own top-level region. Menu only shows this
  step when the dataset opts in (`supportsContinentFilter`), so it stays
  optional infrastructure rather than something every future dataset must
  support.
- Reworked the answer flow from "click/submit = immediate answer" to
  select → confirm → result → next: answer widgets now report a
  provisional pick via `onSelect` instead of auto-submitting, so map-click
  answers can be re-picked before confirming. One button
  (`.action-button`) plays both the Confirm and Next role in the same
  spot instead of two separate buttons in different places. After a
  result, clicking anywhere in the round (not just the button) advances —
  implemented as one click listener on the round root, gated by an
  `active` flag so it can't misfire after the round's DOM is torn down
  (caught this via a jsdom test: without the guard, clicking "Play Again"
  in the summary could re-trigger the old round's advance-listener on the
  detached tree, since a removed node still finishes its bubble phase for
  an in-flight click).
- Added scroll-wheel / pinch / drag zoom to `WorldMap` via `d3-zoom` +
  `d3-selection` (`scaleExtent` 1–10, `touch-action: none` so mobile
  doesn't intercept the pinch as page zoom). Added
  `vector-effect: non-scaling-stroke` to country borders so they don't
  balloon in thickness at high zoom — an issue introduced by adding zoom,
  not present before.
- Found and fixed a real bug via jsdom smoke-testing: the last round's
  button was showing "Next" instead of "See Results" because the label
  check used `session.isFinished` (true only *after* `advance()`) instead
  of checking whether the round just confirmed was the last one.
- Verification: same constraints as before (no real browser available).
  Used `npm run build`, dev-server HTTP checks on every touched module,
  a continents.js data smoke test against live country data, and two
  throwaway jsdom scripts driving `game.js` end-to-end (select, re-select,
  confirm, click-anywhere-advance, text input + Enter-to-confirm, full
  game to summary, and the stale-listener regression above) — all
  removed after use, not committed. Manual zoom/pinch feel and real CSS
  layout still need a human check in an actual browser.

## 2026-09-24 — v1 built: name ↔ location quiz

Built the first playable version from an empty folder.

- Decided architecture: attribute registry (`core/attributes.js`) + dataset
  registry (`core/datasets.js`) + generic engine (`core/engine.js`), so
  question mode and answer mode are independent, data-driven choices
  instead of hardcoded combinations.
- Scaffolded with Vite (vanilla JS template). npm wasn't installed on this
  machine — installed via `pacman -S npm` (first attempt hit a stale
  mirror, fixed with `pacman -Syyu`).
- Sourced country data from `world-countries` (npm, MIT) and the world map
  from `world-atlas` (npm, ISC, 50m topojson), joined on ISO 3166-1 numeric
  id (`ccn3`) via `scripts/generate-data.mjs` → 235 countries with both
  attribute data and a map shape. 5 disputed/non-ISO territories
  (Somaliland, Kosovo, N. Cyprus, Indian Ocean Ter., Siachen Glacier)
  render on the map but are excluded from the quiz.
- Built `WorldMap.js`: a reusable SVG map (d3-geo + topojson-client,
  Natural Earth projection) supporting highlight / click / correct-wrong
  feedback, not specific to the countries dataset.
- Built the two v1 attributes (`name`, `location`) and their widgets
  (`text-guess` with a datalist of valid values; `map-click`).
- Moved generated data to `public/data/` and made dataset loading a lazy
  `fetch()` instead of a static import — dropped the JS bundle from ~845 KB
  to ~32 KB (the topojson was otherwise being inlined into the bundle).
- Verified: `npm run build` succeeds, dev server serves HTML/JS/data
  correctly, and Node-level smoke tests pass for `attributes.js`
  (matching/normalization) and `engine.js` (round flow, scoring, history).
  **Not verified**: actual rendered UI in a browser — no headless browser
  or Claude-in-Chrome available in this environment. User should confirm
  visually via `npm run dev`.
- Wrote `DESIGN.md` (architecture/overview) and this log, per project
  convention: exactly these two markdown files, archive folder holds
  snapshots instead of a sprawling docs history.

Next candidates: capital attribute (data already present, just needs a
registry entry), flag attribute (needs a new "image" prompt widget), a
second dataset to prove the registry generalizes.
