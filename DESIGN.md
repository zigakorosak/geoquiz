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
- [d3-delaunay](https://d3js.org/d3-delaunay) to build assist hit-area hulls and split overlapping ones along their Voronoi boundary (see "Map" below).
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

`goToRegionOrSkip` — reached right after answer type (and, for multiple
choice, option count) is settled — is where `loadDataset` actually gets
called, *not* the wizard's last step: every region and sovereignty option
shows the player how many items it'd actually leave them with (`"All
(236)"`, `"Europe (54)"`, …), and that needs the real loaded item list,
not just the dataset's static `datasetMeta` flags. `regionCount()`
computes a leaf region's count as `loadedItems.filter(region.match)
.length`, a branch's as the union of its children's own matches, and
returns `null` (no count shown) for an option that switches to a
*different* dataset entirely rather than filtering the current one (the
Caribbean region's "US States" sibling) — there's no shared count to show
against items from a different dataset. The sovereignty step's counts are
scoped one step further, to `regionItems` (post-region, pre-sovereignty)
rather than the whole loaded set, so switching *which* sovereignty option
looks selected never changes what region you're counting within.
`startGame` (the wizard's actual last step) re-awaits `loadDataset` for
the final item list — a no-op given the loader's own cache, not a second
real fetch — and is *still* the only place `loadSettings` (the persisted
zoom preference) gets read, since that's a display-time concern for the
game screen, not something any wizard step needs to know about.

A subject without any region/sovereignty filtering at all (US states)
skips this load entirely and goes straight from answer type to the game,
same as before — nothing to show a count against, so nothing to load
early for.

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

Three attributes so far: `name` and `capital` (both text prompt; answerable
by typed-guess, with accent/case/punctuation-insensitive matching, *or*
multiple choice — `answerKinds: ["text-guess", "multiple-choice"]`) and
`location` (map-highlight prompt / map-click *or* map-pin answer —
`answerKinds: ["map-click", "map-pin"]`, see "Map"/"Widget registries"
below). **Adding a new attribute** (e.g. `flag`) means adding one entry
here — reusing `promptKind: "text"` / `answerKinds: ["text-guess"]` if a
text widget is enough, or registering a new widget kind in
`prompts.js`/`inputs.js` if not. The wizard, engine, and game screen need
no changes.

Not every item necessarily has a value for every attribute — a few
countries have no recorded capital (Antarctica, Macau, Heard Island and
McDonald Islands), and District of Columbia has no state capital of its
own (a federal district, not a state). `gameWizard.js`'s `isAskable(item,
questionAttr, answerAttr)` filters these out of the actual playable item
set (and the region/sovereignty step counts) rather than attributes.js or
the engine needing to special-case a missing value — see "Navigation"
above.

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
no dataset built yet (Flags, Emblems, Currencies, Cities), listed disabled
with a "Coming soon" hint so the wizard communicates the roadmap. Only
`available: true` entries reference a real `datasetKey` into
`datasetMeta`; picking one is what triggers `loadDataset` at the end of
the wizard. `us-states` deliberately has **no** entry in `subjects.js` —
it's not picked from the subject step at all, only reached via the region
step (see "Regions" below), so it never shows up there.

Countries and Capitals both point at `datasetKey: "countries"` — the same
data fetch, since every item already carries a name, a location, *and* a
capital — but each subject also carries its own `attributeKeys`
(`["name", "location"]` / `["capital", "location"]`), which
`gameWizard.js`'s `promptAttributesFor`/`answerAttributesFor` prefer over
the dataset's own (broader) `attributeKeys` when scoping the question/
answer steps. This is what makes them read as two distinct games rather
than one that bundles every fact together, without needing a second
dataset or fetch. Since the override lives on the *subject* rather than
being baked into the dataset, picking "US States" (which swaps
`datasetKey` but keeps the rest of the subject object intact — see
"Regions" below) carries whichever subject's attribute scoping was
already chosen straight into US states too, as long as its own items
actually have that attribute (state capitals are hand-curated directly in
`generate-us-states-data.mjs`, since `us-atlas` carries no attribute data
beyond id/name the way `world-countries` does for the countries dataset).

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

**Infinite horizontal scroll.** An unrestricted world view (no continent
crop, `"naturalEarth1"` projection — `this.wrapEnabled`, checked once at
construction) renders three side-by-side copies of the map's content
instead of one: a "home" copy (the only one with click listeners on its
own real `<path>` elements, and the only one with the tiny-country
hit-area assist system below) flanked by a ghost copy one world-width to
either side. Ghosts are built from SVG `<use href="#...">` references to
the home copy's own paths/border-lines/pin-marker, not real duplicate
elements — a `<use>` re-renders whatever its target currently looks like,
*live*, including dynamically toggled classes (`markResult`'s
`.country--correct`, for instance), so ghosts stay visually in sync with
the home copy automatically. Each ghost country `<use>` also gets its own
click listener reporting the same id its home path would (`.country-ghost`
in `style.css` re-enables `pointer-events` for exactly these, scoped to
non-pin-mode — border-line/pin-marker ghosts stay `pointer-events: none`,
purely decorative), so every *visible* instance of a country is clickable,
not just whichever one is technically "home" at the moment.

`translateExtent`'s x bound is set to `[-Infinity, Infinity]` when
wrapping is on (still `[0, width]` for y — panning off the top/bottom
stays blocked as before) — d3-zoom's own clamping math degrades to a
no-op at infinite bounds (confirmed directly against its `defaultConstrain`
source, not assumed) rather than producing `NaN`, so this is a real,
tested way to let d3-zoom's own tracked transform grow unbounded as the
player keeps panning one direction, with no wall to hit. That raw,
ever-growing transform is *not* what gets rendered, though: every "zoom"
event first runs through `_wrapTransform`, which — only when the home
copy has drifted more than `WRAP_WINDOW` (half a world-width) off-register
— shifts it by exactly one world-width in the direction that reduces the
drift. A whole-world-width shift is invisible on screen precisely because
a ghost copy already occupies the position being shifted *to*. `_wrapPeriod`
(one world-width) and `_homeLeft` (its left edge), both in projected px at
the map's current `fitSize` scale, are recomputed every `_reflow` via
`pathGen.bounds(this.geojson)` — needed since they change with zoom level,
window resize, or (for a differently-scaled dataset) feature count.
`WRAP_WINDOW` is kept at half rather than a full world-width specifically
so the home copy — the only fully-assisted, click-precise copy — never
drifts so far that *neither* it nor a ghost covers more than half the
viewport; a full-period window would let it drift to the very edge of the
ghosts' coverage, leaving the player looking mostly at ghost content with
nothing to click until the next snap.

Only one extra step is needed for pin-drop mode's click handling to keep
working correctly under wrap: `this.currentTransform.invert(...)` (already
used to convert a screen click into the *home* copy's own projected
pixel space) is only correct as-is for a click that visually landed on the
home copy — one that landed on a ghost needs its x folded back into the
home copy's `[_homeLeft, _homeLeft + _wrapPeriod)` range first (a plain
modulo), since ghost content is a repeat of the exact same geography one
or more world-widths over. The modulo is a no-op for a home-copy click (or
whenever wrapping is off), so this doesn't change anything for the
non-wrapped case — the only one that existed before this feature.

A pan/zoom gesture in progress also toggles a `.world-map--panning` class
(via `zoomBehavior.on("start"/"end", ...)` — d3-zoom's own dispatched
gesture-lifecycle events, not native DOM events, so bound on the zoom
behavior itself rather than the selection) that sets `shape-rendering:
optimizeSpeed` for the duration — a well-established SVG performance
technique: drop rendering quality while the player is actively dragging
and looking at the whole shape moving, not any single edge, in exchange
for faster per-frame repaints. Repainting ~240 country paths (more,
counting wrap's ghost copies) at full quality on every drag/wheel tick is
real work a phone GPU in particular can fall behind on, which is what
actually reads as "not smooth" — `will-change: transform` on each copy
group is the complementary compositor hint, telling the browser ahead of
time which layers move every frame instead of it discovering that mid-drag.

The map's own colors (`--map-ocean`/`--map-land`/`--map-land-muted`/
`--map-border` in `style.css`) are deliberately separate variables from
the general `--bg`/`--surface-raised`/`--border` trio the rest of the UI
(buttons, cards) uses — measured (WCAG-style luminance contrast ratio),
not just eyeballed, before choosing new values: the general trio's
ocean-vs-land contrast was only 1.31:1 and country-stroke-vs-fill 1.15:1,
both far too low to tell land from water or one country from its
neighbor on an unbounded map with no border to lean on the way a button
has. The map-specific values push those to ~2.9:1 and ~3:1 respectively,
without touching how buttons/cards look elsewhere (they read fine as-is,
leaning on their own border + spacing rather than fill-vs-background
contrast).

Two independent, differently-scoped filters, both optional:

- `filterIds` — a **hard crop**. Features that don't pass are dropped
  before the projection is fit, not just hidden, so `fitSize` crops/zooms
  to just the remaining region. This is how the region step makes the map
  "only show that region" — `game.js` builds this from `regionItems`
  (region match only, sovereignty not yet applied) once a specific region
  is chosen, `null` (no crop, full world) otherwise.
- `playableIds` — a **soft gate**, always passed by `game.js` (derived
  from whatever `dataset.items` currently is, after all filtering). A
  feature only gets a click listener, normal styling, and a hit-area
  (below) if it's in this set — *independent of whether the topology
  itself assigned it an id*. Everything else renders as an inert, muted
  `.country--unplayable` shape. This is what makes the sovereignty
  setting work: Kosovo/Somaliland/Northern Cyprus have real, permanent ids
  in the topology (see "Data"), but only count as playable when "All"
  (not "All Sovereign") includes them in `dataset.items`. Two shapes
  (Indian Ocean Ter., Siachen Glacier) never get an id at all and so are
  never playable regardless of any setting.

True microstates (Vatican City, Monaco, San Marino, Liechtenstein, Malta,
...) and archipelagos/multi-part countries with no single dominant,
easily-clickable landmass (Maldives, Philippines, Bahamas, Brunei, ...)
get an invisible assist hit-area — a padded convex hull, `<polygon>` —
layered on top of their path (stacked last in DOM order, so it wins
pointer hit-testing even over a larger neighboring country). Built in
`_reflow`, in two passes:

- **Pass 1** decides which playable features *qualify*, from the
  feature's projected bounding box (`pathGen.bounds`), area
  (`pathGen.area`), and — for multi-part features — each individual
  part's own area (`_largestPartAreas`, `pathGen.area` run once per
  `MultiPolygon` coordinate entry, keeping the two biggest): a
  single-blob feature qualifies if its area is under `AREA_RATIO_SINGLE`
  (0.0007×) of the map's own **even-split reference area** —
  `(viewport width × height) / playable feature count`, i.e. the area
  each feature would have if the map were divided evenly among all of
  them. A multi-part feature's own biggest part is checked against that
  same reference too, but in **two tiers**, not one — total area and
  part count still aren't the signal either way, whether any one part is
  already a comfortable click target on its own is, but "comfortable"
  alone isn't quite sufficient either (see below):
  - Under `LARGEST_PART_TIER1_RATIO` (0.018×), it qualifies
    unconditionally — genuinely small regardless of what its other parts
    look like (Philippines' 48 islands and Washington DC's own single
    part both ultimately reduce to this same "is the biggest piece
    small" question, just applied per-part vs. to the whole feature).
  - Between that and `LARGEST_PART_TIER2_RATIO` (0.035×), it needs a
    second part too — one that's at least `SECOND_PART_RATIO` (0.15×) of
    the biggest part's own area, not a negligible speck. This is the
    fix for a real bug the plain single-tier version had: Portugal's
    mainland (0.030×) sat just as close to the qualifying side of a
    single 0.035× cutoff as Philippines' Luzon (0.031×) did, so both
    qualified — but Portugal's *second* part, the Azores, is a genuine
    afterthought (0.008× mainland Portugal, ~52px away), while
    Philippines' second-biggest island, Mindanao, is 0.88× the size of
    its biggest, Luzon — a real second landmass, not a speck. Filling
    the "gap" between Portugal and the Azores produced a hull 18× larger
    than Portugal's own real area (bigger than Philippines' own hull,
    despite Portugal not being any kind of real archipelago) — exactly
    the "redundant, doesn't make sense" hitbox this two-tier check
    exists to catch. Croatia, Ireland, Cuba, and similar "one dominant
    mainland plus an afterthought" countries hit the same fix the same
    way.
  Above `LARGEST_PART_TIER2_RATIO`, nothing qualifies regardless of a
  second part's size — Indonesia, Greece, the UK, Norway, Japan,
  Malaysia, and every large country with a couple of stray offshore
  islets (Russia, Canada, USA, Brazil, Australia, China, France, ...)
  all have one part alone well past that, so their own path is already a
  fine click target and doesn't need a hull spanning their full extent.
  Either way, a feature whose bounding box's larger dimension is at or
  past `HULL_BBOX_CAP` (150px, a fixed px value — see its own comment in
  `WorldMap.js` for why that one doesn't scale like the ratios) is
  skipped even if it would otherwise qualify — this catches the rarer
  case of a small *part* scattered far from the rest (Netherlands'
  Caribbean islands) as well as topology data that wraps around the
  antimeridian (Kiribati, Fiji).

  A separate, unrelated bug shared the same symptom (a hit-region that
  didn't make sense) and got fixed alongside this: the actual topology
  data assigns Ashmore and Cartier Is. the same id as Australia itself
  ("036" — most likely because the uninhabited territory was never given
  its own code upstream). `hitAreasById`, keyed by id like `featuresById`,
  only has one entry per id — without a guard, whichever of the two
  features `_reflow`'s per-feature pass visited *last* silently decided
  what that shared entry's qualification/hull looked like, which in
  practice meant Ashmore and Cartier's own tiny single-part shape (which
  trivially "qualifies" as tiny) was overwriting mainland Australia's
  correct, and correctly non-qualifying, one. A `processedHitAreaIds` set
  in `_reflow` now skips every occurrence of an id past the first —
  harmless, since both features already get their own click listener
  pointed at the same id regardless (a click on either correctly
  resolves to "Australia"), so nothing about clicking either shape
  changes; only which one gets to define the *hit-region* does.

  Measuring against the map's own even-split area, rather than a fixed
  px² value, is what lets the same two ratios work correctly for both
  datasets `WorldMap` renders — the world map fits ~240 countries into
  800×500px, the US states map only 51 states into the same 800×500px,
  so a country and a state at the "same" px² size mean very different
  things about how visually/physically small they actually are.
  Washington DC (~4.4px² at that scale — bigger than *every* country
  microstate's own area) is the case that surfaced this: a fixed
  threshold carried over from the countries dataset would never flag it
  as tiny, yet DC is exactly as disproportionate among US states
  (0.00057× that map's even-split area) as Mauritius is among countries
  (0.00056× the countries map's) once each is measured against its own
  map's scale. Both ratio constants were calibrated against measured
  data, not guessed — see the comments above them in `WorldMap.js` for
  the exact figures and boundary cases (in both datasets) that motivated
  each cutoff. This deliberately excludes ordinary small-but-real
  single-blob features (Luxembourg, Cyprus, Kosovo, Qatar, Jamaica,
  Connecticut, ...) that are perfectly clickable at their true size.

  *(Earlier versions of this used fixed px² thresholds instead of
  ratios — one qualified every multi-part country unconditionally
  regardless of size, over half the dataset, including every large
  country with even one stray offshore islet, badly breaking click
  targeting for countries near them; the next fixed the qualification
  logic but calibrated its thresholds only against the countries
  dataset, so US states too small to click reliably — DC chief among
  them — still fell through uncaught. See LOG.md for both.)*
- **Pass 2** builds each qualifying feature's hit-area: every ring point
  of *every part* is projected and passed to `d3-delaunay`'s convex hull
  (`Delaunay.from(points).hull`), then each hull vertex is pushed outward
  from the feature's own bbox-center by a fixed `HULL_PADDING` (3px). For
  a multi-part feature the hull already spans and fills the water between
  its islands (a straight click between two Maldives atolls, or between
  Luzon and Mindanao in the Philippines, now lands inside it); the
  padding on top guarantees even a naturally tiny hull (Maldives' own two
  atolls sit barely 2.6px apart) ends up comfortably tappable rather than
  merely "as big as its own coastline already was". For a compact
  single-blob microstate, the hull is close to the country's own outline,
  so padding it is effectively the old fixed-size circle, just shaped
  like the country instead of a perfect circle.

A hull built this way can, for some qualifying countries, still nominally
reach toward a real neighbor — Brunei's two enclaves are separated by
Malaysian territory. Rather than hand-picking exceptions, every qualifying
hull is clipped (`clip-path`, SVG `<clipPath>` + `<polygon>`, one
pre-built per playable feature) to its **Voronoi cell** — computed once
per `_reflow` over *every* playable country's bbox-center (not just
qualifying ones, so an ordinary neighbor like Malaysia still bounds a
qualifying country's hull even though it doesn't get a hull of its own),
via `d3-delaunay`. The cell boundary between two sites is exactly the
line equidistant from both, so a hull can never actually reach past the
midpoint toward a real neighbor's own territory, however far its raw
(unclipped) shape would otherwise extend. This is the same clipping
mechanism this project has used since the microstate-only version of this
feature (previously scoped to just the "tiny" subset of countries; now
computed over the full playable set so it can safely bound larger
multi-part hulls too) — a country with no nearby qualifying neighbor gets
a cell far bigger than its own hull, so clipping is applied uniformly but
is a geometric no-op for it. (SVG `clip-path` restricts pointer
hit-testing to the clipped region, not just paint, in every evergreen
browser, which is what makes this work for clicks and not just visuals —
unverified here since no real browser is available in this sandbox, see
"Environment notes".)

`highlight`/`select`/`markResult`/`clearMarks` all apply their CSS class
to both the real path *and* its hit-area (if any) — for a country small
enough to need one, the real shape is often too tiny to see any fill
change on, so the hit-area is what actually shows the player their
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
below the click-priority hit-areas, `pointer-events: none` so it's
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
before tearing it down and, if the setting is on (the default), feeds it
back in as `initialTransform` for the next round's map. When the setting
is off, it passes nothing and each round starts fresh instead.

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
answer area and the action button and clears it each round. Every widget
says "Correct!" on a right answer; on wrong, text-guess and multiple-
choice show the correct answer (the player's own wrong guess is still
visible — in the disabled input for text-guess, highlighted red among the
options for multiple-choice), map-click explicitly names *both* the
country the player clicked (looked up by id in `dataset.items`) and the
correct one — a coloured map alone doesn't reliably tell you which
country you actually hit, especially a small one — and map-pin (below)
adds a distance figure to whichever of the two messages applies.

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

**Pin drop** (`inputs.js`'s `"map-pin"` renderer, `location`'s second
`answerKind`) is `map-click`'s opposite: instead of a discrete "which
country did you click" target, the player drops a pin anywhere on a
`WorldMap` constructed with `pinMode: true` — no per-country click targets
or borders (see "Map" above), just a single whole-map click that places a
marker and reports `(lon, lat, containingId)`, `containingId` being
whichever playable country's real (invisible) shape the point falls
inside, via a plain ray-casting point-in-polygon test on the raw lon/lat
ring coordinates (`WorldMap._findContainingId`/`pointInFeature` — no SVG
geometry APIs, so it works identically at any zoom/pan and doesn't depend
on real-browser layout). The widget reports `containingId` (or `null`,
over open ocean or unplayable territory) via `onSelect`, exactly like
map-click's country id — so `QuizSession`/`attributes.js`'s existing
id-equality `checkAnswer` needs no pin-specific logic at all; only the
*feedback* differs. On confirm, `map.markResult` reveals the correct
country's actual shape (and the wrong guess's, if the pin happened to
land inside a different real country) the same way map-click always has;
`showResult` additionally computes a great-circle distance
(`haversineKm`, `inputs.js`) between the pin's own lon/lat and the
target's `latlng` field (present on every item — see "Data" below) and
appends it to the feedback text ("You were 340 km from its center").
There's no reclick-to-confirm shortcut here (unlike map-click/multiple-
choice) — repositioning the pin before confirming is just another click
anywhere, always reported via `onSelect` again, never itself a confirm.

Only meaningful for a dataset with real geographic coordinates:
`gameWizard.js`'s `availableAnswerKinds` prunes `"map-pin"` back out of
`location`'s `answerKinds` list when `datasetMeta.projection ===
"identity"` (US states' pre-projected Albers topology has no lon/lat to
invert a click to) rather than the attribute itself knowing about
datasets, keeping `attributes.js` dataset-agnostic. Since answer type is
picked *before* region — and region can, for the Caribbean → US States
option, silently swap to a different (identity-projection) dataset
entirely — `showSubRegionStep`'s dataset-switch branch re-validates a
previously-picked `"map-pin"` back down to `"map-click"` at the point of
switching, rather than letting an already-made "identity" answer kind
choice carry through to a dataset it doesn't apply to.

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
  type (→ how to answer, for name: type it or multiple choice, for
  location: click the map or drop a pin → how many options, 2–6, if
  multiple choice) → region (Europe/Asia/Oceania/World directly, or
  Africa/America via a sub-region screen: North America/South America/
  Caribbean/**US States**) → sovereignty (All / All Sovereign — skipped
  for US States, which has no such concept) → play. Every region and
  sovereignty option shows the item count it'd leave you with ("All
  (236)", "Europe (54)"). Every step is its own screen with Back
  navigation all the way to home.
- Two datasets: world countries (235 standard + 3 opt-in extra territories
  under "All") and US states (50 states + DC, reached via Region → America
  → US States rather than the Subject step — see "Regions" above). For
  countries, the map itself is cropped to the chosen region, not just
  which countries are asked about.
- Two attributes: name, location. Four answer styles across them: type
  the name, pick the name from 2–6 multiple-choice options, click the
  map, or drop a pin on a borderless map (reveals the correct outline and
  a distance-from-target figure on confirm; not offered for US states,
  see "Widget registries" above). Two mode pairs: name→location (click
  the country, or drop a pin) and location→name (typed or multiple
  choice).
- Select → confirm → result → next round flow: pick a country, a text
  guess, a multiple-choice option, or a pin location, confirm via the
  button, Enter, or re-clicking the same selection (pin drop has no
  reclick shortcut — repositioning is just another click), see the
  result, then advance via the button or by clicking anywhere.
- Tiny countries get a small invisible click target so they're actually
  clickable/selectable at normal zoom; overlapping ones (dense clusters
  like the Lesser Antilles) are split along their Voronoi boundary so
  neither steals the other's clicks.
- Serbia/Kosovo's shared border renders dashed, flagging it as disputed
  rather than an ordinary international border.
- Map supports scroll/pinch/drag zoom (double-click-to-zoom disabled); a
  persistent Settings preference controls whether zoom carries over
  between rounds (default) or resets every round. An unrestricted World
  view scrolls infinitely left/right (wraps around rather than stopping
  at the antimeridian) — a continent-cropped view or the US states map
  don't, since neither tiles into a seamless loop.
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
