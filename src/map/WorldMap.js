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
// 8, up from the original 3: 3px was calibrated against a mouse cursor,
// and on a tablet a finger tap that misses a 16px-wide Kuwait by 5px into
// the gulf got nothing at all. Generous ocean-side padding is safe — the
// Voronoi cell clip still stops one hull from reaching into another
// assisted country's half, and _resolveIdAt's arbitration already hands
// taps that land on a real neighbor's soil back to that neighbor unless
// the owner is a genuinely tiny target.
const HULL_PADDING = 8;
// When a tap lands on one country's real land but inside another's assist
// hull (see _resolveIdAt), the hull owner wins only if the tap is within
// this many screen px of its own territory — generous enough to cover the
// hull padding plus a finger's imprecision on a subpixel microstate, small
// enough that a sprawling archipelago hull can't swallow clicks landing
// squarely on a neighbor's ground.
// 7 ≈ realistic tap slop. Larger values were tried and leaked at world
// zoom, where whole countries are fingertip-sized: with 10, a tap on
// mainland France could lose to Jersey's hull, and Guatemala to Belize's,
// because at k=1 "within 10px of the microstate" covers the entire
// neighborhood.
const ASSIST_WIN_PX = 7;
// ...and only while the owner is genuinely hard to hit: once its hull
// renders larger than this on screen (Denmark zoomed to a regional view),
// the country is a comfortable target in its own right and real land wins
// the arbitration outright — a tap on the German side of the Flensburg
// border should not go to a 100px-tall Denmark just because Denmark's
// gap-fill hull still overlaps the coast there. A still-small-on-screen
// Liechtenstein or Monaco keeps the win against their big neighbors.
const ASSIST_OWNER_MAX_PX = 48;
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
// already reachable. 50 cleared that with a little headroom; raised to 200
// on request so microstates (Vatican, Monaco, Caribbean islets) and tight
// borders can be zoomed into comfortably. Past ~100x the 50m topology's
// coastline detail starts to look angular — accepted, since the extra
// zoom is for precise tapping, not cartographic detail.
const MIN_ZOOM = 1;
const MAX_ZOOM = 200;
// How long after d3-zoom's "end" a gesture must stay quiet before the map
// treats it as settled (de-promotes the GPU layers so the render sharpens,
// re-pads the assist hulls — see _onGestureSettle). Longer than d3's own
// ~150ms wheel-idle window, so a multi-notch wheel zoom reads as one
// gesture instead of settling (and re-rasterizing) between notches.
const GESTURE_SETTLE_MS = 200;
// How far the svg's own rendered box extends beyond the wrapper's visible
// window on each side, as a fraction of that side's own width/height — see
// the "zoom" handler's frozen branch and _reflow's viewBox/sizing setup.
// Frozen zoom scales the whole svg element as a raster; scaling it DOWN
// (zooming out) shrinks that raster toward its own top-left corner, and
// without extra pre-rendered margin around the visible window, the area
// it stops covering has nothing real behind it — reported as looking
// "weird" even though the wrapper's matching ocean background means it's
// not literally a color mismatch, just an obviously shrinking picture
// rather than a map that keeps showing real geography as you zoom out.
// The margin is real map content (the same geometry that's always
// rendered, including ghost copies — nothing new is drawn for this, it's
// purely a matter of how much of the existing scene the svg's own
// viewBox/box size reveals), so overscanning it means a zoom-out gesture
// keeps showing genuine geography right up to the tolerance below, then
// degrades to plain (correctly-colored) ocean beyond it rather than
// anything jarring.
//
// Tolerance: with margin M = ratio × side, a zoom-out from k=b down to
// k=t (scale = t/b < 1) leaves the shrunk raster still covering the full
// window as long as scale ≥ 1 / (1 + 2×ratio) — i.e. RATIO 0.75 covers
// any single gesture that doesn't shrink k by more than 2.5×. Doubling
// the margin quadruples the rendered pixel count, so this is a real
// three-way trade (coverage vs. GPU raster size vs. paint cost of the
// wider Pass-1 layout at settle) — 0.75 was chosen as comfortably past
// any realistic single wheel/pinch burst without the raster ballooning.
const ZOOM_OVERSCAN_RATIO = 0.75;
// Frozen-zoom re-bake bounds (see the "zoom" handler): how far a single
// frozen gesture's CSS scale may drift from its gesture-start raster
// before the scene is repainted mid-gesture and the freeze restarts from
// the fresh pixels. The shrink bound sits comfortably inside the ~2.5×
// zoom-out the overscan margin above actually covers — past it the
// raster visibly dwindles toward a blank viewport; the grow bound caps
// how blurry a zoom-in may get between repaints.
const FROZEN_REBAKE_SHRINK = 0.5;
const FROZEN_REBAKE_GROW = 3;
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

// A lon/lat ring whose consecutive vertices jump more than 180° in
// longitude crosses the antimeridian (Russia's Chukotka, Fiji, ...).
// Tested naively, such an edge runs the long way round — from +180 back
// to -180 across the whole map — so the ring "contains" a horizontal band
// spanning every longitude at its latitudes: a point in northern Canada,
// Norway, Finland, Iceland or Greenland resolved to Russia, one in
// northern Australia to Fiji. Fix: unwrap the ring into one continuous
// longitude run (shifting each vertex by ±360° so every edge takes the
// short way), then test the point at lon, lon+360 and lon-360 — whichever
// copy lands in the unwrapped range. Cached per ring: containment runs on
// every hover frame over every feature, and topology rings are stable.
const unwrappedRings = new WeakMap();
function unwrapRing(ring) {
  let entry = unwrappedRings.get(ring);
  if (entry) return entry;
  let crosses = false;
  for (let i = 1; i < ring.length; i++) {
    if (Math.abs(ring[i][0] - ring[i - 1][0]) > 180) {
      crosses = true;
      break;
    }
  }
  if (!crosses) {
    entry = { ring, crosses: false };
  } else {
    const out = [ring[0]];
    let shift = 0;
    for (let i = 1; i < ring.length; i++) {
      const dx = ring[i][0] - ring[i - 1][0];
      if (dx > 180) shift -= 360;
      else if (dx < -180) shift += 360;
      out.push([ring[i][0] + shift, ring[i][1]]);
    }
    entry = { ring: out, crosses: true };
  }
  unwrappedRings.set(ring, entry);
  return entry;
}

function pointInLonLatRing(lon, lat, ring) {
  const { ring: r, crosses } = unwrapRing(ring);
  if (pointInRing(lon, lat, r)) return true;
  return crosses && (pointInRing(lon + 360, lat, r) || pointInRing(lon - 360, lat, r));
}

// `coordinates`: one Polygon's rings — the first is the outer boundary,
// any further rings are holes cut out of it.
function pointInPolygonCoords(lon, lat, coordinates) {
  if (!coordinates[0] || !pointInLonLatRing(lon, lat, coordinates[0])) return false;
  for (let i = 1; i < coordinates.length; i++) {
    if (pointInLonLatRing(lon, lat, coordinates[i])) return false; // inside a hole
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
  // Bring both segment endpoints onto the query point's own longitude
  // branch (±360° as needed) before flattening — the earth is round, and
  // the shortest path from a pin in Chile (lon ≈ -75) to Australia's
  // border (lon ≈ 145) crosses the Pacific/antimeridian, not the ~220°
  // of map interior a raw longitude difference measures. Normalizing each
  // endpoint independently can't tear a segment: both endpoints of any
  // real border segment are within a fraction of a degree of each other,
  // so they always round to the same branch. The returned nearest point
  // keeps the shifted longitude (possibly outside ±180) on purpose — the
  // caller projects it via _projectWithWrap, which turns that shift into
  // "draw toward the ghost copy", i.e. the line visibly takes the short
  // way across the seam.
  lon1 += 360 * Math.round((lon - lon1) / 360);
  lon2 += 360 * Math.round((lon - lon2) / 360);
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
  const point = localKmToLonLat(cx, cy, refLat);
  // The planar math above only *picks* the candidate point on the segment
  // — a job it's fine at, since a border segment's endpoints are at most a
  // few km apart, bounding any pick error by the segment's own length.
  // The distance itself is measured with a real great circle: the flat
  // approximation's error grows with range and was off by thousands of km
  // for cross-Pacific queries (a Chile pin vs. Australia's border read
  // ~15,300km planar vs. ~11,300km true), exactly the case the longitude
  // normalization above exists to serve.
  return { point, distanceKm: haversineKm([lon, lat], point) };
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
    // The currently-hovered id in map-click mode (see the "pointermove"
    // listener below), or null. Not used in pin mode at all — pin mode is
    // borderless with no per-country click targets to preview a hover
    // over.
    this._hoveredId = null;
    this._hoverRafId = null; // rAF handle for the pending (coalesced) hover recompute
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
    // The svg's parent wrapper exists for the frozen-zoom mechanism (see
    // the "zoom" handler): during a zoom gesture the svg element itself
    // gets a CSS transform, so (a) the zoom listeners must live on this
    // untransformed wrapper — d3's pointer math reads the listener
    // element's bounding rect, which must not move mid-gesture — and
    // (b) the wrapper clips (`overflow: hidden`) and paints the ocean
    // color, so the area a scaled-down svg no longer covers reads as
    // plain ocean rather than page background until the settle repaint.
    this.viewportEl = document.createElement("div");
    this.viewportEl.className = "world-viewport";
    this.viewportEl.style.touchAction = "none";
    // A CSS transform on the svg must scale from its top-left, matching
    // how the zoom delta below is derived. Set once; harmless when no
    // transform is applied.
    this.svg.style.transformOrigin = "0 0";
    this.viewportEl.appendChild(this.svg);
    container.appendChild(this.viewportEl);

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
    // All actual content lives in this inner, untransformed group; the
    // homeGroup wrapper above carries the zoom/pan transform. The split
    // exists so each ghost copy can be a SINGLE `<use>` of this group's id
    // (see the ghost loop below) — referencing homeGroup itself would
    // clone its transform attribute and double-apply it. One group-use per
    // ghost instead of ~250 per-element clones cuts the DOM roughly 3x,
    // which is what makes gesture-start layer rasterization (and every
    // frame's paint bookkeeping) cheap; it also removes the whole
    // "forgot to clone the new element into the ghosts" bug class — a
    // ghost now reflects the home content by construction, whatever gets
    // added to it later.
    this.contentGroup = document.createElementNS(SVG_NS, "g");
    this.contentGroup.id = `${this._instanceId}-content`;
    this.homeGroup.appendChild(this.contentGroup);

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
      this.contentGroup.appendChild(this.pinLandmass);
      this.contentGroup.appendChild(this.pinPlayableLandmass);
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
    // used by revealBorderDistance/revealCapitalDistance and pin mode's
    // revealPath, which need the actual ring coordinates, not anything
    // SVG/projection-dependent. A handful of topology ids are shared by
    // two different features (Ashmore and Cartier Is. carries Australia's
    // own "036" — same quirk _reflow's hit-area pass guards against), and
    // a naive Map keeps whichever came *last* — which made every
    // Australia reveal/distance measure against the tiny islet instead of
    // the mainland (a Chile pin read 14,521km "to Australia's border",
    // i.e. to Ashmore, vs. the true ~8,960km). Same-id features are merged
    // into one MultiPolygon here instead: both shapes genuinely ARE that
    // id's territory, so containment, nearest-border, and the reveal
    // outline should all cover the union.
    this._geometryById = new Map();
    for (const f of this.geojson.features) {
      if (!f.id) continue;
      const existing = this._geometryById.get(f.id);
      if (!existing) {
        this._geometryById.set(f.id, f);
        continue;
      }
      const polysOf = (g) => (g.type === "MultiPolygon" ? g.coordinates : [g.coordinates]);
      this._geometryById.set(f.id, {
        type: "Feature",
        id: f.id,
        geometry: { type: "MultiPolygon", coordinates: [...polysOf(existing.geometry), ...polysOf(f.geometry)] },
      });
    }

    this.borderGroup = document.createElementNS(SVG_NS, "g");
    this.borderGroup.setAttribute("class", "border-lines");
    this.contentGroup.appendChild(this.borderGroup);
    this.hitGroup = document.createElementNS(SVG_NS, "g");
    this.hitGroup.setAttribute("class", "hit-areas");
    this.contentGroup.appendChild(this.hitGroup);

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
    this.contentGroup.appendChild(this.pinMarker);

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
    this.contentGroup.appendChild(this.pinBorderLine);
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
    this.contentGroup.appendChild(this.capitalMarker);
    this._revealedCapitalPoint = null; // lon/lat — re-projected on every _reflow, see below

    // The two circles above stay the *source of truth* for marker state
    // (every code path sets their cx/cy/display, and _reflow re-projects
    // them) but are never painted themselves. What's painted is an HTML
    // dot per circle per world copy, in a layer over the svg, positioned
    // in screen px from the current transform (_syncMarkerDots). Why: the
    // svg circles live inside the zoomed content, so during a frozen zoom
    // gesture (the whole svg CSS-scaled as one raster) they scaled with
    // the map — the pin ballooned from 4px to 60+px mid-pinch and snapped
    // back at settle. Counter-scaling the circle's `r` every tick would
    // dirty the svg and force the full-scene repaint frozen zoom exists to
    // avoid; moving a few tiny HTML dots is a cheap compositor update, and
    // keeps them a constant size through every frame of every gesture.
    // `visibility` (a presentation attribute) rather than CSS, so the
    // ghost copies' <use> clones inherit it too.
    this.pinMarker.setAttribute("visibility", "hidden");
    this.capitalMarker.setAttribute("visibility", "hidden");
    this.markerLayer = document.createElement("div");
    this.markerLayer.className = "marker-layer";
    this._markerDots = [];
    for (const [circle, cls] of [[this.pinMarker, "marker-dot marker-dot--pin"], [this.capitalMarker, "marker-dot marker-dot--capital"]]) {
      const copies = [];
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement("div");
        dot.className = cls;
        dot.hidden = true;
        this.markerLayer.appendChild(dot);
        copies.push(dot);
      }
      this._markerDots.push({ circle, copies });
    }
    // Any change to a circle's position/visibility (pin drop, reveal,
    // reflow re-projection, clearMarks) re-syncs the dots — no need to
    // touch every call site that moves a marker.
    this.viewportEl.appendChild(this.markerLayer);
    this._markerObserver = new MutationObserver(() => this._syncMarkerDots());
    for (const { circle } of this._markerDots) {
      this._markerObserver.observe(circle, { attributes: true, attributeFilter: ["cx", "cy", "style"] });
    }

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
    if (this.pinMode) this.contentGroup.appendChild(this.revealPath);

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
        // A handful of ids are shared by two different features — Ashmore
        // and Cartier Is. carries Australia's own "036" (see _reflow's
        // hit-area pass, which guards the same collision for the same
        // reason). `featuresById`/`hitAreasById`/`hitClipsById` each hold
        // ONE entry per id — the canonical element `_mark`/`highlight`/
        // `select` apply a class to — so without a first-wins guard here,
        // whichever feature happens to iterate LAST silently wins the
        // lookup. Ashmore comes after Australia in this dataset, so every
        // highlight/select/correct/wrong mark for Australia was landing
        // on the tiny, un-styled islet instead of the mainland: the
        // mainland never got a fill or border change at all. The click
        // listener below stays unconditional regardless — clicking either
        // shape should still resolve to this id.
        const isFirstForId = !this.featuresById.has(f.id);
        if (isFirstForId) this.featuresById.set(f.id, path);

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
        hitArea.addEventListener("click", (event) => {
          if (!this.clickEnabled || !this.onClick) return;
          // Not unconditionally this hull's own id: the hull renders
          // above every country path, so it also intercepts clicks that
          // actually landed on a neighbor's real land inside its span —
          // defer to the shared point-resolution rule (see _resolveIdAt
          // for the full arbitration story).
          const [x, y] = this._screenToLocalXY(event.clientX, event.clientY);
          this.onClick(this._resolveIdAt(x, y) ?? f.id);
        });
        this.hitGroup.appendChild(hitArea);
        if (isFirstForId) this.hitAreasById.set(f.id, hitArea);

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
        if (isFirstForId) this.hitClipsById.set(f.id, { clipId, polygon });
      }

      this.contentGroup.insertBefore(path, this.borderGroup);
      this._pathsByIndex.push(path);
    }

    // Each ghost copy is exactly ONE element: a `<use>` of the entire
    // content group (see contentGroup above for why that's the referent
    // and what it buys). Ghosts are fully inert (`pointer-events: none`,
    // style.css) — clicks that land over ghost content fall through to the
    // <svg> itself and are resolved *geometrically* by the click listener
    // below, the same coordinate-folding approach pin mode has always
    // used. That replaced per-country ghost <use> clones with their own
    // listeners, which were the bulk of the DOM (~480 elements on the
    // world map) and of every gesture-start layer rasterization.
    for (const offset of this.copyOffsets) {
      if (offset === 0) continue;
      this.copyGroups.get(offset).appendChild(this._makeUse(this.contentGroup.id));
    }

    // `initialTransform` (the "keep zoom between rounds" setting) wins when
    // given; otherwise the first _reflow installs this map's own default
    // framing, which can't be computed until the viewport size is known.
    this._initialTransform = initialTransform ?? null;
    this._hasAppliedInitialTransform = false;
    this.currentTransform = initialTransform ?? zoomIdentity;
    // Perf bookkeeping for the "zoom" handler below: the k the counter-
    // scaled elements were last updated for (null = never, so the first
    // tick always runs) and the k the assist hulls were last re-padded at
    // (kept separately since hull re-padding tolerates a small k drift —
    // see the handler; must never be 0, it's used as a divisor-ish base).
    this._lastCounterScaleK = null;
    this._lastHullPadK = 1;
    this._settleTimer = null; // pending _onGestureSettle, if a gesture just ended
    this._gestureActive = false; // between d3-zoom's start and end events
    // Current overscan margin in px, per axis (see ZOOM_OVERSCAN_RATIO) —
    // recomputed every _reflow from that reflow's own width/height, and
    // read by the frozen-zoom CSS transform's correction term below. Safe
    // at 0 before the constructor's own first _reflow call: no real user
    // gesture can begin before that synchronous call has already run.
    this._overscanX = 0;
    this._overscanY = 0;
    // While non-null, the map is in "frozen zoom": the inner groups still
    // carry this transform, and the difference between it and the live
    // d3 transform is applied as a CSS transform on the svg element (a
    // plain compositor update, no SVG repaint) — see the "zoom" handler.
    this._frozenBase = null;
    this._suppressGestureHooks = false; // programmatic transform syncs must not re-trigger gesture bookkeeping
    this.zoomBehavior = zoom()
      // Real min/max set per-reflow below, once the actual fit scale is
      // known — this initial value is just a safe placeholder before the
      // constructor's own _reflow() call runs.
      .scaleExtent([1, 10])
      // d3-zoom's default clickDistance is 0: ANY pointer movement between
      // mousedown and mouseup counts as a drag, and d3 then swallows the
      // click that follows. Real hands (trackpads especially) nearly
      // always drift a pixel or two during a click, so clicks silently
      // did nothing — most visibly on tiny targets like Monaco, where the
      // hover cue (resolved separately, per pointermove) kept showing the
      // country under the cursor while the click itself vanished. A few
      // px of slop is still far below any deliberate pan. (Touch has its
      // own tapDistance, default 10px, which was already forgiving.)
      .clickDistance(6)
      .on("zoom", (event) => {
        const t = event.transform;
        // Frozen zoom: the moment a live gesture changes `k`, stop
        // touching the SVG entirely and express every further tick as a
        // CSS transform on the svg element instead. Rationale: browsers
        // (Chromium in particular) don't reliably compositor-promote
        // *inner* SVG groups, so per-tick attribute transforms repaint
        // the full ~240-path scene — that repaint was the zoom lag. The
        // svg element itself is an ordinary compositable box, so scaling
        // it is a pure compositor operation at any tick rate. The inner
        // groups keep the gesture-start transform (`_frozenBase`); the
        // CSS delta D is chosen so D ∘ base = t, meaning screen positions
        // match `currentTransform` exactly — clicks and math stay
        // consistent mid-gesture. The raster this scales only contains
        // what was on screen at gesture start, so a fast zoom-out shows
        // plain ocean beyond it until the settle repaint fills it in —
        // the standard slippy-map trade, and deliberate. Wrap-snapping is
        // also deferred while frozen (a snap moves content by a whole
        // world-width, which ghosts make invisible on the live path but
        // a frozen raster would show as a jump).
        //
        // Pure pans (k unchanged, and no freeze already in progress) stay
        // on the live path below: they repaint, which was measured as
        // acceptable, and in exchange never show edge gaps.
        //
        // EXCEPT in pin mode, where pans freeze too: the scene there is
        // one giant merged landmass path, so a live pan re-rasterizes the
        // whole world's coastline every tick — the browser can't cull an
        // off-screen *part* of a single path the way it culls whole
        // country paths on the bordered map. That repaint was measured
        // fine for the bordered map and visibly laggy for pin mode on
        // tablets. A frozen pan is a pure CSS translate of the raster —
        // no blur at all — and the translation re-bake bound below keeps
        // the raster's edge from ever scrolling into view.
        if (
          this._gestureActive &&
          (this._frozenBase !== null || t.k !== this.currentTransform.k || this.pinMode)
        ) {
          if (this._frozenBase === null) {
            this._frozenBase = this.currentTransform;
            this.viewportEl.classList.add("world-viewport--zooming");
          }
          this.currentTransform = t;
          const b = this._frozenBase;
          const scale = t.k / b.k;
          // The raster only contains what was on screen (plus the
          // overscan margin, budgeted for about a 2.5× zoom-out) at the
          // moment the freeze began. A long fast gesture blows through
          // that budget — scaled down far enough, the raster becomes a
          // postage stamp in an otherwise blank viewport ("the map
          // disappears"), and scaled up far enough it's all blur. So when
          // a single frozen gesture drifts past these bounds, bake and
          // immediately re-freeze from the freshly painted scene: one
          // full repaint per ~2× of zoom factor instead of one per tick,
          // and the viewport never empties out.
          // The same re-bake guard for translation: how far the frozen
          // raster's content has shifted on screen since the freeze
          // began. Past ~90% of the overscan margin, the raster's own
          // edge is about to scroll into the viewport as blank — repaint
          // and restart the freeze instead. (Mostly relevant for pin
          // mode's frozen pans; a zoom-centered gesture rarely
          // translates this far before a scale bound trips first.)
          const shiftX = Math.abs(t.x - scale * b.x);
          const shiftY = Math.abs(t.y - scale * b.y);
          if (
            scale < FROZEN_REBAKE_SHRINK ||
            scale > FROZEN_REBAKE_GROW ||
            shiftX > this._overscanX * 0.9 ||
            shiftY > this._overscanY * 0.9
          ) {
            this._bakeFrozenZoom();
            this._frozenBase = this.currentTransform;
            this.viewportEl.classList.add("world-viewport--zooming");
            return;
          }
          // The svg's own box is now bigger than the wrapper's window —
          // it's positioned at (-marginX, -marginY) so its *content* still
          // lines up with the wrapper exactly at rest (see _reflow) — so a
          // CSS transform pivoting on the box's own top-left (0 0, i.e.
          // viewBox coordinate -marginX/-marginY) needs a correction beyond
          // the plain `t.x - scale*b.x` used when the box exactly matched
          // the window: expanding the derivation of
          // `screen = boxPos + D(pixelInBox)` out to a target of
          // `screen = t.x + t.k*worldX` (see ZOOM_OVERSCAN_RATIO's comment
          // for the full algebra) gives an extra `-margin*(scale-1)` term
          // per axis. Exact at any scale, not an approximation — without
          // it the map would visibly drift by margin*(scale-1) px (many
          // hundreds of px at typical zoom factors), zoom-in included.
          const dx = t.x - scale * b.x - this._overscanX * (scale - 1);
          const dy = t.y - scale * b.y - this._overscanY * (scale - 1);
          this.svg.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
          this._syncMarkerDots();
          return;
        }

        this.currentTransform = this._wrapTransform(t);
        this._applyTransform(this.currentTransform);
        this._syncMarkerDots();

        // Everything below exists only to counter-scale against `k` — so
        // when `k` didn't change (a pure pan/drag, the most common gesture
        // by far), skip all of it. A pan tick is then just the transform
        // updates above, nothing else touching the DOM.
        const k = this.currentTransform.k;
        if (k === this._lastCounterScaleK) return;
        this._lastCounterScaleK = k;

        this.pinMarker.setAttribute("r", String(PIN_RADIUS_PX / k));
        // Same counter-scaling as the pin marker itself, and for the same
        // reason: this circle lives in the same zoomed/panned `<g>` as
        // every country path, so without this its radius would grow/shrink
        // with the map instead of staying a constant on-screen size.
        this.capitalMarker.setAttribute("r", String(PIN_RADIUS_PX / k));
        // The assist-hull re-padding (the expensive counter-scale, ~80
        // polygon `points` rebuilds) deliberately does NOT happen here —
        // it runs once per gesture, at settle time (_onGestureSettle),
        // never on a live zoom tick. Mid-gesture the hulls just carry the
        // previous gesture's padding: they're invisible hit-assists, a
        // few px of stale margin while the player is actively pinching is
        // unobservable, and nobody clicks a microstate mid-pinch.
      })
      // Gesture lifecycle: track whether a live gesture is in progress
      // (the frozen-zoom branch above only ever engages inside one) and
      // defer the expensive per-gesture work — baking the frozen
      // transform, hull re-padding — to a single settle callback. The
      // settle is debounced rather than run straight from "end" because a
      // wheel zoom is many short start/end gesture cycles in quick
      // succession (d3-zoom closes a wheel gesture after ~150ms idle) —
      // baking and re-freezing between every wheel notch would repaint
      // exactly as often as the un-optimized version did.
      .on("start.gesture", () => {
        if (this._suppressGestureHooks) return;
        clearTimeout(this._settleTimer);
        this._gestureActive = true;
      })
      .on("end.gesture", () => {
        if (this._suppressGestureHooks) return;
        this._gestureActive = false;
        clearTimeout(this._settleTimer);
        this._settleTimer = setTimeout(() => this._onGestureSettle(), GESTURE_SETTLE_MS);
      });
    // Zoom listeners on the WRAPPER (see viewportEl above), never the svg:
    // during frozen zoom the svg carries a CSS transform, and d3 derives
    // pointer coordinates from the listener element's own geometry — which
    // therefore must not move mid-gesture.
    this._selection = select(this.viewportEl);
    this._selection.call(this.zoomBehavior);
    // Double-click-to-zoom is d3-zoom's default, but it fights with
    // clicking a country to select/confirm it (a quick double click reads
    // as both two "click"s and one "dblclick"), so it's off; wheel, touch
    // pinch, and drag zoom are untouched.
    this._selection.on("dblclick.zoom", null);

    {
      // Whole-map click listener, installed in every mode. Pin mode uses
      // it for everything (a pin can land anywhere, not on a discrete
      // shape); map-click mode uses it only for clicks that fell through
      // to the <svg> itself — i.e. over a ghost copy or open ocean, since
      // home-copy paths/hit-areas have their own listeners and are hit
      // first — resolving the country geometrically, exactly like pin
      // mode's containment lookup. Coordinate handling is `_screenToLocalXY`
      // (below) — see it for the three-step breakdown.
      this.svg.addEventListener("click", (event) => {
        if (!this.clickEnabled) return;
        // In map-click mode, anything interactive on the home copy (a
        // playable country path, a hull hit-area) handles its own click —
        // skip exactly those. Everything else (ghost content, ocean,
        // terrain) is resolved geometrically here. This used to require
        // `event.target === this.svg`, which only matched Chromium: Firefox
        // reports a click on ghost content with the ghost's <use> element
        // as the target, so every ghost-copy click was silently dropped —
        // e.g. Monaco zoomed in on a Europe map (shown via a ghost past
        // ~40x) highlighted on hover but never selected. Pin mode's
        // content is all pointer-events: none, so every click arrives
        // here regardless.
        const t = event.target;
        if (!this.pinMode && (t?.classList?.contains("country-hitarea") || t?.dataset?.id)) return;
        const [x, y] = this._screenToLocalXY(event.clientX, event.clientY);

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
            // The x-difference is computed *modularly* under wrap, not
            // linearly: the fold above maps every click into
            // [_homeLeft, _homeLeft + _wrapPeriod), so a pin sitting near
            // one edge of that period (i.e. near the antimeridian) and a
            // click landing visually just across the seam would otherwise
            // measure almost a full world-width apart and re-drop instead
            // of confirming. Shortest-way-around is the actual on-screen
            // distance. A no-op whenever wrap is off or the pair is
            // nowhere near the seam.
            let dx = x - pinPoint[0];
            if (this.wrapEnabled && this._wrapPeriod) {
              const p = this._wrapPeriod;
              dx = ((dx % p) + p) % p;
              if (dx > p / 2) dx -= p;
            }
            // Compare in *screen* px so the tolerance means the same thing
            // at every zoom level, matching how the pin marker itself is
            // drawn at a constant on-screen size.
            const screenDist = Math.hypot(dx, y - pinPoint[1]) * this.currentTransform.k;
            if (screenDist <= PIN_RADIUS_PX + PIN_CONFIRM_PADDING_PX) {
              this._onPinConfirm();
              return;
            }
          }
        }

        const lonlat = this.projection.invert?.([x, y]);
        if (!lonlat || !Number.isFinite(lonlat[0]) || !Number.isFinite(lonlat[1])) return;
        if (this.pinMode) {
          this._dropPinAt(lonlat[0], lonlat[1]);
          if (this.onClick) this.onClick(lonlat[0], lonlat[1], this._findContainingId(lonlat[0], lonlat[1]));
        } else {
          // Ghost-country click (map-click mode): report the same id the
          // home path's own listeners would have — hull assists included
          // (see _resolveIdAt). Ocean/terrain resolves to null — not a
          // selection, so nothing fires.
          const id = this._resolveIdAt(x, y);
          if (id && this.onClick) this.onClick(id);
        }
      });
    }

    if (!this.pinMode) {
      // Hover cue for map-click mode — see _onPointerMoveForHover for why
      // this is a JS listener and not a `:hover` CSS rule. `pointerleave`
      // (fires once when the pointer leaves the wrapper entirely, unlike
      // `pointermove` which just stops) clears the cue instead of leaving
      // it stuck on whatever was last hovered.
      this.viewportEl.addEventListener("pointermove", (event) => this._onPointerMoveForHover(event));
      this.viewportEl.addEventListener("pointerleave", () => {
        if (this._hoverRafId !== null) {
          cancelAnimationFrame(this._hoverRafId);
          this._hoverRafId = null;
        }
        this._setHoveredId(null);
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
    // A resize mid-zoom-gesture: bake the frozen state first so the
    // layout below starts from real inner transforms, not a stale base
    // plus a CSS delta.
    this._bakeFrozenZoom();
    // A zero-size container (display:none, mid-teardown) has nothing to
    // lay out against — bail rather than fitting the projection to a
    // made-up size and caching it as _lastSize.
    if (!this.container.clientWidth || !this.container.clientHeight) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const sizeChanged = this._lastSize && (this._lastSize.width !== width || this._lastSize.height !== height);
    // Only a *genuine* resize (window resize, orientation change) resets
    // the zoom to the default framing. Two resize flavors must NOT: on
    // tablets/phones the browser chrome (URL bar, toolbars) retracts the
    // moment a pan/pinch starts, and the app's 100dvh root tracks that —
    // so the container's HEIGHT jitters mid-gesture through no intent of
    // the user's. Resetting on those made "zoom in, then pan" snap the
    // map back out. A height-only change is that chrome signature (every
    // real resize — window drag, rotation — moves width too); and any
    // resize arriving while a gesture is live is likewise jitter, since
    // the user can't be resizing the window mid-drag.
    if (resetZoom === undefined) {
      const widthChanged = this._lastSize && this._lastSize.width !== width;
      resetZoom = Boolean(sizeChanged) && widthChanged && !this._gestureActive;
    }
    this._lastSize = { width, height };

    // The svg's own rendered box is bigger than the wrapper's window by
    // the overscan margin on every side (see ZOOM_OVERSCAN_RATIO), and
    // positioned so that its content still lines up with the wrapper
    // exactly at rest: viewBox min-x/min-y = -margin, box width/height =
    // size + 2*margin, box position = -margin. A point at logical (0,0)
    // then renders at box-pixel (margin), which combined with the box's
    // own (-margin) position lands back at wrapper-relative screen (0,0) —
    // i.e. every existing calculation that treats the wrapper's window as
    // exactly [0,width]×[0,height] (fitSize below, click math, wrap
    // period, hit areas, ghost translate math) needs no changes at all;
    // only the frozen-zoom CSS transform's correction term (see the "zoom"
    // handler) depends on the margin, via `_overscanX`/`_overscanY` below.
    this._overscanX = width * ZOOM_OVERSCAN_RATIO;
    this._overscanY = height * ZOOM_OVERSCAN_RATIO;
    const boxWidth = width + 2 * this._overscanX;
    const boxHeight = height + 2 * this._overscanY;
    this.svg.setAttribute("viewBox", `${-this._overscanX} ${-this._overscanY} ${boxWidth} ${boxHeight}`);
    this.svg.style.left = `${-this._overscanX}px`;
    this.svg.style.top = `${-this._overscanY}px`;
    this.svg.style.width = `${boxWidth}px`;
    this.svg.style.height = `${boxHeight}px`;
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
        this._lastHullPadK = k; // fresh hulls are padded for this k — the zoom handler's drift check starts from here
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

    // Disputed-border lines. (The presence check below dates from when a
    // region was a hard crop that could remove one side of a pair; the
    // map now always renders the full dataset, so it only guards against
    // a configured id that doesn't exist in the topology at all.)
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
      const p2 = this._projectWithWrap(point);
      if (p1 && p2) {
        this.pinBorderLine.setAttribute("x1", p1[0]);
        this.pinBorderLine.setAttribute("y1", p1[1]);
        this.pinBorderLine.setAttribute("x2", p2[0]);
        this.pinBorderLine.setAttribute("y2", p2[1]);
      }
    }
    // Same idea for the revealed capital marker, if one's currently shown.
    if (this._revealedCapitalPoint) {
      const p = this._projectWithWrap(this._revealedCapitalPoint);
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
    // Programmatic, not a user gesture — without the suppression this
    // dispatch would run the start/end gesture hooks and, when the target
    // k differs from the current one (a resize reset, the constructor's
    // initial framing), enter frozen-zoom mode for a spurious 200ms of
    // CSS-scaled blur before the settle baked it.
    this._suppressGestureHooks = true;
    this._selection.call(this.zoomBehavior.transform, target);
    this._suppressGestureHooks = false;
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
    const viewWidth = this._lastSize?.width ?? 0;
    for (const [offset, group] of this.copyGroups) {
      if (offset === 0) {
        group.setAttribute("transform", String(t));
      } else {
        const shift = this._wrapPeriod * t.k * offset;
        // Cull a ghost whose entire world-width lies outside the viewport
        // — which is almost always, once zoomed in even slightly, since a
        // ghost sits a full world-width from the home copy. `visibility`
        // rather than `display` deliberately: it skips paint and hit-
        // testing without a layout/compositor-layer teardown, so toggling
        // it at the boundary while dragging stays cheap. At k=1 with the
        // seam on screen the ghosts overlap the viewport and stay visible,
        // exactly as before — this only ever hides paint the player
        // couldn't see anyway (measured as the dominant per-frame cost:
        // each visible ghost is a full second/third copy of ~240 paths for
        // the browser to consider every tick).
        const left = (this._homeLeft ?? 0) * t.k + t.x + shift;
        const right = left + this._wrapPeriod * t.k;
        const hidden = viewWidth > 0 && (right < 0 || left > viewWidth);
        const value = hidden ? "hidden" : "";
        if (group.style.visibility !== value) group.style.visibility = value;
        if (hidden) continue; // no need to keep updating a hidden ghost's transform
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

  // The geometric counterpart of the assist hit-areas, for clicks/hover
  // that are resolved by coordinates rather than by the browser's own
  // element hit-testing — i.e. anything landing on a GHOST copy (ghosts
  // are pointer-events: none wholesale, and carry no hull elements of
  // their own — the hulls are home-copy only). Without this, a microstate
  // displayed via a ghost (Singapore in Asia's own default framing, most
  // of Oceania near the antimeridian) silently had NO tap assist and no
  // hover cue: `_findContainingId` is exact point-in-polygon on the real
  // geometry, which for a ~1px island is an impossible target.
  //
  // (x, y) is base projected px, already wrap-folded into the home copy's
  // range by _screenToLocalXY — exactly the space the hit-area polygons'
  // own `points` live in, so this reads those live attributes (padded for
  // the current zoom by _reflow/_onGestureSettle, clipped to the Voronoi
  // cell) rather than recomputing any geometry: by construction it
  // resolves identically to the browser hit-testing the hull element on
  // the home copy. Hulls are clipped to disjoint Voronoi cells, so at
  // most one can match — first hit wins.
  _findAssistIdAt(x, y) {
    const parse = (s) => s.trim().split(/\s+/).map((p) => p.split(",").map(Number));
    for (const id of this._hullBaseById.keys()) {
      const hitArea = this.hitAreasById.get(id);
      if (!hitArea || hitArea.style.display === "none") continue;
      const pts = hitArea.getAttribute("points");
      if (!pts || !pointInRing(x, y, parse(pts))) continue;
      const cell = this.hitClipsById.get(id)?.polygon?.getAttribute("points");
      if (cell && !pointInRing(x, y, parse(cell))) continue;
      return id;
    }
    return null;
  }

  // Minimum distance, in *screen* px at the current zoom, from base
  // projected point (x, y) to any vertex of feature `f`'s outline. Only
  // used to arbitrate tap-assist conflicts (see _resolveIdAt), where the
  // candidates are microstates/archipelagos with short, densely-sampled
  // coastlines, so vertex distance is an accurate enough stand-in for
  // true edge distance. Early-exits as soon as `withinPx` is beaten.
  _screenDistToFeaturePx(x, y, f, withinPx) {
    const k = this.currentTransform?.k || 1;
    const limit = withinPx / k; // compare in base units
    let best = Infinity;
    const scanRing = (ring) => {
      for (const pt of ring) {
        const p = this.projection(pt);
        if (!p) continue;
        const d = Math.hypot(p[0] - x, p[1] - y);
        if (d < best) best = d;
        if (best <= limit) return true;
      }
      return false;
    };
    const geom = f.geometry;
    if (!geom) return Infinity;
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
    for (const poly of polys) {
      for (const ring of poly) if (scanRing(ring)) return best * k;
    }
    return best * k;
  }

  // One resolution rule for every coordinate-based click/hover path, and
  // the arbiter the hull elements' own click listeners defer to: given a
  // base projected point, which playable country is that tap *for*?
  //
  //  - Exact containment and the assist hull agree (or only one claims
  //    the point): easy, take it. A hull claim over open ocean is the
  //    assist doing its job (archipelago gap-fill, microstate padding).
  //  - Both claim it and disagree — the point sits on one country's real
  //    land but inside another's assist hull. Hulls render above every
  //    path and their Voronoi clip only bounds them at the midline
  //    between feature *centers*, never at real borders, so this overlap
  //    is common (Denmark's gap-fill hull reaches real German coast,
  //    Bahrain's padding touches Qatar). The hull owner wins only when
  //    the tap is effectively *on* its own territory — within
  //    ASSIST_WIN_PX on screen, covering the padding that makes a
  //    subpixel Monaco/Singapore tappable over their big neighbors'
  //    adjacent soil — and the real land wins everywhere else, so a
  //    sprawling hull can never swallow clicks landing squarely on a
  //    neighbor's own ground.
  _resolveIdAt(x, y) {
    const lonlat = this.projection.invert?.([x, y]);
    const containing =
      lonlat && Number.isFinite(lonlat[0]) && Number.isFinite(lonlat[1])
        ? this._findContainingId(lonlat[0], lonlat[1])
        : null;
    const assistId = this._findAssistIdAt(x, y);
    if (!assistId || assistId === containing) return containing ?? assistId;
    if (!containing) return assistId;
    // Size gate (see ASSIST_OWNER_MAX_PX): measured on the unpadded hull
    // base, the same geometry the on-screen hull is built from.
    const base = this._hullBaseById.get(assistId);
    if (base) {
      const k = this.currentTransform?.k || 1;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [px, py] of base.points) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      if (Math.max(maxX - minX, maxY - minY) * k > ASSIST_OWNER_MAX_PX) return containing;
    }
    const f = this._geometryById.get(assistId);
    if (f && this._screenDistToFeaturePx(x, y, f, ASSIST_WIN_PX) <= ASSIST_WIN_PX) return assistId;
    return containing;
  }

  // A screen-space (clientX, clientY) — straight from any mouse/pointer
  // event — into the *local* (pre-zoom, pre-wrap-fold) coordinate space
  // `this.projection` was fit to. Three steps, each the simplest,
  // broadest-reliability API for that one job:
  //  1. `getBoundingClientRect()` on the WRAPPER, not the svg: during
  //     frozen zoom the svg itself carries a CSS transform and its own
  //     client rect moves with it, while the wrapper stays put at the
  //     viewport box these calculations are defined against. `_reflow`
  //     always sets the svg's viewBox to exactly match clientWidth/
  //     clientHeight (plus the fixed overscan margin, symmetric on every
  //     side — see ZOOM_OVERSCAN_RATIO), so CSS px *is* SVG user-space
  //     px, no further conversion needed for that part.
  //  2. `this.currentTransform.invert(...)` (d3-zoom's own tool for
  //     exactly this) undoes the *home* copy's current zoom/pan, landing
  //     back in the untransformed pixel space `this.projection` was fit
  //     to.
  //  3. If wrapping is on, that (x, y) is only correct as-is when the
  //     point actually falls on the home copy — one that visually lands
  //     on a ghost (see the constructor) needs its x folded back into the
  //     home copy's own [_homeLeft, _homeLeft + _wrapPeriod) range first,
  //     since ghost content is a repeat of the exact same geography one
  //     or more world-widths over. A no-op wherever the point *did* land
  //     on the home copy, so this doesn't change anything for the (far
  //     more common, and the only possible before wrapping existed)
  //     non-wrapped case.
  _screenToLocalXY(clientX, clientY) {
    const rect = this.viewportEl.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    let [x, y] = this.currentTransform.invert([sx, sy]);
    if (this.wrapEnabled && this._wrapPeriod) {
      const left = this._homeLeft ?? 0;
      x = (((x - left) % this._wrapPeriod) + this._wrapPeriod) % this._wrapPeriod + left;
    }
    return [x, y];
  }

  // Map-click mode's hover cue. Deliberately NOT the obvious `:hover` CSS
  // pseudo-class (that's what this replaced) — reported to stop
  // registering past a certain zoom level, consistently, on every
  // country, reversible by zooming back out, while plain "click" events
  // on those same elements kept working throughout. Whatever the exact
  // cause, native `:hover` matching against a repeatedly-transformed SVG
  // path is the one thing that's different between the two, so this
  // sidesteps it entirely: the hovered id is computed geometrically, the
  // same way a ghost/ocean click already resolves (`_screenToLocalXY` +
  // `_findContainingId`), driven by our own `pointermove` listener on the
  // wrapper rather than the browser's continuous style-matching. A
  // side benefit over the old CSS: it now also lights up the *ghost*
  // copies of a country, not just the home copy, since every copy shares
  // the same underlying id.
  //
  // Coalesced to at most once per animation frame — a pointermove stream
  // can fire far more often than that, and every extra call would re-run
  // `_findContainingId`'s O(features) point-in-polygon scan for no
  // observable benefit between two calls that land in the same frame.
  _onPointerMoveForHover(event) {
    if (this._hoverRafId !== null) return; // already coalescing this frame
    const { clientX, clientY } = event;
    this._hoverRafId = requestAnimationFrame(() => {
      this._hoverRafId = null;
      if (!this.clickEnabled) {
        this._setHoveredId(null);
        return;
      }
      const [x, y] = this._screenToLocalXY(clientX, clientY);
      // The exact same resolution rule as every click path (_resolveIdAt),
      // so the hover cue lights up precisely the country a click at this
      // point would select — ghost copies and hull assists included.
      this._setHoveredId(this._resolveIdAt(x, y));
    });
  }

  _setHoveredId(id) {
    if (id === this._hoveredId) return;
    if (this._hoveredId !== null) {
      this.featuresById.get(this._hoveredId)?.classList.remove("country--hovered");
      this.hitAreasById.get(this._hoveredId)?.classList.remove("country--hovered");
    }
    this._hoveredId = id;
    if (id !== null) {
      this.featuresById.get(id)?.classList.add("country--hovered");
      this.hitAreasById.get(id)?.classList.add("country--hovered");
    }
  }

  // Projects a [lon, lat] whose longitude may deliberately sit outside
  // ±180° (a wrap-normalized point — see nearestPointOnSegmentKm and
  // revealCapitalDistance): the in-range part projects normally, and each
  // full ±360° of shift becomes ± one world-width in projected x — i.e.
  // the position of that same geography in the neighbouring ghost copy.
  // This is what lets a reveal line/marker visibly take the short way
  // across the antimeridian seam instead of spanning the whole map
  // interior. A plain projection for any in-range longitude.
  _projectWithWrap([lon, lat]) {
    const norm = ((lon + 180) % 360 + 360) % 360 - 180;
    const p = this.projection([norm, lat]);
    if (!p) return null;
    if (this.wrapEnabled && this._wrapPeriod) p[0] += ((lon - norm) / 360) * this._wrapPeriod;
    return p;
  }

  // Draws pinBorderLine from the last-dropped pin to `point` ([lon, lat])
  // and remembers it for re-projection on later reflows — shared by
  // revealBorderDistance and revealCapitalDistance below, which differ only
  // in *which* point they resolve and how they measure the distance to it.
  _revealLineTo(point) {
    this._revealedBorderTarget = { pinLonLat: this.pinLonLat, point };
    const p1 = this.projection(this.pinLonLat);
    const p2 = this._projectWithWrap(point);
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
  // Pure query, no drawing: km from (lon, lat) to feature `id`'s border —
  // 0 if inside it, null if unknown. Pin mode's Region scoring uses this
  // for its border tolerance (inputs.js) before anything is revealed.
  borderDistanceKm(id, lon, lat) {
    const f = this._geometryById.get(id);
    if (!f) return null;
    if (pointInFeature(lon, lat, f)) return 0;
    return featureNearestBorderPoint(lon, lat, f)?.distanceKm ?? null;
  }

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
    // Shift the capital's longitude onto the pin's branch (±360°) so the
    // reveal line and marker take the short way around — a pin in Chile
    // aiming at Canberra should draw across the Pacific seam (into the
    // ghost copy, via _projectWithWrap), not across the whole map
    // interior. The distance itself needs no such care: haversine is
    // periodic in longitude and always returns the short way.
    const pinLon = this.pinLonLat[0];
    const capLon = capitalLatLng[1] + 360 * Math.round((pinLon - capitalLatLng[1]) / 360);
    const point = [capLon, capitalLatLng[0]];
    this._revealedCapitalPoint = point;
    const p = this._projectWithWrap(point);
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

  // Runs once, shortly after a pan/zoom gesture ends (debounced — see the
  // "end.gesture" handler). Three jobs:
  //  1. Bake any frozen zoom (_bakeFrozenZoom): the one full vector
  //     repaint per gesture, which is also what makes the zoomed view
  //     sharp — the CSS-scaled gesture raster is inherently blurry.
  //  2. Restore the pin/capital markers' constant on-screen radii (they
  //     rode the scaled raster during the gesture).
  //  3. Re-pad the tiny-country assist hulls for the final zoom level —
  //     the expensive counter-scale (~80 polygon rebuilds); once per
  //     gesture is all the precision an invisible hit-assist needs.
  _onGestureSettle() {
    this._settleTimer = null;
    this._bakeFrozenZoom();
    const k = this.currentTransform.k;
    // Marker radii were left alone during a frozen gesture (they scaled
    // with the raster like everything else) — bring them back to their
    // constant on-screen size now.
    if (k !== this._lastCounterScaleK) {
      this._lastCounterScaleK = k;
      this.pinMarker.setAttribute("r", String(PIN_RADIUS_PX / k));
      this.capitalMarker.setAttribute("r", String(PIN_RADIUS_PX / k));
    }
    if (this._hullBaseById.size > 0 && k !== this._lastHullPadK) {
      this._lastHullPadK = k;
      for (const [id, base] of this._hullBaseById) {
        const hitArea = this.hitAreasById.get(id);
        if (!hitArea) continue;
        const padded = this._padHull(base.points, base.cx, base.cy, HULL_PADDING / k);
        hitArea.setAttribute("points", padded.map(([x, y]) => `${x},${y}`).join(" "));
      }
    }
  }

  // Exits frozen zoom (see the "zoom" handler): clears the svg's CSS
  // transform, applies the final (now wrap-snapped) transform to the
  // inner groups — the one full vector repaint per gesture, which is also
  // what makes the zoomed view sharp — and re-syncs d3's own internal
  // transform if the wrap snap moved x, so the next gesture's deltas
  // start from what's actually rendered. No-op when not frozen.
  _bakeFrozenZoom() {
    if (this._frozenBase === null) return;
    this._frozenBase = null;
    this.svg.style.transform = "";
    this.viewportEl.classList.remove("world-viewport--zooming");
    const snapped = this._wrapTransform(this.currentTransform);
    const needSync = snapped !== this.currentTransform;
    this.currentTransform = snapped;
    this._applyTransform(snapped);
    if (needSync) {
      this._suppressGestureHooks = true;
      this._selection.call(this.zoomBehavior.transform, snapped);
      this._suppressGestureHooks = false;
    }
  }

  // Explore screen: show (or with null, hide) a capital marker at
  // `capitalLatLng` ([lat, lon], the app's field order) with no pin or
  // line — the game's revealCapitalDistance needs a dropped pin to measure
  // from. Same marker element, so it re-projects on reflow and keeps its
  // constant on-screen size the same way.
  showCapital(capitalLatLng) {
    if (!capitalLatLng) {
      this._revealedCapitalPoint = null;
      this.capitalMarker.style.display = "none";
      return;
    }
    const point = [capitalLatLng[1], capitalLatLng[0]];
    this._revealedCapitalPoint = point;
    const p = this._projectWithWrap(point);
    if (!p) return;
    this.capitalMarker.setAttribute("cx", p[0]);
    this.capitalMarker.setAttribute("cy", p[1]);
    this.capitalMarker.style.display = "";
  }

  // Explore screen's Random: jump the view to frame feature `id`, centred
  // in the part of the viewport below `topInset` px (an overlay card sits
  // over the top). A feature whose bounds span most of the world — the
  // antimeridian-split ones (Russia, Fiji, Kiribati, the US via the
  // Aleutians) — is framed by its largest single part instead, or it
  // would just frame the whole map. Instant, not animated, and run with
  // the gesture hooks suppressed like every other programmatic transform;
  // _onGestureSettle afterwards re-pads the tap-assist hulls for the new k.
  focusOn(id, { topInset = 0 } = {}) {
    const f = this._geometryById.get(id);
    if (!f || !this._lastSize) return;
    const { width, height } = this._lastSize;
    let b = this.pathGen.bounds(f);
    if (this._wrapPeriod && b[1][0] - b[0][0] > this._wrapPeriod * 0.5 && f.geometry?.type === "MultiPolygon") {
      let best = null;
      let bestArea = -1;
      for (const coords of f.geometry.coordinates) {
        const part = { type: "Feature", geometry: { type: "Polygon", coordinates: coords } };
        const a = this.pathGen.area(part);
        if (a > bestArea) {
          bestArea = a;
          best = part;
        }
      }
      if (best) b = this.pathGen.bounds(best);
    }
    const bw = Math.max(b[1][0] - b[0][0], 1e-6);
    const bh = Math.max(b[1][1] - b[0][1], 1e-6);
    const availH = Math.max(height - topInset, height * 0.4);
    // 0.6: leave a comfortable margin of surrounding context. Capped well
    // below MAX_ZOOM so a microstate still shows its neighbourhood.
    const k = Math.max(MIN_ZOOM, Math.min(60, Math.min(width / bw, availH / bh) * 0.6));
    const cx = (b[0][0] + b[1][0]) / 2;
    const cy = (b[0][1] + b[1][1]) / 2;
    const target = zoomIdentity.translate(width / 2 - k * cx, height - availH / 2 - k * cy).scale(k);
    this._suppressGestureHooks = true;
    this._selection.call(this.zoomBehavior.transform, target);
    this._suppressGestureHooks = false;
    this._onGestureSettle();
  }

  // Positions the HTML marker dots (see the constructor) over wherever
  // their svg circles currently sit on screen: home copy, plus one ghost
  // copy either side when wrapping (the same copies the map itself draws),
  // each hidden when off-screen. Pure screen-space math from
  // currentTransform, which is exact in both the live and frozen-zoom
  // paths (the frozen CSS delta is chosen so screen positions match it).
  _syncMarkerDots() {
    if (!this._markerDots) return;
    const t = this.currentTransform;
    const w = this._lastSize?.width ?? 0;
    const h = this._lastSize?.height ?? 0;
    const period = this.wrapEnabled && this._wrapPeriod ? this._wrapPeriod * t.k : 0;
    for (const { circle, copies } of this._markerDots) {
      const shown = circle.style.display !== "none" && circle.hasAttribute("cx");
      const cx = Number(circle.getAttribute("cx"));
      const cy = Number(circle.getAttribute("cy"));
      copies.forEach((dot, i) => {
        const offset = i - 1; // -1, 0, +1 world copies
        if (!shown || (offset !== 0 && !period)) {
          dot.hidden = true;
          return;
        }
        const x = t.x + t.k * cx + offset * period;
        const y = t.y + t.k * cy;
        const visible = x > -20 && x < w + 20 && y > -20 && y < h + 20;
        dot.hidden = !visible;
        if (visible) dot.style.transform = `translate(${x}px, ${y}px)`;
      });
    }
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
    // The map going non-interactive (a result was just confirmed) should
    // drop any leftover hover cue immediately rather than leaving it
    // stuck on whatever was last hovered — the next pointermove would
    // clear it anyway (_onPointerMoveForHover checks clickEnabled), but
    // that could be a while if the mouse doesn't move again first.
    if (!enabled) this._setHoveredId(null);
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
    if (path) {
      path.classList.add(className);
      // `feature()` gives every country its own closed ring, independently
      // duplicating whatever border it shares with each neighbor — so a
      // shared edge is drawn twice, once by each side, and SVG paints
      // later siblings over earlier ones. Country paths sit in plain
      // dataset order (see _reflow's `insertBefore(path, this.borderGroup)`
      // loop), unrelated to adjacency, so a highlighted country's own
      // (thicker, colored) stroke only actually WINS along the sides whose
      // neighbor happens to come earlier in that order — the other sides
      // show the neighbor's ordinary thin border painted on top instead,
      // reading as a patchy/missing highlight rather than a uniform one.
      // Moving the marked path to right before `borderGroup` — the same
      // insertion point _reflow itself uses — makes it the LAST of the
      // per-country paths, so its stroke wins on every side regardless of
      // original order; disputed-border dashes in `borderGroup` still
      // paint above it, unaffected. `insertBefore` on an already-attached
      // node moves it rather than cloning it, so no duplicate is created,
      // and ghost `<use>` copies mirror `contentGroup`'s live DOM order
      // automatically — nothing further needed for them.
      this.contentGroup.insertBefore(path, this.borderGroup);
    }
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
    clearTimeout(this._settleTimer);
    if (this._hoverRafId !== null) cancelAnimationFrame(this._hoverRafId);
    this._resizeObserver.disconnect();
    this._markerObserver?.disconnect();
    this._selection.on(".zoom", null);
    this.viewportEl.remove();
  }
}
