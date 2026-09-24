# Geography Quiz — Design Document

## Goal

A browser game for guessing geographical items: given some fact about a
place (its name, its location, later its capital, flag, etc.), guess
another fact about it. The player picks a **question mode** (what's shown)
and an **answer mode** (what they must supply) independently, and any
compatible pair can be mixed and matched — e.g. "show the country name →
click it on the map" or "highlight a country on the map → type its name".

The whole system is data-driven: new facts (attributes), new answer
widgets, and new datasets (a different map/region, or a non-map topic) are
meant to be addable without touching the wizard, engine, or game-screen code.

## Tech stack

- Vanilla JavaScript (ES modules), no UI framework.
- [Vite](https://vite.dev/) for dev server + build.
- [d3-geo](https://d3js.org/d3-geo) + [topojson-client](https://github.com/topojson/topojson-client) to project and render the world map as SVG.
- [d3-zoom](https://d3js.org/d3-zoom) + [d3-selection](https://d3js.org/d3-selection) for scroll-wheel/pinch/drag zoom on the map.
- [d3-delaunay](https://d3js.org/d3-delaunay) to split overlapping tiny-country hit-circles along their Voronoi boundary (see "Map" below).
- No backend — fully static, data fetched from `public/data/*.json` at runtime.

npm was not preinstalled on the dev machine; it's now installed system-wide (Arch `npm` package).

## Architecture

The core idea: **attributes** describe quizzable facts, **datasets**
describe collections of items, and a generic **engine** + **game screen**
drive rounds by looking up widgets by kind. No module hardcodes "name" or
"location" outside of `attributes.js` itself.

```
src/
  core/
    attributes.js   — attribute registry (the data-driven core)
    datasets.js      — dataset registry (items + map topology + which attributes apply)
    subjects.js       — "what to quiz about" roadmap list (only countries built so far)
    regions.js          — region filter registry, two-level tree (region/subregion predicates)
    sovereignty.js        — All / All Sovereign filter (the `independent` field)
    settings.js             — persistent app-wide preferences (localStorage)
    engine.js                 — QuizSession: generic round/scoring logic
  map/
    WorldMap.js                 — reusable SVG map (topojson -> paths), highlight/click/feedback API
  ui/
    screenKit.js                  — shared full-screen "pick one of these" component
    home.js                         — main hub: Games / Map / Settings
    gameWizard.js                     — the Games flow's sequence of choice screens
    mapExplore.js                      — free-explore map screen
    settingsScreen.js                   — settings screen
    game.js                               — round loop: renders prompt + answer widgets, scores, shows summary
    prompts.js                             — prompt widget registry, keyed by attribute.promptKind
    inputs.js                               — answer-input widget registry, keyed by one of attribute.answerKinds
  main.js                                     — app bootstrap (top-level screen router)
  style.css
public/
  data/
    countries.json          — quiz items (generated, see below)
    world-50m.json           — topojson world map (generated, see below)
scripts/
  generate-data.mjs           — regenerates public/data/*.json from upstream npm packages
```

### Navigation (`main.js`, `ui/home.js`, `ui/gameWizard.js`)

`main.js` is a minimal top-level router with four destinations: `home`,
the games wizard, map explore, and settings. Each destination is just a
function call (`renderX(container, ...callbacks)`); there's no URL
routing or history API, since the whole app is one page and "navigation"
just means replacing `#app`'s contents.

The **games wizard** (`ui/gameWizard.js`) is a sequence of full-screen
choices, each rendered via the shared `renderChoiceScreen` (`ui/
screenKit.js`): subject → question type → answer type (→ *how* to answer,
if that attribute has more than one `answerKinds` entry → *how many
options*, if multiple choice was picked) → region (→ a sub-region screen
if the region has children, e.g. Africa → North/Southern Africa) →
sovereignty → the game itself. Back-navigation is continuation-passing,
not a history stack: every step function takes a `goBack` closure, and
when it advances to the next step it constructs a *new* `goBack` that
just re-renders itself with the same accumulated config — so going back
never loses earlier choices, and the chain naturally unwinds all the way
to `onExit` (home) from the first step. Nothing about this pattern is
specific to games — `screenKit.js` and the same continuation style would
work for any future multi-step flow.

Subject is asked *first*, specifically so every later step can be scoped
to it: question/answer type read `resolveAttributes(meta.attributeKeys)`
(the chosen subject's dataset, not the global attribute registry), so a
subject with a narrower or different attribute set just sees fewer/
different options there — no reconciliation step needed, no risk of
picking a question/answer combination the subject doesn't actually
support. With only one subject (countries) built so far this doesn't
change what's shown, but the scoping is real and already wired up for
when a second one exists.

A region step's options can be a **branch** (`children`, not directly
selectable — Africa, America) or a **leaf** (`match`, directly
selectable — Europe, Asia, Oceania, World). Picking a branch shows a
second region screen for just its children; picking a leaf skips straight
to the sovereignty step. Whether the region/sovereignty steps show at all
is gated per-subject by the chosen dataset's `supportsRegionFilter` /
`supportsSovereigntyFilter` flags (same pattern as attribute-scoping
above) — a subject without geographic data would skip both and go
straight from subject to the game.

The wizard's last step (`startGame`) is the only place that actually
calls `loadDataset` (fetches the item/topology JSON) and `loadSettings`
(reads the persisted zoom preference) before handing off to
`renderGame` — every earlier step works from static, already-in-memory
registries (`subjects`, `regions`, `sovereigntyOptions`, and the static
half of `datasetMeta`), so nothing blocks on a network request until the
player has made every choice.

### Attributes (`core/attributes.js`)

Each attribute entry describes one quizzable fact about an item:

| field | meaning |
|---|---|
| `key` | field name on the item |
| `label` | shown in the wizard |
| `canBePrompt` / `canBeAnswer` | which roles this attribute can play |
| `promptKind` | which widget in `prompts.js` renders it as a question |
| `answerKinds` | which widget(s) in `inputs.js` can collect/check it as an answer |
| `getValue(item)` | raw value used for comparison |
| `checkAnswer(guess, item)` | correctness check |
| `formatAnswer(item)` | human-readable value for feedback |

v1 has two attributes: `name` (text prompt; answerable by typed-guess,
with accent/case/punctuation-insensitive matching, *or* multiple choice —
`answerKinds: ["text-guess", "multiple-choice"]`) and `location`
(map-highlight prompt / map-click answer only — `answerKinds:
["map-click"]`). **Adding a new attribute** (e.g. `capital`, `flag`)
means adding one entry here — reusing `promptKind: "text"` /
`answerKinds: ["text-guess"]` if a text widget is enough, or registering a
new widget kind in `prompts.js`/`inputs.js` if not. The wizard, engine,
and game screen need no changes.

`answerKinds` is a list because one attribute can support more than one
*way* to answer with it. The wizard shows a picker between them only when
there's more than one (see "Navigation" above); with just one, it's used
automatically and no extra screen appears. `game.js` receives the
specific kind the wizard resolved to as `answerKind` (falling back to
`answerAttr.answerKinds[0]` if that's ever omitted) — it's not read off
the attribute directly, since the attribute alone no longer determines a
single kind.

### Datasets (`core/datasets.js`) and Subjects (`core/subjects.js`)

A dataset pairs a list of items with a map topology and declares which
attribute keys apply to it (`attributeKeys`), plus capability flags
(`supportsRegionFilter`, `supportsSovereigntyFilter`) the wizard uses to
decide which steps to show, and an optional `projection` key (see "Map"
below) for topologies that aren't world-scale lon/lat. Two datasets exist:
`countries` (235 UN-recognized-ish countries with map shapes at 50m
resolution, plus 3 opt-in extra territories — see "Data" below) and
`us-states` (51 US states + DC, `supportsRegionFilter`/
`supportsSovereigntyFilter` both false — see below for why it's reached
differently from every other dataset).

`subjects.js` is one level above this — the wizard's "what to quiz about"
list, deliberately broader than `datasetMeta`: it includes subjects with
no dataset built yet (Capitals, Flags, Emblems, Currencies, Cities),
listed disabled with a "Coming soon" hint so the wizard communicates the
roadmap. Only `available: true` entries reference a real `datasetKey`
into `datasetMeta`; picking one is what triggers `loadDataset` at the end
of the wizard. `us-states` deliberately has **no** entry in `subjects.js`
— it's not picked from the subject step at all, only reached via the
region step (see "Regions" below), so it never shows up there.

### Regions (`core/regions.js`)

A separate small registry from attributes: a two-level tree over
`region`/`subregion` (the UN geoscheme fields `world-countries`
provides). A **leaf** entry (`{ key, label, match(item) }`) is directly
selectable in the wizard's region step — Europe, Asia, Oceania, World. A
**branch** entry (`{ key, label, children }`) isn't itself selectable;
picking it shows a second screen listing its children instead. Two
branches exist: Africa (North / Southern Africa, split on the UN's own
"Northern Africa" subregion vs. everything else) and America (North /
South / Caribbean / **US States** — Central America folds into North
America at the traditional Panama/Colombia boundary, so the first three
are a 3-way split of world-countries' 4 Americas subregions, not 1:1 with
them). `getRegion(key)` searches both levels and falls back to `"world"`.

America's fourth child, `us-states`, is a different *kind* of entry: it
has `datasetKey: "us-states"` instead of `match` — it isn't a filter over
the countries dataset at all, it switches the whole game to a different
one. `gameWizard.js`'s sub-region step checks for this specifically (see
"Navigation" above): picking it swaps `config.subject`/`meta` to the
`us-states` dataset and re-enters the normal region/sovereignty skip
chain, which then auto-skips both (that dataset declares neither
supported) straight into the game. This is why "US States" sits inside America's *region* step (a sibling
of North America, South America, and Caribbean, not nested inside any of
them) rather than being its own top-level Subject: that's the placement
asked for, and the existing skip-chain machinery already handled "this
dataset needs fewer steps than usual" cleanly, so reusing it here needed
no new plumbing.

A couple of countries get an explicit override rather than following
their raw `subregion`: Trinidad and Tobago and Grenada are UN-classified
as "Caribbean" (so `region`/`subregion` alone would put them in the
Caribbean bucket), but both sit on or just off the South American
continental shelf and are commonly grouped there instead — named
explicitly in a `SOUTH_AMERICA_OVERRIDES` set, excluded from both North
America and Caribbean, checked to keep all three Americas buckets
mutually exclusive and together covering every Americas country.

Every pair of leaves/branches partitions its items with **one deliberate
exception**, per explicit user direction: Georgia, Türkiye, Cyprus, and
Russia are Europe-only for the purposes of Europe's own membership (world-
countries files Georgia/Türkiye under `region: "Asia"`; overridden by name
in `EUROPE_ONLY`, added to Europe's `match`, and excluded from Asia's own
— Cyprus/Russia need no override, they're natively `region: "Europe"`
already), but all four are *also* offered when the player picks Asia
(`ASIA_BONUS`, a second name set added to Asia's `match` on top of its own
`region === "Asia"` minus the two just excluded). So Europe never sees
these four twice and always counts them; Asia counts everyone functionally
Asian *and* these four as an explicit bonus, without actually claiming
them as Asia's own. This is the only overlap anywhere in the region tree;
Africa's and America's splits are still checked disjoint. The asymmetry
(Europe gets ownership, Asia gets a bonus, not the reverse) came from
walking through a specific target-count table with the user rather than
being inferable from the countries alone — worth re-reading `LOG.md` if
this ever needs adjusting, since the reasoning isn't obvious from the code
alone.

### Sovereignty (`core/sovereignty.js`)

A second, independent wizard step (gated by the dataset's own
`supportsSovereigntyFilter` flag) controls whether non-sovereign items are
included at all: `"All"` (no filter) vs. `"All Sovereign"`
(`item.independent === true`). This reuses the `independent` field
`world-countries` already provides rather than introducing a separate
flag, and it's a more principled replacement for what used to be an ad
hoc "extra territories" toggle keyed off a hand-set `isExtraTerritory`
flag: `independent` is `false` for ordinary dependent territories (Puerto
Rico, Bermuda, Hong Kong, ...) *and* for Somaliland/Northern Cyprus, and
`null` for Kosovo's contested status — so "All Sovereign" excludes all of
them in one principled filter instead of two overlapping concepts. (The
data generator still tags the three hand-curated entries with
`isExtraTerritory: true`, but purely as provenance metadata now — nothing
in the app reads it for filtering.) 238 items total, 193 of them
`independent === true` — close to the commonly-cited ~195 sovereign
states, a reasonable sanity check that the field means what it's expected
to.

Region and sovereignty are **not** simply chained together into one
filtered list, and that distinction matters: the wizard computes
`regionItems` (region match only) separately from the final `dataset.items`
(region match *and* the sovereignty filter). `game.js` uses `regionItems`
for the map's hard crop (`filterIds`, below) and `dataset.items` for both
the quiz pool and the map's soft gate (`playableIds`, below). If both
filters collapsed into one list, choosing a region with "All Sovereign"
selected would hard-crop Kosovo/Somaliland/Northern Cyprus out of the map
entirely whenever they fell inside the chosen region — a hole in Serbia
instead of a muted shape — which is exactly a bug this split fixed for
the predecessor "extra territories" toggle (see `LOG.md` for how it was
caught) and continues to prevent now.

### Engine (`core/engine.js`)

`QuizSession` is generic: given a dataset, a question attribute, and an
answer attribute, it shuffles a round pool, tracks score/history, and
exposes `currentItem` / `submitAnswer(guess)` / `advance()`. It has no
knowledge of maps, text inputs, or countries specifically. `roundCount`
defaults to `dataset.items.length` — a game always covers every item in
whatever's currently in play (after region/sovereignty filtering), never
an arbitrary fixed number — though the constructor still
accepts an explicit smaller `roundCount` if something ever wants a
shorter game.

### Map (`map/WorldMap.js`)

A reusable SVG map: takes any topojson topology + object key, projects it,
and renders one `<path>` per feature. Exposes `highlight(id)` (prompt
display), `select(id)` (provisional pick, before confirming),
`setClickable(enabled, onClick)`, and `markResult(guessId, correctId)`
for right/wrong feedback — each a distinct CSS class so "this is the
question subject", "this is what you're about to submit", and "this is
what you actually submitted" never look the same. Not specific to the
`countries` dataset — the `us-states` dataset reuses it with only one
extra piece of config (below).

Which projection to use is per-dataset (`dataset.projection`, a string
key resolved against a small `PROJECTIONS` map so `datasets.js` itself
never has to import d3): `"naturalEarth1"` (the default) expects raw
lon/lat input and is right for anything world-scale, like `countries`.
`"identity"` is a pass-through for topologies that arrive *already*
projected — `us-states`' topology is pre-built by `us-atlas` using Albers
USA (Alaska and Hawaii relocated into their conventional insets, which a
generic world projection has no notion of), so rendering it just needs
`fitSize` to scale those existing flat coordinates to the viewport, not
project them a second time.

The US states data specifically comes from `us-atlas`'s pre-projected
`states-albers-10m.json` (51 features — the 50 states + DC) rather than
its raw `states-10m.json` (56 features, since that one also includes
Puerto Rico, Guam, and other territories scattered across the whole
Pacific/Caribbean — out of range for what Albers USA's fixed three-conic
multiplex is built to project, and not what "US States" means here
anyway). See `scripts/generate-us-states-data.mjs`.

Two independent, differently-scoped filters, both optional:

- `filterIds` — a **hard crop**. Features that don't pass are dropped
  before the projection is fit, not just hidden, so `fitSize` crops/zooms
  to just the remaining region. This is how the region step makes the map
  "only show that region" — `game.js` builds this from `regionItems`
  (region match only, sovereignty not yet applied) once a specific region
  is chosen, `null` (no crop, full world) otherwise.
- `playableIds` — a **soft gate**, always passed by `game.js` (derived
  from whatever `dataset.items` currently is, after all filtering). A
  feature only gets a click listener, normal styling, and a hit-circle
  (below) if it's in this set — *independent of whether the topology
  itself assigned it an id*. Everything else renders as an inert, muted
  `.country--unplayable` shape. This is what makes the sovereignty
  setting work: Kosovo/Somaliland/Northern Cyprus have real, permanent ids
  in the topology (see "Data"), but only count as playable when "All"
  (not "All Sovereign") includes them in `dataset.items`. Two shapes
  (Indian Ocean Ter., Siachen Glacier) never get an id at all and so are
  never playable regardless of any setting.

True microstates (Vatican City, Monaco, San Marino, Liechtenstein, Malta,
...) get an invisible oversized `<circle>` hit-area layered on top of
their path (stacked last in DOM order, so it wins pointer hit-testing even
over a larger neighboring country). Sized in `_reflow`, from the feature's
projected bounding box (`pathGen.bounds`): if the box's larger dimension
is under `TINY_THRESHOLD` (1.5px at identity zoom on a ~800px-wide map),
the circle is shown at a fixed `HIT_DIAMETER` (6px); otherwise it stays
hidden and the real path alone is the click target. Both constants were
calibrated against the actual dataset, not guessed — see the comment above
them in `WorldMap.js` for the measured sizes that motivated the cutoff.
The threshold deliberately excludes ordinary small-but-real countries
(Luxembourg, Cyprus, Kosovo, Qatar, Jamaica, ...) that are perfectly
clickable at their true size; only genuine below-a-couple-pixels
microstates get the assist, and the resulting target itself stays modest
rather than a large blob that could swallow clicks meant for a neighbor.

Real clusters of adjacent microstates exist (the Lesser Antilles has half
a dozen within a few hit-circle-radii of each other; Saint Martin/Sint
Maarten are literally the same island split in two), so their 6px circles
routinely overlap. Rather than letting DOM order arbitrarily decide which
one wins a click in the overlap, every tiny circle is clipped
(`clip-path`, SVG `<clipPath>` + `<polygon>`, one pre-built per playable
feature) to its **Voronoi cell** among just the tiny centers for this
render — the region strictly closer to that country's center than to any
other tiny country's. `d3-delaunay` computes the diagram once per
`_reflow` over all currently-tiny centers; the cell boundary between two
neighbors is exactly the line equidistant from both, so their clipped
hit-areas can never overlap, however close the real countries are. A
country with no nearby tiny neighbor gets a cell far bigger than its own
6px circle, so clipping is applied uniformly but is a geometric no-op for
it — no separate "is this one actually overlapping" check needed. (SVG
`clip-path` restricts pointer hit-testing to the clipped region, not just
paint, in every evergreen browser, which is what makes this work for
clicks and not just visuals — unverified here since no real browser is
available in this sandbox, see "Environment notes".)

`highlight`/`select`/`markResult`/`clearMarks` all apply their CSS class
to both the real path *and* its hit-circle (if any) — for a country small
enough to need one, the real shape is often too tiny to see any fill
change on, so the circle is what actually shows the player their
selection/result.

**Disputed borders.** An optional `dashedBorders` (array of `[idA, idB]`
country-id pairs, e.g. `[["688", "UNK"]]` for Serbia/Kosovo — see
`datasets.js`) renders *just the shared frontier* between two countries as
a dashed line, not their whole outline. This uses topojson's own
`mesh(topology, object, filter)`: because topojson stores a shared border
once as a single arc referenced by both neighboring geometries (that's
the whole point of the topology format), `mesh()` with a filter matching
exactly that pair of ids returns precisely their common boundary and
nothing else — no manual line-segment geometry needed. One `<path
class="border--disputed">` is pre-built per configured pair at
construction (in a `.border-lines` group, stacked above country fills but
below the click-priority hit-circles, `pointer-events: none` so it's
never itself a click target) and its `d` recomputed each `_reflow`. If
either side of a pair isn't part of the current region crop, the path
is cleared instead of drawn — e.g. no line renders on an Oceania-only map,
since neither Serbia nor Kosovo exist there.

This is deliberately data-driven rather than hardcoded: `WorldMap` only
knows "draw a dashed line for this id pair," not that it's Serbia and
Kosovo specifically — a different dataset (or a future dispute) is just
another entry in its `dashedBorders` config.

Also wires up `d3-zoom` on construction: mouse wheel, touch pinch, and
drag all zoom/pan the `<g>` of country paths (`scaleExtent` 1–10,
`translateExtent` clamped to the viewport so you can't pan the map away
entirely). `touch-action: none` on the `<svg>` stops mobile browsers from
treating a pinch as a page-zoom gesture instead. Country borders use
`vector-effect: non-scaling-stroke` so they don't get comically thick at
high zoom.

By default a fresh `WorldMap` starts at identity zoom, and a genuine
resize resets it — but the constructor also accepts an `initialTransform`,
and `getTransform()` reads back the current one at any time. This is the
"keep zoom between rounds" setting: since every round mounts a brand new
`WorldMap` instance (prompt or answer, whichever is map-based that round),
`game.js` reads `getTransform()` from the outgoing round's map right
before tearing it down and, if the setting is on, feeds it back in as
`initialTransform` for the next round's map. When the setting is off (the
default) it passes nothing and each round starts fresh, as before.

Getting "reset on resize" and "keep the initial transform" to coexist
needed care: `ResizeObserver` fires its callback once, asynchronously,
right after `observe()` — even when nothing has actually changed size
yet. An earlier version reset zoom unconditionally on every callback,
which meant that spurious first firing silently clobbered the just-applied
`initialTransform` a moment after construction, and "keep zoom" did
nothing observable. Fixed by tracking the last container size laid out for
and only resetting when a callback's size actually differs from it — the
redundant initial callback (and any other same-size callback) is a no-op,
while a real resize still resets as before.

d3-zoom's default double-click-to-zoom is unbound
(`selection.on("dblclick.zoom", null)`) — it fought with clicking a
country to select/confirm it, since a quick double click fires as both two
"click"s and one "dblclick". Wheel, touch pinch, and drag zoom are
untouched.

### Widget registries (`ui/prompts.js`, `ui/inputs.js`)

Small `kind -> render function` maps. Each renderer returns `{ cleanup,
showResult?, getTransform? }` — `showResult` only on answer widgets,
`getTransform` only on map-based ones (used for the zoom-persistence
setting above). `game.js` never branches on which attribute is active — it
only ever calls `renderPrompt(container, questionAttr.promptKind, ctx)` /
`renderAnswerInput(container, resolvedAnswerKind, ctx)`, where
`resolvedAnswerKind` is whichever of the attribute's `answerKinds` the
wizard resolved to (see "Attributes" above).

Answer widgets render their post-confirm feedback *text* into a separate
`ctx.feedbackContainer` rather than their own `container` — `container`
may hold a full-size map (`answer-area` is a flex row centered on that
map), and a text line sharing that row with the map would fight it for
space. `game.js` provides a dedicated `.feedback-area` slot between the
answer area and the action button and clears it each round. All three
widgets say "Correct!" on a right answer; on wrong, text-guess and
multiple-choice show the correct answer (the player's own wrong guess is
still visible — in the disabled input for text-guess, highlighted red
among the options for multiple-choice), and map-click explicitly names
*both* the country the player clicked (looked up by id in `dataset.items`)
and the correct one — a coloured map alone doesn't reliably tell you
which country you actually hit, especially a small one.

Answer widgets never submit on their own. Picking a value (typing,
clicking a country, clicking an option) is provisional and reported via
`ctx.onSelect(value | null)`; the game screen owns a single Confirm/Next
button and only submits when the player confirms. A widget can also
trigger confirmation itself by calling `ctx.onConfirm()`: the text-guess
widget does this on Enter, and both map-click and multiple-choice do this
when the player clicks the *already selected* option again (a second
click = "yes, that one") — the exact same select-then-reclick-to-confirm
interaction, just applied to buttons instead of map paths. This is also
what lets a pick be changed before confirming (click a different country,
or a different option) — clicking something that *isn't* the current
selection just changes the pick instead. It's why the action button never
has to move: it's the same element playing the Confirm role, then the
Next role, for the whole round.

**Multiple choice** (`inputs.js`'s `"multiple-choice"` renderer) draws
`ctx.optionCount` buttons: the correct value (`attr.getValue(item)`) plus
distractors — other items from `dataset.items`, shuffled
(`core/engine.js`'s exported `shuffle`) and sliced to `optionCount - 1` —
with the whole set shuffled again so the correct answer's position isn't
predictable. Distractors come from `dataset.items`, not the full unfiltered
dataset, so they're always plausible members of whatever region/
sovereignty the player is actually playing (Malta among other European
countries, not a random Pacific island). If the current pool is smaller
than `optionCount - 1` (a tiny region playing 6-option multiple choice),
it silently caps at however many distinct items are available rather than
erroring or padding with anything fake.

After a result, the option buttons (and the text-guess `<input>`) go
visually inert via a `locked`/`readOnly` flag their own handlers check,
*not* the native `disabled` attribute/property — see the round-state-
machine note above on why that distinction matters for "click anywhere
advances."

### Round state machine (`ui/game.js`)

Each round is `answering -> result`, driven by one button (`.action-button`)
that's relabelled rather than swapped:

1. **answering** — prompt shown, button reads "Confirm" and is disabled
   until `onSelect` reports a non-null value. A per-round stopwatch
   (`.game-timer`) starts ticking here.
2. Confirm (button click, Enter in a text field, or re-clicking the
   selected country) calls `session.submitAnswer(selection)`, stops the
   timer and records the elapsed time, tells the widget to render
   correct/incorrect feedback, and flips to **result** — button now reads
   "Next" (or "See Results" on the last round).
3. **result** — clicking the button, *or clicking anywhere else in the
   round* (the map, the prompt, empty space — checked via a single click
   listener on the round's root element that ignores clicks inside the
   button), advances to the next round or the summary screen.

Two guard flags on that root-level "click anywhere" listener, both earned
by a real bug caught in testing:

- `active` — false once the round has been torn down (summary or exit), so
  a click that starts a summary/menu transition can't also re-fire
  "advance" on now-detached DOM mid-bubble.
- `suppressNextRootAdvance` — set for exactly one click by `attemptConfirm`.
  When confirmation happens via a click that *isn't* on the action button
  (re-clicking the selected country), that same click event goes on to
  bubble up to this listener; without the flag, one click would both
  confirm and immediately advance, and the result would never actually be
  visible. Confirming via the button doesn't need this (already excluded
  by the "not inside the button" check) but setting the flag unconditionally
  is harmless.

For "click anywhere else" to actually include the answer widget's own
now-inert controls (a multiple-choice button, a text-guess input) after a
result, those controls must never become natively `disabled` — a disabled
element doesn't dispatch a click event at all in a real browser, which
would silently swallow the click instead of letting it bubble to this
listener. Both widgets instead track their own `locked`/`readOnly` state
(see "Widget registries" below) and rely on their own click/input handlers
no-op'ing once locked, rather than the DOM refusing to fire the event in
the first place.

The end-of-game summary shows total and average time alongside the score
and per-round breakdown.

## Data

Generated by `scripts/generate-data.mjs` (`npm run generate-data`) from two
upstream npm packages (installed as `devDependencies`, not shipped at
runtime):

- **world-countries** (MIT) — name, capital, region, lat/lng, flag emoji,
  ISO codes, keyed by `ccn3` (ISO 3166-1 numeric).
- **world-atlas** (ISC) — topojson world map at 50m resolution, country
  features keyed by the same `ccn3` numeric id.

The script joins the two on `ccn3` and writes `public/data/countries.json`
(235 standard countries with both attribute data *and* a map shape) and
`public/data/world-50m.json` (the full topology — patched, see below).

Five map shapes originally have no ISO numeric id, so never join by `ccn3`.
Two of them aren't real governed places (Indian Ocean Ter., an
uninhabited administrative territory; Siachen Glacier, a literal glacier /
military dispute zone) and stay excluded from `countries.json` entirely —
rendered on the map, permanently muted, never playable under any setting.
The other three are real, populated, partially-recognized states, hand-
wired in and tagged `isExtraTerritory: true` in `countries.json` for
provenance — included whenever the sovereignty step's "All" is picked,
excluded by "All Sovereign" (see "Sovereignty" above):

- **Kosovo** — `world-countries` actually has full data for it already
  (name, capital, region, flag emoji, ...), it's just missing `ccn3`.
  Joined by matching the topology feature's name instead, using Kosovo's
  own `cca3` ("UNK") as its id.
- **Somaliland**, **Northern Cyprus** — not in `world-countries` at all.
  Hand-curated in `generate-data.mjs` from public knowledge (name,
  capital, region/subregion, approximate coordinates), since no upstream
  package has them. Synthetic ids ("SML", "XNC"); fields with no
  real/stable value (ISO codes, flag emoji — neither has an assigned
  Unicode flag) are left `null` rather than guessed.

In all three cases the script patches the matching topology geometry's
`id` directly (by matching on `properties.name`) before writing
`world-50m.json`, so the map and the item data always agree on the id —
`WorldMap`'s `playableIds` gate (see "Map" above) is what actually decides
whether they're interactive in a given game, not their presence in the
topology.

Re-run `npm run generate-data` after bumping either package, or to change
`MAP_RESOLUTION` in the script (`110m` coarse / `50m` current / `10m` fine
but ~3.6 MB).

**US states** come from a separate script, `scripts/generate-us-states-data.mjs`
(`npm run generate-us-states-data`), off the `us-atlas` package (ISC,
same maintainers as `world-atlas`) — see "Map" above for the pre-projected
topology / why the raw one wasn't used. Output is minimal (`{ id, name }`
per state, no capital/area/etc. — nothing currently reads more than that;
easy to extend when a `capital` attribute exists) at `public/data/
us-states.json` + `us-states-topology.json`.

## Current scope (v1)

- Home screen with three destinations: Games, Map (free-explore), Settings.
- Games flow: subject (only Countries built; Capitals/Flags/Emblems/
  Currencies/Cities listed as "coming soon") → question type → answer
  type (→ how to answer, for name: type it or multiple choice → how many
  options, 2–6, if multiple choice) → region (Europe/Asia/Oceania/World
  directly, or Africa/America via a sub-region screen: North America/
  South America/Caribbean/**US States**) → sovereignty (All / All
  Sovereign — skipped for US States, which has no such concept) → play.
  Every step is its own screen with Back navigation all the way to home.
- Two datasets: world countries (235 standard + 3 opt-in extra territories
  under "All") and US states (50 states + DC, reached via Region → America
  → US States rather than the Subject step — see "Regions" above). For
  countries, the map itself is cropped to the chosen region, not just
  which countries are asked about.
- Two attributes: name, location. Three answer styles across them: type
  the name, pick the name from 2–6 multiple-choice options, or click the
  map. Two mode pairs: name→location (click the country) and
  location→name (typed or multiple choice).
- Select → confirm → result → next round flow: pick a country, a text
  guess, or a multiple-choice option, confirm via the button, Enter, or
  re-clicking the same selection, see the result, then advance via the
  button or by clicking anywhere.
- Tiny countries get a small invisible click target so they're actually
  clickable/selectable at normal zoom; overlapping ones (dense clusters
  like the Lesser Antilles) are split along their Voronoi boundary so
  neither steals the other's clicks.
- Serbia/Kosovo's shared border renders dashed, flagging it as disputed
  rather than an ordinary international border.
- Map supports scroll/pinch/drag zoom (double-click-to-zoom disabled); a
  persistent Settings preference controls whether zoom resets every round
  (default) or carries over between rounds.
- Per-round timer, total/average time shown in the end-of-game summary.
- A game always covers every item currently in play (all of the chosen
  region, or all 235/238 in World mode) — no fixed round count.
- Map (free-explore): the whole world, every item clickable including
  extra territories, click a country to see its name — no quiz mechanics.

## Possible next steps (not yet built)

- More attributes: capital (data already present in `countries.json`,
  just needs a registry entry + reused `text-guess` widget), flag (needs
  an `image` prompt widget) — and the other five subjects already listed
  (disabled) in the subject step.
- A pin-drop / lat-lng answer mode as an alternative to click-the-shape,
  added to `location`'s `answerKinds`.
- A multiple-choice variant for `location` (show N candidate countries,
  pick which one matches the prompt) — not built; today multiple choice
  only exists for `name`.
- Extra-territories-style per-item nuance for US states (none needed yet
  — all 51 features are uniformly playable, no disputed/excluded ones).
- Configurable round count in the wizard (opt back into a shorter game).
- A time limit / countdown mode, as opposed to the current untimed
  stopwatch (which only measures, never penalizes).

## Project conventions

- **Docs**: exactly two markdown files — this one (design/overview) and
  `LOG.md` (chronological history of what changed and why). Don't add more
  `.md` files; extend these instead.
- **Archiving**: after a significant change, snapshot the project with
  `npm run archive -- <short-label>` (or `scripts/archive.sh
  <short-label>`). This tars the whole project (excluding `node_modules`,
  `dist`, `archive`) into `archive/<timestamp>_<label>.tar.gz` and prunes
  down to the 4 most recent snapshots automatically.

## Deployment

Live at `zigakorosak.com/geoquiz/`, deployed from GitHub to Namecheap
shared hosting (cPanel): `.github/workflows/deploy.yml` builds the site
(Node runs in the Action, not on the shared host — cPanel hosting doesn't
reliably have a usable npm/build setup) and FTPS-uploads `dist/`.
**Manual only, by request** — pushing to `main` does *not* auto-deploy;
trigger it from the Actions tab ("Deploy to Namecheap" → "Run workflow")
or `gh workflow run "Deploy to Namecheap"` when it's actually time to
push a change live.

`vite.config.js` sets `base: "/geoquiz/"` to match — this is what makes
both the built `<script>`/`<link>` tags in `index.html` and the
`import.meta.env.BASE_URL`-prefixed data fetches in `core/datasets.js`
resolve to `/geoquiz/...` instead of the domain root. If the deploy path
ever changes (different subdirectory, domain root, a subdomain), this is
the one line that needs to change to match.

**Secrets** (GitHub → repo → Settings → Secrets and variables → Actions):
`FTP_SERVER`, `FTP_USERNAME`, `FTP_PASSWORD`, for a cPanel FTP account
scoped to `public_html/geoquiz` specifically rather than the main
full-access login (a leaked secret then only exposes that one
subdirectory). Two non-obvious gotchas hit while setting this up the
first time, worth knowing if it ever needs redoing on a different host:

- The hostname cPanel's "Configure FTP Client" panel suggests
  (conventionally `ftp.<domain>`) isn't guaranteed to actually resolve —
  it didn't here (confirmed with `nslookup`/`getent hosts`, genuine
  `NXDOMAIN`). The bare domain resolved fine and works just as well for
  FTP, since the same server handles both.
- `server-dir` in the workflow is relative to the **FTP account's own
  login root**, not the server's filesystem root or the domain's document
  root. If that account's root is already scoped to a subdirectory (check
  cPanel's FTP Accounts "Path" column), `server-dir` should just be `./`
  — setting it to the same subdirectory path again nests a duplicate
  copy inside itself.

Secrets are write-only once saved (not visible again to anyone, including
repo admins, only to the Action at run time) — there's no way to double-
check a value after the fact except by watching whether the next deploy
run succeeds.

## Environment notes

- npm was not installed on this machine initially (only the `nodejs`
  system package); it was installed via `pacman -S npm` after a mirror
  refresh (`pacman -Syyu`).
- No headless browser (chromium-cli, Claude-in-Chrome, or a system
  Chromium/Chrome binary) is available in the assistant's sandbox, so UI
  changes have been verified via `npm run build`, the dev server's raw
  HTTP responses, Node-level logic smoke tests, and (for `game.js`'s DOM
  event wiring specifically) throwaway jsdom scripts simulating clicks —
  **not** a real rendered browser, so nothing about actual visual layout,
  CSS, or real touch/pinch gestures has been confirmed. Open
  `http://localhost:5173` (or `npm run dev`) yourself to check those,
  especially the zoom gesture on an actual phone.
