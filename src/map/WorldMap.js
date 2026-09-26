// Reusable SVG map: renders any topojson object (keyed by feature id) with
// d3-geo/topojson-client, and exposes highlight/select/click/feedback hooks
// plus scroll-wheel/pinch zoom (d3-zoom). This module doesn't know about
// "countries" specifically — any dataset with a topojson topology +
// matching item ids works the same way, so a second map-based dataset
// (US states) reuses it with only its `projection` config differing.

import { geoNaturalEarth1, geoIdentity, geoPath } from "d3-geo";
import { feature, mesh, merge } from "topojson-client";
import { zoom, zoomIdentity } from "d3-zoom";
import { select } from "d3-selection";
import { Delaunay } from "d3-delaunay";

const SVG_NS = "http://www.w3.org/2000/svg";
// Keyed by dataset.projection (see core/datasets.js) so datasets.js itself
// never has to import d3. "naturalEarth1" (default) is a whole-world
// projection expecting raw lon/lat input, used for the countries dataset.
// "identity" is a pass-through for topologies that arrive already
// projected — us-states' topology is pre-built with Albers USA (Alaska/
// Hawaii relocated into their conventional insets), so it just needs its
// existing flat coordinates fit to the viewport, not projected again.
const PROJECTIONS = {
  naturalEarth1: () => geoNaturalEarth1(),
  identity: () => geoIdentity(),
};
// Both thresholds below are *ratios* against a map's own "even-split"
// reference area — (viewport width × height) / playable feature count,
// i.e. the area each feature would have if the map were divided evenly
// among all of them — rather than fixed px² values. This matters because
// this same WorldMap renders very differently-scaled datasets into the
// same viewport: the world map fits ~240 countries into 800×500px
// (even-split ≈ 1674px²), but the US states map fits only 51 states into
// the same 800×500px (even-split ≈ 7843px², ~4.7× bigger) — a fixed px²
// "is this tiny" cutoff calibrated for one badly undersizes or oversizes
// on the other. Washington DC is a perfect illustration: its own area
// (~4.4px² at that scale) is comfortably *larger* than every country
// microstate's, so a fixed threshold carried over from the countries
// dataset would never flag it as tiny — yet DC is proportionally just as
// much of an outlier among US states (0.00057× the states map's
// even-split area) as Mauritius is among countries (0.00056× the
// countries map's) once each is measured against its own map's scale.

// A single-blob feature (no second part) gets an assist hit-region if its
// own area is under this fraction of the map's even-split reference.
// Calibrated against the countries dataset: true microstates (Vatican
// City, Monaco, San Marino, Liechtenstein, Bahrain, Mauritius — 0.00022×
// to 0.00056×) sit under this; ordinary small-but-real countries
// (Luxembourg 0.00097×, Cyprus 0.0019×) don't. Confirmed to transfer
// correctly to the US states dataset: DC (0.00057×) sits under it the
// same way Mauritius does; every other state (Rhode Island, the next
// smallest, at 0.0083×) sits well clear.
const AREA_RATIO_SINGLE = 0.0007;
// A multi-part feature's qualification has two tiers, both measured
// against its *largest* part's own area (not total area or part count —
// Philippines has 48 parts and a large total, but what actually matters
// is whether any one part is already a comfortable click target):
//
// - Under LARGEST_PART_TIER1_RATIO (0.018), it qualifies unconditionally
//   — the largest part alone is small enough that widening/gap-filling is
//   clearly warranted regardless of whether a second part is significant.
//   This is what correctly includes Washington DC-scale cases on the US
//   states map (Rhode Island 0.0083×, Delaware 0.0172×) as well as every
//   genuine small archipelago (Vanuatu 0.0012×, Bahamas 0.0011×, ...).
// - Between that and LARGEST_PART_TIER2_RATIO (0.035), it *additionally*
//   needs a second part that's a real, comparably-sized landmass — at
//   least SECOND_PART_RATIO (0.15) of the largest part's own area — not
//   just a negligible speck. This is what separates Philippines (second-
//   biggest island, Mindanao, is 0.88× its biggest, Luzon — a real second
//   landmass that legitimately needs its own gap filled) and Hawaii
//   (0.18×) from Portugal (Azores are 0.008× mainland Portugal — a
//   negligible speck ~52px away that inflates the hull to 18× Portugal's
//   own real area, bigger than Philippines' hull despite Portugal not
//   being any kind of real archipelago) and the same pattern in Croatia
//   (0.013×), Ireland (0.002×), Cuba (0.021×), and similar "one dominant
//   mainland plus an afterthought" countries that don't need gap-filling
//   at all — their own path is already a perfectly good click target.
// Above LARGEST_PART_TIER2_RATIO, nothing qualifies regardless of a
// second part's size — Indonesia, Greece, the UK, Norway, Japan,
// Malaysia, and every large sprawling country with a few stray offshore
// islets (Russia, Canada, USA, Brazil, Australia, China, ...) all have
// one part alone well past this.
const LARGEST_PART_TIER1_RATIO = 0.018;
const LARGEST_PART_TIER2_RATIO = 0.035;
const SECOND_PART_RATIO = 0.15;
// Safety cap (px, bounding-box max dimension) — deliberately *not*
// scaled like the ratios above, since viewport size itself (not feature
// count) is what it's guarding: no legitimate hit-region should ever
// span a large fraction of the visible map regardless of how few or many
// features share it. Independent of LARGEST_PART_TIER2_RATIO, it catches a
// handful of cases that would otherwise slip through: a feature whose
// *largest* part is small but whose parts are scattered across a huge
// span, either because it has real far-offshore territory (Netherlands'
// Caribbean islands, ~167px from the mainland) or because the raw
// topology data wraps around the antimeridian and produces a bogus
// bounding box spanning almost the whole map (Kiribati 785px, Fiji
// 800px). No genuine, safe-to-hull-fill case in either dataset gets
// anywhere near this (Indonesia, the widest real one excluded solely by
// LARGEST_PART_TIER2_RATIO, is 103px; Hawaii, the widest one that qualifies
// under the current datasets, is ~91px).
const HULL_BBOX_CAP = 150;
// Every hit-region hull vertex gets pushed outward from the feature's own
// centroid by this many px, so even a naturally tiny/compact hull (two
// Maldives atolls barely 2.6px apart) ends up comfortably tappable
// instead of just "sized to its own coastline".
const HULL_PADDING = 3;
// How far (as a fraction of one full world-width, in current screen px)
// the "home" copy is allowed to drift off-register before wrapping snaps
// it back by exactly one world-width — see _wrapTransform. Kept well
// under 1 (a full period) rather than right at the edge: the two ghost
// copies are visual-only (see the constructor), so the home copy — the
// only one that's actually clickable — needs to stay substantially
// on-screen at all times, not just barely touching it, or the player
// would be looking at content they can't tap until the next snap.
const WRAP_WINDOW = 0.5;
// Zoom bounds, in units of "the whole dataset fitted to the viewport" — so
// k=1 is always the entire world (or the entire US states map), whatever
// region is being played. This is only meaningful because the projection
// itself is now region-independent: every game fits the *same* full
// topology and expresses its region as a starting zoom/pan transform
// instead (see _defaultTransform). Previously each region re-fit the
// projection to its own bounds, which made k=1 mean something different
// per region and capped World-map zoom-in far short of what a continent
// game allowed — the same "10x" was 10x a much wider baseline.
//
// MAX_ZOOM is set so the tightest reachable view is at least as detailed
// as the old per-region maximum: Europe used to fit at ~4.6x the world
// fit's scale and allowed 10x on top of that, so ~46x world-scale was
// already reachable. 50 clears that with a little headroom.
const MIN_ZOOM = 1;
const MAX_ZOOM = 50;
// The dropped-pin marker's on-screen radius (px), held constant regardless
// of zoom level — see the "zoom" handler below, which counter-scales the
// SVG `r` attribute against the current transform's scale so the pin
// neither grows when zooming in nor shrinks when zooming out, the same
// way every country border stays a constant width via non-scaling-stroke
// (a technique that only applies to strokes, not a circle's own radius,
// hence doing it by hand here instead).
const PIN_RADIUS_PX = 4;
// How much bigger (px) the pin's click-to-confirm hit-area is than the
// marker's own visible radius — generous on purpose, since the visible
// dot is deliberately small (see above) and re-clicking it precisely
// would otherwise be an unreasonably fiddly gesture, especially on touch.
const PIN_CONFIRM_PADDING_PX = 10;
// Pin mode's merged landmass (`topojson.merge()`, see _reflow) comes out
// with a couple of degenerate hairline polygons — artifacts of dissolving
// shared arcs that don't perfectly cancel, not real geography. Measured
// directly against the world topology at an 800×500 fit: one spans
// 799.6px (the *entire* map width) at 0.29px tall, another 604.0px at
// 1.67px tall, with 10 and 43 points respectively. Both render as thin
// bright streaks of land across open ocean — sub-pixel and so invisible at
// the default zoom, but they scale with the zoom transform like everything
// else, so by the far end of `scaleExtent` they're several px thick and
// read exactly like a stray border line, which is what surfaced them.
//
// These two thresholds identify that shape — extreme elongation that
// *also* spans a large fraction of the map — together, never either alone,
// because either one alone would catch real geography: Antarctica is
// legitimately wide-and-short, so a pure aspect test would drop it; and
// genuinely tiny real islands are extremely thin without spanning
// anything, so a pure thinness test would drop those.
//
// Aspect ratio rather than an absolute px thickness, deliberately: a
// thickness cutoff has to be re-justified per viewport (the same artifact
// measures 1.67px thick at an 800×500 fit but over 2px at 1920×1080,
// which silently let one of the two through when this was first written
// that way), whereas aspect ratio is scale-invariant — one measurement
// characterizes every viewport. Measured across every polygon spanning
// >10% of the map: the two artifacts sit at aspect 2799 and 361, the
// widest real feature (Antarctica) at 11.2, and nothing else above 2.4.
// A cutoff of 50 sits in that empty gap with a 7x margin below the
// nearest artifact and a 4.5x margin above Antarctica.
const MERGE_SLIVER_MIN_ASPECT = 50;
const MERGE_SLIVER_MIN_SPAN_FRACTION = 0.1; // of the larger viewport dimension

// Standard even-odd ray-casting point-in-polygon test, run directly on raw
// lon/lat ring coordinates (pin mode's `_findContainingId` is the only
// caller) — deliberately not projection/SVG-dependent, so it works
// identically at any zoom level and is plain unit-testable.
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// `coordinates`: one Polygon's rings — the first is the outer boundary,
// any further rings are holes cut out of it.
function pointInPolygonCoords(lon, lat, coordinates) {
  if (!coordinates[0] || !pointInRing(lon, lat, coordinates[0])) return false;
  for (let i = 1; i < coordinates.length; i++) {
    if (pointInRing(lon, lat, coordinates[i])) return false; // inside a hole
  }
  return true;
}

function pointInFeature(lon, lat, feature) {
  const geometry = feature.geometry;
  if (!geometry) return false;
  if (geometry.type === "Polygon") return pointInPolygonCoords(lon, lat, geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.some((poly) => pointInPolygonCoords(lon, lat, poly));
  return false;
}

const EARTH_RADIUS_KM = 6371;

// Real great-circle distance (km) between two [lon, lat] points — unlike
// the local-plane approximation below, used wherever the two points might
// be genuinely far apart (revealCapitalDistance: a pin dropped anywhere in
// a large country vs. its capital), where that approximation's flat-earth
// assumption would start introducing real error.
function haversineKm([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Flattens lon/lat to a local tangent-plane xy (km) around a fixed
// reference latitude, purely so a border segment's closest point can be
// found with plain planar geometry — good enough for a "how far off was
// your guess" readout (border segments are short relative to the earth's
// curvature) without pulling in a full geodesic library.
function lonLatToLocalKm(lon, lat, refLat) {
  const rad = Math.PI / 180;
  return [lon * rad * Math.cos(refLat * rad) * EARTH_RADIUS_KM, lat * rad * EARTH_RADIUS_KM];
}

// Inverse of the above, at the same reference latitude used to flatten the
// points being compared — turns a closest-point-on-segment result (found in
// local xy) back into a real lon/lat the map can actually plot a line to.
function localKmToLonLat(x, y, refLat) {
  const rad = Math.PI / 180;
  return [x / (rad * Math.cos(refLat * rad) * EARTH_RADIUS_KM), y / (rad * EARTH_RADIUS_KM)];
}

// Nearest point (lon/lat) on the segment [lon1,lat1]-[lon2,lat2] to (lon,
// lat), clamped to the segment itself (not the infinite line through it),
// plus the distance (km) to it — both via the local-plane approximation
// above, using the query point's own latitude as the one fixed reference so
// both ends of the comparison (the query point and the candidate point)
// scale consistently.
function nearestPointOnSegmentKm(lon, lat, [lon1, lat1], [lon2, lat2]) {
  const refLat = lat;
  const [px, py] = lonLatToLocalKm(lon, lat, refLat);
  const [ax, ay] = lonLatToLocalKm(lon1, lat1, refLat);
  const [bx, by] = lonLatToLocalKm(lon2, lat2, refLat);
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { point: localKmToLonLat(cx, cy, refLat), distanceKm: Math.hypot(px - cx, py - cy) };
}

function ringNearestBorderPoint(lon, lat, ring) {
  let best = null;
  for (let i = 0; i < ring.length - 1; i++) {
    const candidate = nearestPointOnSegmentKm(lon, lat, ring[i], ring[i + 1]);
    if (!best || candidate.distanceKm < best.distanceKm) best = candidate;
  }
  return best;
}

// Nearest point (lon/lat) on a feature's own outline to (lon, lat), plus
// the distance (km) to it — every ring of every part (an archipelago's
// coastline is still its border, same as a mainland's), not just the outer
// boundary of its largest part. Returns null only if the feature has no
// polygon geometry at all.
function featureNearestBorderPoint(lon, lat, feature) {
  const geometry = feature.geometry;
  const polygons =
    geometry?.type === "MultiPolygon" ? geometry.coordinates : geometry?.type === "Polygon" ? [geometry.coordinates] : null;
  if (!polygons) return null;
  let best = null;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      const candidate = ringNearestBorderPoint(lon, lat, ring);
      if (candidate && (!best || candidate.distanceKm < best.distanceKm)) best = candidate;
    }
  }
  return best;
}

let instanceCounter = 0;

export class WorldMap {
  constructor(
    container,
    { topology, objectKey, focusIds, playableIds, dashedBorders, projection, initialTransform, pinMode }
  ) {
    this.container = container;
    this.topology = topology;
    this.objectKey = objectKey;
    this.onClick = null;
    this.clickEnabled = false;
    // Borderless "drop a pin anywhere" mode: no per-country click targets
    // or hit-area assists (pointless — a click can land anywhere, not on
    // a discrete feature), a single whole-map click handler instead (see
    // the click listener on `this.svg` below), and `onClick` is called
    // with `(lon, lat, containingId)` rather than just an id.
    this.pinMode = Boolean(pinMode);
    this.pinLonLat = null;
    this._instanceId = `wm${instanceCounter++}`;

    // Infinite horizontal wrap applies to any lon/lat-projected view. Only
    // a pre-projected "identity" topology (US states' Albers projection,
    // with Alaska/Hawaii relocated into fixed insets) has no periodic
    // lon/lat structure to wrap at all. See _wrapTransform/_applyTransform
    // for how the wrap itself works, and the per-feature loop below for
    // how "one copy" of the map's content is built once and reused for
    // all three.
    this.wrapEnabled = (projection ?? "naturalEarth1") !== "identity";
    this._wrapPeriod = null; // one world-width, in projected px at the current fitSize scale — set in _reflow
    this._homeLeft = null; // left edge of that same world, in the same units

    const topologyObject = topology.objects[objectKey];
    // Every map renders the *entire* dataset, always — a region is never a
    // crop. Picking Europe changes which features are playable
    // (`playableIds`, below) and where the view starts (`focusIds` ->
    // _defaultTransform), nothing about what exists. Keeping one
    // region-independent projection is what makes zoom levels mean the
    // same thing everywhere (see MIN_ZOOM/MAX_ZOOM) and lets the rest of
    // the world stay visible-but-muted around whatever's in play.
    this.geojson = feature(topology, topologyObject);
    // Pin mode only: the *raw* topology geometry objects (arc-index form,
    // before `feature()` converts them to projected-ready GeoJSON) —
    // `topojson.merge()` (see _reflow) needs these specifically, since it
    // works at the arc level to dissolve exactly the internal borders
    // shared between merged features, which a post-conversion GeoJSON
    // polygon has no way to identify any more. `this.geojson.features` and
    // `topologyObject.geometries` are index-aligned 1:1 (feature()
    // preserves order for a GeometryCollection), which is what lets the
    // playable subset below be selected by index.
    this._rawGeometries = this.pinMode ? topologyObject.geometries : null;
    // Which feature ids the initial view frames itself on — the chosen
    // region, minus any member excluded from framing specifically
    // (core/regions.js's `fitExclude`; see _defaultTransform). Null means
    // "frame everything", i.e. the whole world.
    this._focusIds = focusIds ?? null;

    this.projection = (PROJECTIONS[projection] ?? PROJECTIONS.naturalEarth1)();
    this.pathGen = geoPath(this.projection);

    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("class", "world-map" + (this.pinMode ? " world-map--pin-mode" : ""));
    this.svg.setAttribute("role", "img");
    this.svg.setAttribute("aria-label", "World map");
    // Stop mobile browsers from hijacking pinch/scroll for page zoom so
    // d3-zoom sees the gesture instead.
    this.svg.style.touchAction = "none";
    container.appendChild(this.svg);

    this.defs = document.createElementNS(SVG_NS, "defs");
    this.svg.appendChild(this.defs);

    // Three side-by-side copies of the same content when wrapping is on
    // (just one otherwise): -1 (a "ghost" one world-width to the left),
    // 0 (the "home" copy — the only one with hit-areas/the tiny-country
    // click-precision assist), +1 (a ghost to the right). _applyTransform
    // positions each one `offset` world-widths away from the home copy on
    // every zoom/pan tick, and _wrapTransform keeps the home copy from
    // ever drifting so far off-register that it or a ghost stops covering
    // at least half the viewport — see the WRAP_WINDOW comment above. The
    // ghost copies are built from SVG `<use>` references to the home
    // copy's own paths rather than real duplicate elements: a `<use>`
    // re-renders whatever its target currently looks like live, including
    // dynamically toggled classes (e.g. markResult's `.country--correct`),
    // so the ghosts automatically stay visually in sync with the home
    // copy without this class updating them itself. Each country ghost
    // also gets its own click listener (see further down) reporting the
    // same id its home path would, so every *visible* instance of a
    // country is clickable, not just whichever copy happens to be "home"
    // at the moment — border-line and pin-marker ghosts stay
    // `pointer-events: none` (style.css), purely decorative.
    this.copyOffsets = this.wrapEnabled ? [-1, 0, 1] : [0];
    this.copyGroups = new Map(); // offset -> <g>
    for (const offset of this.copyOffsets) {
      const group = document.createElementNS(SVG_NS, "g");
      group.setAttribute("class", offset === 0 ? "world-copy world-copy--home" : "world-copy world-copy--ghost");
      this.svg.appendChild(group);
      this.copyGroups.set(offset, group);
    }
    this.homeGroup = this.copyGroups.get(0);

    // Pin mode only: two merged paths standing in for every per-country
    // fill — see _reflow, where their `d`s are set via topojson.merge().
    // `pinLandmass` is the whole world, muted; `pinPlayableLandmass` is the
    // currently-playable subset in the normal land color, drawn directly on
    // top of it. Between them they carry the same playable/unplayable
    // distinction per-country paths carry everywhere else, while keeping
    // pin mode's defining property — no internal country borders — because
    // a merged shape has no edges between originally-adjacent members left
    // to seam *at*, unlike independently-antialiased adjacent paths that
    // merely happen to share a fill color. Inserted first (bottom of paint
    // order), so everything else layers above them.
    this.pinLandmass = document.createElementNS(SVG_NS, "path");
    this.pinLandmass.id = `${this._instanceId}-landmass`;
    this.pinLandmass.setAttribute("class", "pin-landmass");
    this.pinPlayableLandmass = document.createElementNS(SVG_NS, "path");
    this.pinPlayableLandmass.id = `${this._instanceId}-landmass-playable`;
    this.pinPlayableLandmass.setAttribute("class", "pin-landmass pin-landmass--playable");
    if (this.pinMode) {
      this.homeGroup.appendChild(this.pinLandmass);
      this.homeGroup.appendChild(this.pinPlayableLandmass);
    }

    // Everything below is built once, directly, into the home copy;
    // ghost copies (if any) are populated as <use> clones of it further
    // down.
    this.featuresById = new Map(); // playable id -> home copy's <path>
    this.hitAreasById = new Map();
    this.hitClipsById = new Map();
    // id -> { points: unpadded hull vertices, cx, cy } for every qualifying
    // (assisted) country — recomputed only in _reflow's Pass 2 (construction
    // or a real resize). Padding is deliberately *not* baked into these:
    // see the "zoom" handler below for why.
    this._hullBaseById = new Map();
    // id -> raw geojson feature (not just playable ones' <path> elements) —
    // used by revealBorderDistance, which needs the actual ring coordinates,
    // not anything SVG/projection-dependent.
    this._geometryById = new Map(this.geojson.features.filter((f) => f.id).map((f) => [f.id, f]));

    this.borderGroup = document.createElementNS(SVG_NS, "g");
    this.borderGroup.setAttribute("class", "border-lines");
    this.homeGroup.appendChild(this.borderGroup);
    this.hitGroup = document.createElementNS(SVG_NS, "g");
    this.hitGroup.setAttribute("class", "hit-areas");
    this.homeGroup.appendChild(this.hitGroup);

    // The dropped-pin marker (pin mode only) — decorative itself
    // (pointer-events: none, see style.css), but paired with a separate,
    // larger invisible hit-area circle (below) that *is* clickable, so a
    // click that actually lands on the marker's small visible dot confirms
    // instead of repositioning it — every other click on the map still
    // reaches the whole-map listener below and (re)drops the pin there.
    this.pinMarker = document.createElementNS(SVG_NS, "circle");
    this.pinMarker.id = `${this._instanceId}-pin`;
    this.pinMarker.setAttribute("class", "pin-marker");
    this.pinMarker.setAttribute("r", String(PIN_RADIUS_PX)); // kept in sync with the current zoom scale by the "zoom" handler below
    this.pinMarker.style.display = "none";
    this.homeGroup.appendChild(this.pinMarker);

    // Set via setClickable's third argument; invoked by the whole-map click
    // listener when a click lands close enough to the pin already down (see
    // there — the check is geometric, not a clickable overlay element).
    this._onPinConfirm = null;

    // A line from the dropped pin to the reveal target — either the
    // nearest point on the target country's border (revealBorderDistance,
    // "Region" pin-target mode) or the target's exact capital point
    // (revealCapitalDistance, "Capital" mode) — shown only post-confirm,
    // and only when that distance is nonzero. The visual counterpart of
    // the km figure in the feedback text, not just a number.
    this.pinBorderLine = document.createElementNS(SVG_NS, "line");
    this.pinBorderLine.id = `${this._instanceId}-pin-border-line`;
    this.pinBorderLine.setAttribute("class", "pin-border-line");
    this.pinBorderLine.style.display = "none";
    this.homeGroup.appendChild(this.pinBorderLine);
    this._revealedBorderTarget = null; // { pinLonLat, point } — re-projected on every _reflow, see below

    // The capital's own exact point, shown only by revealCapitalDistance —
    // there's nothing equivalent to reveal for "Region" mode, since the
    // target country's own outline (`.country--correct`) already shows
    // where it is.
    this.capitalMarker = document.createElementNS(SVG_NS, "circle");
    this.capitalMarker.id = `${this._instanceId}-capital-marker`;
    this.capitalMarker.setAttribute("class", "capital-marker");
    this.capitalMarker.setAttribute("r", String(PIN_RADIUS_PX)); // kept in sync with the current zoom scale by the "zoom" handler below, same as pinMarker
    this.capitalMarker.style.display = "none";
    this.homeGroup.appendChild(this.capitalMarker);
    this._revealedCapitalPoint = null; // lon/lat — re-projected on every _reflow, see below

    // Pin mode renders NO per-country paths at all (see the per-feature
    // loop below) — `pinLandmass` is the whole map. This single spare path
    // is what `markResult` draws the post-confirm target reveal into
    // instead: its `d` is set to that one feature's projected outline on
    // demand, and cleared by clearMarks. Doing it this way rather than
    // hiding 240 real per-country paths with CSS is what makes a stray
    // country border *structurally* impossible here rather than merely
    // styled-away — there is simply no element that could paint one, so no
    // stylesheet rule (a `:hover` rule outranking the pin-mode one, say)
    // can bring one back. See _mark/_forEachMarked.
    this.revealPath = document.createElementNS(SVG_NS, "path");
    this.revealPath.id = `${this._instanceId}-reveal`;
    this.revealPath.setAttribute("class", "country");
    this.revealPath.style.pointerEvents = "none";
    this._revealedFeatureId = null; // kept so _reflow can re-project it
    if (this.pinMode) this.homeGroup.appendChild(this.revealPath);

    // Data-driven, not hardcoded to any specific pair: dashedBorders is a
    // list of [idA, idB] country-id pairs (see core/datasets.js) whose
    // *shared* border — extracted via topojson's mesh(), not their whole
    // outline — renders dashed, to flag a disputed frontier instead of
    // drawing it like a normal international border.
    this.borderLines = (dashedBorders ?? []).map(([idA, idB], i) => {
      const path = document.createElementNS(SVG_NS, "path");
      path.id = `${this._instanceId}-border-${i}`;
      path.setAttribute("class", "border--disputed");
      path.style.pointerEvents = "none";
      this.borderGroup.appendChild(path);
      return { idA, idB, path };
    });

    this._pathsByIndex = []; // home copy's <path> per geojson.features index (playable or not) — read back in _reflow to set each `d`
    // Which ids count as playable — the same gate `featuresById` doubles as
    // outside pin mode, tracked separately because pin mode deliberately
    // builds no per-country paths to populate that map with, yet still
    // needs the gate itself (`_findContainingId` won't resolve a pin drop
    // to an unplayable feature).
    this._playableIds = new Set();

    for (const [index, f] of this.geojson.features.entries()) {
      // "Playable" gates click handling, normal styling, and a hit-circle —
      // independent of whether the topology happens to have assigned this
      // feature an id. This is what lets e.g. Kosovo exist in the topology
      // year-round but only be interactive when the extra-territories
      // setting is on: playableIds is derived from whatever the current
      // game's item list actually is.
      const playable = Boolean(f.id) && (!playableIds || playableIds.has(f.id));
      if (playable) this._playableIds.add(f.id);

      // Pin mode draws the whole map as one merged `pinLandmass` path and
      // nothing else (plus `revealPath` on confirm), so per-country paths
      // aren't just hidden here — they're never created. Index alignment
      // with `geojson.features` still matters for `_reflow`, hence the
      // null placeholder.
      if (this.pinMode) {
        this._pathsByIndex.push(null);
        continue;
      }

      const path = document.createElementNS(SVG_NS, "path");
      path.id = `${this._instanceId}-f${index}`;
      // Three states, not two — see style.css. A feature with no id isn't a
      // country at all (Siachen Glacier, Indian Ocean Ter.): it's terrain,
      // and painting it like a *disabled country* left a stray grey
      // triangle between fully-playable neighbours. `--unplayable` is
      // reserved for real countries that are genuinely out of play.
      const stateClass = !f.id ? " country--terrain" : playable ? "" : " country--unplayable";
      path.setAttribute("class", "country" + stateClass);

      // Pin mode never reaches here (it `continue`d above), so everything
      // below is unconditionally non-pin-mode.
      if (playable) {
        path.dataset.id = f.id;
        this.featuresById.set(f.id, path);

        path.addEventListener("click", () => {
          if (this.clickEnabled && this.onClick) this.onClick(f.id);
        });

        // A polygon rather than a circle so it can be shaped as a padded
        // convex hull around a country's parts (see _computeHull) — this
        // covers both compact microstates (hull ~= a small rounded blob)
        // and archipelagos (hull spans and fills the gaps between
        // islands) with one mechanism. Home copy only (not ghosted) —
        // this is a click-precision assist, and the home copy is always
        // the one within reach of the viewport (see WRAP_WINDOW).
        const hitArea = document.createElementNS(SVG_NS, "polygon");
        hitArea.setAttribute("class", "country-hitarea");
        hitArea.style.display = "none"; // shown only if the shape qualifies, in _reflow
        hitArea.addEventListener("click", () => {
          if (this.clickEnabled && this.onClick) this.onClick(f.id);
        });
        this.hitGroup.appendChild(hitArea);
        this.hitAreasById.set(f.id, hitArea);

        // Lets two nearby assisted countries' hit-regions be clipped to
        // the Voronoi cell around each one's center (computed over every
        // playable country, not just assisted ones — a plain neighbor can
        // still bound an archipelago's hull-fill, e.g. keeps Brunei's
        // hull, which naturally spans the gap between its two enclaves,
        // from bleeding into Malaysia's territory in between) — see
        // _reflow.
        const clipId = `${this._instanceId}-hitclip-${f.id}`;
        const clipPath = document.createElementNS(SVG_NS, "clipPath");
        clipPath.id = clipId;
        const polygon = document.createElementNS(SVG_NS, "polygon");
        clipPath.appendChild(polygon);
        this.defs.appendChild(clipPath);
        this.hitClipsById.set(f.id, { clipId, polygon });
      }

      this.homeGroup.insertBefore(path, this.borderGroup);
      this._pathsByIndex.push(path);
    }

    // Ghost <use> clones — one per home-copy path/border line/pin marker,
    // in each ghost group. Ignored entirely when wrapping is off. A
    // ghost's own click listener (playable features only, same as the
    // home copy's) fires with the *same* id its home path would — clicks
    // work identically on a ghost as on the home copy, rather than
    // relying only on the wrap-snap keeping the home copy close enough to
    // the viewport that a ghost is rarely clicked at all (WRAP_WINDOW
    // still guarantees at least half the viewport is always the clickable
    // home copy, but "at least half" isn't "all of it").
    for (const offset of this.copyOffsets) {
      if (offset === 0) continue;
      const group = this.copyGroups.get(offset);
      // Inserted first, same as in the home group, so they stay the bottom
      // layers here too. In pin mode these are the *only* country-shaped
      // things a ghost copy carries — there are no per-country paths to
      // clone, so the loop below is skipped entirely.
      if (this.pinMode) {
        group.appendChild(this._makeUse(this.pinLandmass.id));
        group.appendChild(this._makeUse(this.pinPlayableLandmass.id));
        group.appendChild(this._makeUse(this.revealPath.id));
      }
      for (const path of this._pathsByIndex) {
        if (!path) continue; // pin mode — no per-country paths exist
        const use = this._makeUse(path.id);
        use.setAttribute("class", "country-ghost");
        const fId = path.dataset.id;
        if (fId) {
          use.addEventListener("click", () => {
            if (this.clickEnabled && this.onClick) this.onClick(fId);
          });
        }
        group.appendChild(use);
      }
      for (const { path } of this.borderLines) group.appendChild(this._makeUse(path.id));
      group.appendChild(this._makeUse(this.pinMarker.id));
      group.appendChild(this._makeUse(this.pinBorderLine.id));
      group.appendChild(this._makeUse(this.capitalMarker.id));
    }

    // `initialTransform` (the "keep zoom between rounds" setting) wins when
    // given; otherwise the first _reflow installs this map's own default
    // framing, which can't be computed until the viewport size is known.
    this._initialTransform = initialTransform ?? null;
    this._hasAppliedInitialTransform = false;
    this.currentTransform = initialTransform ?? zoomIdentity;
    this.zoomBehavior = zoom()
      // Real min/max set per-reflow below, once the actual fit scale is
      // known — this initial value is just a safe placeholder before the
      // constructor's own _reflow() call runs.
      .scaleExtent([1, 10])
      .on("zoom", (event) => {
        this.currentTransform = this._wrapTransform(event.transform);
        this._applyTransform(this.currentTransform);
        this.pinMarker.setAttribute("r", String(PIN_RADIUS_PX / this.currentTransform.k));
        // Same counter-scaling as the pin marker itself, and for the same
        // reason: this circle lives in the same zoomed/panned `<g>` as
        // every country path, so without this its radius would grow/shrink
        // with the map instead of staying a constant on-screen size.
        this.capitalMarker.setAttribute("r", String(PIN_RADIUS_PX / this.currentTransform.k));
        // Same idea for every tiny/archipelago country's assist hit-area:
        // its padding (HULL_PADDING) lives in the same pre-zoom coordinate
        // space as the rest of the map, so without this it would balloon
        // proportionally with zoom — a 3px assist margin at the default
        // view becomes a comically oversized blob dwarfing the country's
        // own real border once zoomed in far enough (reported directly:
        // "the borders of any selected country are strange... some are
        // oddly missing" — the real border wasn't missing, it was being
        // visually swallowed by its own hit-area). Reapplies padding to the
        // *cached unpadded* hull (`_hullBaseById`, set once in _reflow) —
        // cheap enough to do on every tick, unlike re-running the Delaunay
        // hull itself.
        if (this._hullBaseById.size > 0) {
          const k = this.currentTransform.k;
          for (const [id, base] of this._hullBaseById) {
            const hitArea = this.hitAreasById.get(id);
            if (!hitArea) continue;
            const padded = this._padHull(base.points, base.cx, base.cy, HULL_PADDING / k);
            hitArea.setAttribute("points", padded.map(([x, y]) => `${x},${y}`).join(" "));
          }
        }
      });
    this._selection = select(this.svg);
    this._selection.call(this.zoomBehavior);
    // Double-click-to-zoom is d3-zoom's default, but it fights with
    // clicking a country to select/confirm it (a quick double click reads
    // as both two "click"s and one "dblclick"), so it's off; wheel, touch
    // pinch, and drag zoom are untouched.
    this._selection.on("dblclick.zoom", null);

    if (this.pinMode) {
      // One click target for the whole map, rather than per-feature
      // listeners — a pin can land anywhere, not just on a discrete
      // country shape. Three steps, each using the simplest, most
      // broadly-reliable API for that one job, rather than one call doing
      // it all at once:
      //  1. `getBoundingClientRect()` gives the click's position relative
      //     to the SVG's own top-left corner, in CSS px. `_reflow` always
      //     sets `viewBox="0 0 clientWidth clientHeight"` to match the
      //     SVG's own rendered size exactly (`.world-map` is `width/
      //     height: 100%` of the same container `clientWidth`/
      //     `clientHeight` come from), so viewBox scaling is always 1:1
      //     here — CSS px *is* SVG user-space px, no further conversion
      //     needed for that part.
      //  2. `this.currentTransform.invert(...)` (d3-zoom's own tool for
      //     exactly this) separately undoes the *home* copy's current
      //     zoom/pan on top of that, landing back in the same
      //     untransformed pixel space `this.projection` was fit to.
      //  3. If wrapping is on, that (x, y) is only correct as-is when the
      //     click actually landed on the home copy — one that visually
      //     landed on a ghost (see the constructor) needs its x folded
      //     back into the home copy's own [_homeLeft, _homeLeft +
      //     _wrapPeriod) range first, since ghost content is a repeat of
      //     the exact same geography one or more world-widths over.
      //     Skipped whenever a click *did* land on the home copy — the
      //     modulo is a no-op there — so this doesn't change anything for
      //     the (far more common, and the only possible before this
      //     feature existed) non-wrapped case.
      this.svg.addEventListener("click", (event) => {
        if (!this.clickEnabled) return;
        const rect = this.svg.getBoundingClientRect();
        const sx = event.clientX - rect.left;
        const sy = event.clientY - rect.top;
        let [x, y] = this.currentTransform.invert([sx, sy]);
        if (this.wrapEnabled && this._wrapPeriod) {
          const left = this._homeLeft ?? 0;
          x = (((x - left) % this._wrapPeriod) + this._wrapPeriod) % this._wrapPeriod + left;
        }

        // Re-clicking the pin that's already down confirms, instead of
        // re-dropping it where it already is — the pin-mode equivalent of
        // map-click's re-click-to-confirm.
        //
        // Decided geometrically, right here, rather than by putting a
        // clickable circle over the pin and letting the browser hit-test
        // it. That was the original approach and it kept failing: the
        // element only existed on the home copy, and a map that wraps
        // (every region now) frequently displays the pin via a ghost copy
        // instead — Asia's own default framing does, with no panning at
        // all. Cloning the circle into each ghost didn't fix it either,
        // because ghost groups are `pointer-events: none` wholesale. Since
        // `x, y` above is already folded back into the home copy's own
        // coordinate space, one distance check covers the home copy and
        // every ghost at once, with no dependence on `<use>` hit-testing
        // semantics.
        if (this.pinLonLat && this._onPinConfirm) {
          const pinPoint = this.projection(this.pinLonLat);
          if (pinPoint) {
            // Compare in *screen* px so the tolerance means the same thing
            // at every zoom level, matching how the pin marker itself is
            // drawn at a constant on-screen size.
            const screenDist = Math.hypot(x - pinPoint[0], y - pinPoint[1]) * this.currentTransform.k;
            if (screenDist <= PIN_RADIUS_PX + PIN_CONFIRM_PADDING_PX) {
              this._onPinConfirm();
              return;
            }
          }
        }

        const lonlat = this.projection.invert?.([x, y]);
        if (!lonlat || !Number.isFinite(lonlat[0]) || !Number.isFinite(lonlat[1])) return;
        this._dropPinAt(lonlat[0], lonlat[1]);
        if (this.onClick) this.onClick(lonlat[0], lonlat[1], this._findContainingId(lonlat[0], lonlat[1]));
      });
    }

    // ResizeObserver fires once asynchronously right after observe(), even
    // when nothing has actually changed size yet — if that spurious first
    // callback reset zoom, it would silently undo the initialTransform we
    // were just constructed with a moment ago. Only reset on a size that
    // actually differs from the last one we laid out for.
    this._lastSize = null;
    this._resizeObserver = new ResizeObserver(() => this._reflow());
    this._resizeObserver.observe(container);
    // Initial layout keeps whatever transform we were constructed with
    // (identity by default) instead of forcibly resetting it.
    this._reflow({ resetZoom: false });
  }

  _makeUse(targetId) {
    const use = document.createElementNS(SVG_NS, "use");
    // Both attribute forms: plain `href` is all modern evergreen browsers
    // need (SVG2), `xlink:href` is the older fallback some engines still
    // required — setting both costs nothing and avoids relying on exactly
    // which one this app's target browsers want.
    use.setAttributeNS(null, "href", `#${targetId}`);
    use.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", `#${targetId}`);
    return use;
  }

  _reflow({ resetZoom } = {}) {
    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 500;
    if (width === 0 || height === 0) return;
    const sizeChanged = this._lastSize && (this._lastSize.width !== width || this._lastSize.height !== height);
    if (resetZoom === undefined) resetZoom = Boolean(sizeChanged);
    this._lastSize = { width, height };

    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    // One projection for every region: always the whole dataset fitted to
    // the viewport, so k=1 means the same thing in every game and the
    // region only decides the starting transform (_defaultTransform).
    this.projection.fitSize([width, height], this.geojson);
    const fullBounds = this.pathGen.bounds(this.geojson);

    if (this.wrapEnabled) {
      const b = fullBounds;
      if (Number.isFinite(b[0][0]) && Number.isFinite(b[1][0])) {
        this._homeLeft = b[0][0];
        this._wrapPeriod = b[1][0] - b[0][0];
      }
    }

    // Pin mode's merged landmass — recomputed every reflow (a resize
    // changes the projection, so the merged shape's own projected `d`
    // needs to track it exactly like every individual country path's own
    // `d` does; the underlying arc-level merge() result itself doesn't
    // depend on projection, but re-running it here is cheap enough not to
    // bother caching separately).
    if (this.pinMode && this._rawGeometries) {
      // Two merged layers, because pin mode has no per-country paths to
      // carry the usual playable/unplayable distinction: the whole world,
      // muted, underneath; the currently-playable subset, in the normal
      // land color, on top. Drawing the muted layer as *everything* rather
      // than as only the non-playable remainder is deliberate — the two
      // layers then overlap along the region boundary instead of merely
      // abutting, so no sub-pixel gap between them can ever let the ocean
      // color show through as a seam (the failure mode that plagued the
      // per-country rendering this replaced). In a World game the top
      // layer simply covers the bottom one entirely.
      const mergedAll = merge(this.topology, this._rawGeometries);
      this.pinLandmass.setAttribute("d", this.pathGen(this._withoutMergeSlivers(mergedAll, width, height)));

      // Terrain (a feature with no id at all — Siachen Glacier, Indian
      // Ocean Ter.) counts as normal land here, *not* as something the
      // muted base should show through. It isn't a country, so it's
      // neither "in play" nor "excluded from play" — it's just ground, and
      // painting it muted between fully-playable neighbours is what made a
      // stray grey triangle appear at the India/Pakistan/China trijunction.
      const playableGeometries = this._rawGeometries.filter((g, i) => {
        const f = this.geojson.features[i];
        if (!f) return false;
        return !f.id || this._playableIds.has(f.id);
      });
      const mergedPlayable = playableGeometries.length ? merge(this.topology, playableGeometries) : null;
      this.pinPlayableLandmass.setAttribute(
        "d",
        mergedPlayable ? this.pathGen(this._withoutMergeSlivers(mergedPlayable, width, height)) ?? "" : ""
      );

      // The revealed target (if one is showing) has to track the fresh
      // projection too, exactly like every per-country path's own `d` does
      // outside pin mode.
      if (this._revealedFeatureId) {
        const f = this._geometryById.get(this._revealedFeatureId);
        if (f) this.revealPath.setAttribute("d", this.pathGen(f) ?? "");
      }
    }

    // The reference area both hit-region thresholds are measured against
    // — see the comment above AREA_RATIO_SINGLE/LARGEST_PART_TIER1_RATIO/LARGEST_PART_TIER2_RATIO for
    // why this needs to scale with the map's own viewport/feature-count,
    // not be a fixed px² value shared by every dataset this class renders.
    //
    // Counts every *rendered* feature, not just the playable ones. Back
    // when each region re-fit the projection to its own members, playable
    // count and rendered count were the same thing. Now that every region
    // shares one whole-dataset projection, using the playable count would
    // measure a 54-country Europe against the same viewport the full ~240
    // countries are drawn into, inflating the "typical country" reference
    // ~4x and flagging ordinary countries as needing a tiny-country assist.
    // The rendered count keeps this pinned to the geometry actually on
    // screen — which is also exactly what the ratio constants were
    // originally calibrated against.
    const featureCount = this.geojson.features.length;
    const evenSplitArea = featureCount > 0 ? (width * height) / featureCount : Infinity;

    // Pass 1: lay out every path (home copy — ghost copies are <use>
    // references and update automatically). For every playable feature,
    // also note its bbox center as a Voronoi site (used below to bound
    // assist hit-regions against every real neighbor, not just other
    // assisted countries), and flag it as "qualifying" for an assist
    // hit-region if it's a compact single-blob microstate or has multiple
    // separate parts (an archipelago) — see the threshold constants above.
    const sites = []; // { id, cx, cy }
    const qualifying = []; // { id, f, cx, cy }
    const processedHitAreaIds = new Set(); // guards against a topology quirk — see below
    this.geojson.features.forEach((f, index) => {
      const path = this._pathsByIndex[index];
      if (path) path.setAttribute("d", this.pathGen(f));

      const hitArea = this.hitAreasById.get(f.id);
      if (!hitArea) return;

      // A handful of ids in the actual topology data are shared by two
      // *different* features — Ashmore and Cartier Is. carries Australia's
      // own id ("036") rather than one of its own, most likely because the
      // upstream topology never assigned the uninhabited territory a
      // separate code. `hitAreasById` (like `featuresById`) has one entry
      // per id, so without this guard, whichever of the two features this
      // forEach visits *last* would silently overwrite the first one's
      // qualification/hull with its own — in practice, Ashmore and
      // Cartier's own tiny single-part shape (which trivially qualifies as
      // "tiny") clobbering mainland Australia's correct, and correctly
      // non-qualifying, one. Since both features already carry the same
      // id and get their own click listener pointed at it (see the
      // constructor), skipping every occurrence but the first here costs
      // nothing — a click anywhere on either shape still resolves
      // correctly — it just stops a later, unrelated shape from deciding
      // what the *first* one's hit-region looks like.
      if (processedHitAreaIds.has(f.id)) return;
      processedHitAreaIds.add(f.id);

      hitArea.removeAttribute("clip-path");
      hitArea.style.display = "none";

      const bounds = this.pathGen.bounds(f);
      const bw = bounds[1][0] - bounds[0][0];
      const bh = bounds[1][1] - bounds[0][1];
      const bboxMax = Math.max(bw, bh);
      if (!Number.isFinite(bboxMax)) return;
      const cx = (bounds[0][0] + bounds[1][0]) / 2;
      const cy = (bounds[0][1] + bounds[1][1]) / 2;
      sites.push({ id: f.id, cx, cy });

      if (bboxMax >= HULL_BBOX_CAP) return; // antimeridian-degenerate, or a real but far-flung exclave — skip
      const isMulti = f.geometry?.type === "MultiPolygon";
      const qualifies = isMulti
        ? (() => {
            const [largest, second] = this._largestPartAreas(f);
            if (largest < LARGEST_PART_TIER1_RATIO * evenSplitArea) return true;
            if (largest >= LARGEST_PART_TIER2_RATIO * evenSplitArea) return false;
            return second >= SECOND_PART_RATIO * largest;
          })()
        : (() => {
            const area = this.pathGen.area(f);
            return Number.isFinite(area) && area < AREA_RATIO_SINGLE * evenSplitArea;
          })();
      if (qualifies) qualifying.push({ id: f.id, f, cx, cy });
    });

    // Pass 2: build a padded convex hull for each qualifying country
    // (fills the gaps between an archipelago's islands; pads a compact
    // microstate's own outline out to a comfortably tappable size), then
    // clip it to its Voronoi cell — the region closer to that country's
    // center than to any other playable country's — so a hull large
    // enough to nominally reach a real neighbor (e.g. Brunei's two
    // enclaves, UK's Northern Ireland vs. Ireland) always gets cut back
    // at the boundary equidistant between the two, never actually
    // overlapping the neighbor's own territory.
    // Stale from a previous reflow at a different size — qualification
    // itself depends on the viewport (see AREA_RATIO_SINGLE etc.), so a
    // resize can change who's in this set.
    this._hullBaseById.clear();

    if (qualifying.length > 0 && sites.length > 0) {
      const delaunay = Delaunay.from(sites.map((s) => [s.cx, s.cy]));
      const voronoi = delaunay.voronoi([0, 0, width, height]);
      const siteIndexById = new Map(sites.map((s, i) => [s.id, i]));

      for (const q of qualifying) {
        const rawHull = this._computeHull(q.f);
        if (!rawHull) continue;
        this._hullBaseById.set(q.id, { points: rawHull, cx: q.cx, cy: q.cy });

        const hitArea = this.hitAreasById.get(q.id);
        const clip = this.hitClipsById.get(q.id);
        // Padded using whatever zoom level is current — usually about to
        // be immediately corrected by the "zoom" handler below, which
        // _reflow's own final transform-setting call triggers; set here
        // too so the shape is still reasonable in the one edge case where
        // that dispatch doesn't fire (e.g. an already-identity transform
        // that d3-zoom treats as a no-op).
        const k = this.currentTransform?.k || 1;
        const padded = this._padHull(rawHull, q.cx, q.cy, HULL_PADDING / k);
        hitArea.setAttribute("points", padded.map(([x, y]) => `${x},${y}`).join(" "));
        hitArea.style.display = "";

        const cell = voronoi.cellPolygon(siteIndexById.get(q.id));
        if (cell) {
          clip.polygon.setAttribute("points", cell.map(([x, y]) => `${x},${y}`).join(" "));
          hitArea.setAttribute("clip-path", `url(#${clip.clipId})`);
        }
      }
    }

    // Disputed-border lines: only relevant if both sides of the pair
    // actually survived the continent hard-crop (if any) this render —
    // e.g. neither Serbia nor Kosovo exist on an Oceania-only map.
    if (this.borderLines.length > 0) {
      const presentIds = new Set(this.geojson.features.map((f) => f.id).filter(Boolean));
      const topologyObject = this.topology.objects[this.objectKey];
      for (const { idA, idB, path } of this.borderLines) {
        if (!presentIds.has(idA) || !presentIds.has(idB)) {
          path.removeAttribute("d");
          continue;
        }
        const shared = mesh(
          this.topology,
          topologyObject,
          (a, b) => b != null && ((a.id === idA && b.id === idB) || (a.id === idB && b.id === idA))
        );
        path.setAttribute("d", this.pathGen(shared));
      }
    }

    // Re-project the dropped pin (if any) at this reflow's fresh fitSize —
    // its screen position has to track a resize exactly like every
    // country path's own `d` does.
    if (this.pinLonLat) {
      const p = this.projection(this.pinLonLat);
      if (p) {
        this.pinMarker.setAttribute("cx", p[0]);
        this.pinMarker.setAttribute("cy", p[1]);
      }
    }
    // Same idea for the revealed pin-to-border line, if one's currently
    // shown — both its endpoints are lon/lat pairs, re-projected together.
    if (this._revealedBorderTarget) {
      const { pinLonLat, point } = this._revealedBorderTarget;
      const p1 = this.projection(pinLonLat);
      const p2 = this.projection(point);
      if (p1 && p2) {
        this.pinBorderLine.setAttribute("x1", p1[0]);
        this.pinBorderLine.setAttribute("y1", p1[1]);
        this.pinBorderLine.setAttribute("x2", p2[0]);
        this.pinBorderLine.setAttribute("y2", p2[1]);
      }
    }
    // Same idea for the revealed capital marker, if one's currently shown.
    if (this._revealedCapitalPoint) {
      const p = this.projection(this._revealedCapitalPoint);
      if (p) {
        this.capitalMarker.setAttribute("cx", p[0]);
        this.capitalMarker.setAttribute("cy", p[1]);
      }
    }

    // The projection now always fits the whole dataset to the viewport, so
    // the content box *is* the viewport box — no widening needed.
    this.zoomBehavior
      .scaleExtent([MIN_ZOOM, MAX_ZOOM])
      .extent([[0, 0], [width, height]])
      .translateExtent(
        this.wrapEnabled ? [[-Infinity, 0], [Infinity, height]] : [[0, 0], [width, height]]
      );
    // A genuine resize resets to this map's own default framing (its
    // region) — not to raw identity, which is the whole world and only the
    // right default for a World game, and not to `initialTransform`
    // either, since a carried-over zoom is a starting point, not something
    // to snap back to later.
    let target;
    if (!this._hasAppliedInitialTransform) {
      target = this._initialTransform ?? this._defaultTransform(width, height);
      this._hasAppliedInitialTransform = true;
    } else {
      target = resetZoom ? this._defaultTransform(width, height) : this.currentTransform;
    }
    this._selection.call(this.zoomBehavior.transform, target);
  }

  // Where a fresh map starts: a zoom/pan transform framing `focusIds`
  // (the chosen region) within the region-independent projection, rather
  // than a differently-fitted projection. Falls back to identity — the
  // whole world — when nothing specific is focused, and clamps into
  // [MIN_ZOOM, MAX_ZOOM] so a very small region can't demand a zoom level
  // the behavior itself would refuse.
  _defaultTransform(width, height) {
    if (!this._focusIds || this._focusIds.size === 0) return zoomIdentity;
    const focusFeatures = this.geojson.features.filter((f) => f.id && this._focusIds.has(f.id));
    if (focusFeatures.length === 0) return zoomIdentity;
    const b = this.pathGen.bounds({ type: "FeatureCollection", features: focusFeatures });
    const bw = b[1][0] - b[0][0];
    const bh = b[1][1] - b[0][1];
    if (!Number.isFinite(bw) || !Number.isFinite(bh) || bw <= 0 || bh <= 0) return zoomIdentity;
    const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(width / bw, height / bh)));
    const cx = (b[0][0] + b[1][0]) / 2;
    const cy = (b[0][1] + b[1][1]) / 2;
    return zoomIdentity.translate(width / 2 - k * cx, height / 2 - k * cy).scale(k);
  }

  // If wrapping is on and the home copy has drifted more than
  // WRAP_WINDOW of one world-width off-register, shifts the transform by
  // exactly one world-width (in the direction that reduces the drift) so
  // it snaps back within the window. A world-width's worth of horizontal
  // shift is invisible on screen — the ghost copies (exact <use> clones,
  // one world-width to either side) already occupy exactly the positions
  // the shift moves *to*, so nothing visibly jumps. Never touches
  // d3-zoom's own internally-tracked transform (only `translateExtent`
  // does that, and it's unbounded on x here — see _reflow) — this just
  // decides what to *render*, each tick, independent of that internal
  // bookkeeping, which sidesteps any feedback-loop risk from calling
  // zoomBehavior.transform() from inside its own "zoom" handler.
  _wrapTransform(t) {
    if (!this.wrapEnabled || !this._wrapPeriod) return t;
    const periodPx = this._wrapPeriod * t.k;
    if (!Number.isFinite(periodPx) || periodPx <= 0) return t;
    const windowPx = periodPx * WRAP_WINDOW;
    const homeLeft = this._homeLeft ?? 0;
    let tx = t.x;
    let screenLeft = homeLeft * t.k + tx;
    let guard = 0;
    while (screenLeft > windowPx && guard++ < 1000) {
      tx -= periodPx;
      screenLeft -= periodPx;
    }
    while (screenLeft < -windowPx && guard++ < 1000) {
      tx += periodPx;
      screenLeft += periodPx;
    }
    return tx === t.x ? t : zoomIdentity.translate(tx, t.y).scale(t.k);
  }

  // Renders a (possibly wrapped) transform: the home copy gets it as-is,
  // each ghost copy gets the same transform shifted by its own ±1 world-
  // width offset (in *screen* px, i.e. already multiplied by the current
  // scale — see the comment on _wrapTransform for why a whole-world shift
  // reads as visually seamless).
  _applyTransform(t) {
    for (const [offset, group] of this.copyGroups) {
      if (offset === 0) {
        group.setAttribute("transform", String(t));
      } else {
        const shift = this._wrapPeriod * t.k * offset;
        group.setAttribute("transform", `translate(${t.x + shift},${t.y}) scale(${t.k})`);
      }
    }
  }

  // Places (or moves) the pin marker at a given lon/lat and remembers it
  // so later reflows (resize, zoom reset) keep it correctly positioned.
  _dropPinAt(lon, lat) {
    this.pinLonLat = [lon, lat];
    const p = this.projection(this.pinLonLat);
    if (!p) return;
    this.pinMarker.setAttribute("cx", p[0]);
    this.pinMarker.setAttribute("cy", p[1]);
    this.pinMarker.style.display = "";
  }

  // Which playable feature's shape (if any) a lon/lat point falls inside —
  // pin mode's equivalent of a normal click landing on a specific country
  // path. Ray-casting directly on the raw (unprojected) ring coordinates,
  // so it works the same regardless of projection/zoom and needs no SVG
  // geometry APIs.
  _findContainingId(lon, lat) {
    for (const f of this.geojson.features) {
      if (!f.id || !this._playableIds.has(f.id)) continue; // unplayable — never a valid guess
      if (pointInFeature(lon, lat, f)) return f.id;
    }
    return null;
  }

  // Draws pinBorderLine from the last-dropped pin to `point` ([lon, lat])
  // and remembers it for re-projection on later reflows — shared by
  // revealBorderDistance and revealCapitalDistance below, which differ only
  // in *which* point they resolve and how they measure the distance to it.
  _revealLineTo(point) {
    this._revealedBorderTarget = { pinLonLat: this.pinLonLat, point };
    const p1 = this.projection(this.pinLonLat);
    const p2 = this.projection(point);
    if (p1 && p2) {
      this.pinBorderLine.setAttribute("x1", p1[0]);
      this.pinBorderLine.setAttribute("y1", p1[1]);
      this.pinBorderLine.setAttribute("x2", p2[0]);
      this.pinBorderLine.setAttribute("y2", p2[1]);
      this.pinBorderLine.style.display = "";
    }
  }

  // Post-confirm reveal for pin-drop mode's "Region" target: draws a line
  // from the last-dropped pin to the nearest point on feature `id`'s own
  // border (and returns the distance to it, in km) — 0, with no line drawn,
  // if the pin already landed inside it (a correct guess is always this
  // case, but nothing here assumes that; it's just what "nearest point on
  // the border" means for a point already past it). Measuring against the
  // country's actual shape rather than its centroid matters for large or
  // oddly-shaped countries, where a pin dropped well inside the border
  // would otherwise read as "hundreds of km away" despite being a correct
  // guess.
  revealBorderDistance(id) {
    if (!this.pinLonLat) return null;
    const f = this._geometryById.get(id);
    if (!f) return null;
    if (pointInFeature(this.pinLonLat[0], this.pinLonLat[1], f)) {
      this.pinBorderLine.style.display = "none";
      this._revealedBorderTarget = null;
      return 0;
    }
    const nearest = featureNearestBorderPoint(this.pinLonLat[0], this.pinLonLat[1], f);
    if (!nearest) return null;
    this._revealLineTo(nearest.point);
    return nearest.distanceKm;
  }

  // Post-confirm reveal for pin-drop mode's "Capital" target: draws a line
  // from the last-dropped pin straight to the capital's own exact point
  // (`capitalLatLng`, the app's own `[lat, lon]` field order — converted to
  // this module's `[lon, lat]` convention here, at the one boundary where
  // it matters) and a small marker there, since — unlike the border case —
  // there's no country outline reveal that already shows where it is.
  // Real great-circle distance (`haversineKm`), not the border case's
  // local-plane approximation: a capital can be genuinely far from the
  // pin (opposite side of a large country), where that approximation's
  // flat-earth assumption would start introducing real error. Returns
  // `null` if the dataset has no capital coordinates for this item.
  revealCapitalDistance(capitalLatLng) {
    if (!this.pinLonLat || !capitalLatLng) return null;
    const point = [capitalLatLng[1], capitalLatLng[0]];
    this._revealedCapitalPoint = point;
    const p = this.projection(point);
    if (p) {
      this.capitalMarker.setAttribute("cx", p[0]);
      this.capitalMarker.setAttribute("cy", p[1]);
      this.capitalMarker.style.display = "";
    }
    this._revealLineTo(point);
    return haversineKm(this.pinLonLat, point);
  }

  // Drops `topojson.merge()`'s degenerate hairline artifacts from a merged
  // MultiPolygon — see the MERGE_SLIVER_* constants above for what
  // identifies one and why it takes both thresholds rather than either
  // alone. Measured in projected px at the current fit (not in lon/lat),
  // since "is this a visible hairline on screen" is exactly the question,
  // and the answer depends on the projection/viewport this reflow just
  // established. Only whole polygons whose *outer* ring is degenerate are
  // dropped: both real artifacts are single-ring polygons with no holes,
  // so nothing real is ever cut out of a legitimate shape this way.
  _withoutMergeSlivers(merged, width, height) {
    if (merged?.type !== "MultiPolygon") return merged;
    const minSpan = Math.max(width, height) * MERGE_SLIVER_MIN_SPAN_FRACTION;
    const kept = merged.coordinates.filter((polygon) => {
      const outer = polygon[0];
      if (!outer) return false;
      const bounds = this.pathGen.bounds({ type: "Polygon", coordinates: [outer] });
      const w = bounds[1][0] - bounds[0][0];
      const h = bounds[1][1] - bounds[0][1];
      if (!Number.isFinite(w) || !Number.isFinite(h)) return true;
      const thickness = Math.min(w, h);
      const span = Math.max(w, h);
      // A zero-thickness ring is degenerate by definition (Infinity aspect),
      // which this comparison already handles without a special case.
      const isDegenerate = span / thickness > MERGE_SLIVER_MIN_ASPECT;
      return !(isDegenerate && span > minSpan);
    });
    return kept.length === merged.coordinates.length ? merged : { type: "MultiPolygon", coordinates: kept };
  }

  // The projected area (px², at the map's current fitSize scale) of a
  // MultiPolygon feature's biggest and second-biggest parts — see
  // LARGEST_PART_TIER1_RATIO/TIER2_RATIO/SECOND_PART_RATIO above.
  _largestPartAreas(f) {
    let largest = 0;
    let second = 0;
    for (const coords of f.geometry.coordinates) {
      const area = this.pathGen.area({ type: "Polygon", coordinates: coords });
      if (!Number.isFinite(area)) continue;
      if (area > largest) {
        second = largest;
        largest = area;
      } else if (area > second) {
        second = area;
      }
    }
    return [largest, second];
  }

  // Projects every ring point of a feature (all parts, at the map's
  // current fitSize scale) and takes their convex hull — *not* yet padded,
  // see _padHull below for why that's a separate step. For a multi-part
  // feature this hull naturally spans and fills the space between parts
  // (an archipelago's inter-island water); for a single compact blob it's
  // close to the country's own outline before padding widens it slightly.
  _computeHull(f) {
    const geometry = f.geometry;
    if (!geometry) return null;
    const polygons = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];

    const points = [];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (const lonlat of ring) {
          const p = this.projection(lonlat);
          if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) points.push(p);
        }
      }
    }
    if (points.length < 3) return null;

    const delaunay = Delaunay.from(points);
    const hullPoints = Array.from(delaunay.hull, (i) => points[i]);
    return hullPoints.length < 3 ? null : hullPoints;
  }

  // Pushes each hull vertex outward from (cx, cy) by `padding` (projected
  // px, in the group's own pre-zoom coordinate space — the same space
  // `_computeHull`'s points are already in). Split out from hull
  // computation itself so the padding amount can be cheaply re-derived on
  // every zoom tick (see the "zoom" handler) without re-running the
  // Delaunay hull each time — a hull's *shape* doesn't need to change with
  // zoom, only how much assist margin is added around it.
  _padHull(hullPoints, cx, cy, padding) {
    return hullPoints.map(([x, y]) => {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-6) return [x, y];
      const scale = (dist + padding) / dist;
      return [cx + dx * scale, cy + dy * scale];
    });
  }

  getTransform() {
    return this.currentTransform;
  }

  // `onPinConfirm` (pin mode only — ignored otherwise) is called instead of
  // `onClick` when a click lands within the confirm radius of the pin
  // that's already down (see the whole-map click listener, where that
  // distance check lives) rather than elsewhere on the map — the pin-mode
  // equivalent of map-click/multiple-choice's "click the already-selected
  // thing again to confirm".
  setClickable(enabled, onClick, onPinConfirm) {
    this.clickEnabled = enabled;
    this.onClick = onClick ?? null;
    this._onPinConfirm = onPinConfirm ?? null;
    this.svg.classList.toggle("world-map--clickable", enabled);
  }

  highlight(id) {
    this.clearMarks();
    this._mark(id, "country--highlighted");
  }

  // Provisional pick (not yet confirmed) — distinct from highlight, which
  // marks the prompt's subject. Calling select() again swaps the mark.
  select(id) {
    this._forEachMarked((el) => el.classList.remove("country--selected"));
    this._mark(id, "country--selected");
  }

  markResult(guessId, correctId) {
    this._forEachMarked((el) => el.classList.remove("country--selected"));
    if (guessId && guessId !== correctId) this._mark(guessId, "country--wrong");
    this._mark(correctId, "country--correct");
  }

  clearMarks() {
    this._forEachMarked((el) =>
      el.classList.remove("country--highlighted", "country--selected", "country--correct", "country--wrong")
    );
    if (this.pinMode) {
      // Also drop the geometry, not just the classes — an unclassed
      // revealPath would otherwise still paint via the base `.country`
      // rule until the next _mark replaced its `d`.
      this._revealedFeatureId = null;
      this.revealPath.removeAttribute("d");
    }
  }

  // Applies to both the real path (every copy — ghost copies are <use>
  // clones of the home path, so they pick up its classes automatically;
  // only the home copy's own hit-region additionally needs the class
  // added directly, since it's a separate element, not a clone) — for a
  // country small enough to need a hit-region, the real shape is often
  // too tiny to see any fill change on, so the hit-region is what
  // actually shows the player their selection/result.
  //
  // Pin mode has no per-country paths to mark at all (see the constructor),
  // so it instead draws the one feature being marked into the shared
  // `revealPath`. Only a single feature can be marked at a time there,
  // which is all pin mode ever asks for: `inputs.js` marks the target and
  // nothing else (`markResult(null, correctId)`).
  _mark(id, className) {
    if (this.pinMode) {
      const f = this._geometryById.get(id);
      if (!f) return;
      this._revealedFeatureId = id;
      this.revealPath.setAttribute("d", this.pathGen(f) ?? "");
      this.revealPath.classList.add(className);
      return;
    }
    const path = this.featuresById.get(id);
    if (path) path.classList.add(className);
    const hitArea = this.hitAreasById.get(id);
    if (hitArea) hitArea.classList.add(className);
  }

  _forEachMarked(fn) {
    if (this.pinMode) {
      fn(this.revealPath);
      return;
    }
    for (const path of this.featuresById.values()) fn(path);
    for (const hitArea of this.hitAreasById.values()) fn(hitArea);
  }

  destroy() {
    this._resizeObserver.disconnect();
    this._selection.on(".zoom", null);
    this.svg.remove();
  }
}
