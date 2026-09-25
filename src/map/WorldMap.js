// Reusable SVG map: renders any topojson object (keyed by feature id) with
// d3-geo/topojson-client, and exposes highlight/select/click/feedback hooks
// plus scroll-wheel/pinch zoom (d3-zoom). This module doesn't know about
// "countries" specifically — any dataset with a topojson topology +
// matching item ids works the same way, so a second map-based dataset
// (US states) reuses it with only its `projection` config differing.

import { geoNaturalEarth1, geoIdentity, geoPath } from "d3-geo";
import { feature, mesh } from "topojson-client";
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

// Flattens lon/lat to a local tangent-plane xy (km) around a fixed
// reference latitude, purely so a border segment's closest point can be
// found with plain planar geometry — good enough for a "how far off was
// your guess" readout (border segments are short relative to the earth's
// curvature) without pulling in a full geodesic library.
function lonLatToLocalKm(lon, lat, refLat) {
  const rad = Math.PI / 180;
  return [lon * rad * Math.cos(refLat * rad) * EARTH_RADIUS_KM, lat * rad * EARTH_RADIUS_KM];
}

// Distance (km, via the local-plane approximation above) from (lon, lat) to
// the nearest point on the segment [lon1,lat1]-[lon2,lat2], clamped to the
// segment itself (not the infinite line through it).
function pointToSegmentKm(lon, lat, [lon1, lat1], [lon2, lat2]) {
  const [px, py] = lonLatToLocalKm(lon, lat, lat);
  const [ax, ay] = lonLatToLocalKm(lon1, lat1, lat);
  const [bx, by] = lonLatToLocalKm(lon2, lat2, lat);
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function ringMinDistanceKm(lon, lat, ring) {
  let min = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const d = pointToSegmentKm(lon, lat, ring[i], ring[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

// Nearest-border distance (km) from a point to a feature's own outline —
// every ring of every part (an archipelago's coastline is still its
// border, same as a mainland's), not just the outer boundary of its
// largest part. Returns null only if the feature has no polygon geometry
// at all.
function featureBorderDistanceKm(lon, lat, feature) {
  const geometry = feature.geometry;
  const polygons =
    geometry?.type === "MultiPolygon" ? geometry.coordinates : geometry?.type === "Polygon" ? [geometry.coordinates] : null;
  if (!polygons) return null;
  let min = Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) min = Math.min(min, ringMinDistanceKm(lon, lat, ring));
  }
  return Number.isFinite(min) ? min : null;
}

let instanceCounter = 0;

export class WorldMap {
  constructor(
    container,
    { topology, objectKey, filterIds, playableIds, dashedBorders, projection, initialTransform, pinMode }
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

    // Infinite horizontal wrap only makes sense for an unrestricted
    // world-scale view: a continent crop (filterIds set) doesn't tile
    // into a seamless globe (you'd just see the same regional chunk
    // repeat), and a pre-projected "identity" topology (US states'
    // Albers projection) has no periodic lon/lat structure to wrap at
    // all. See _wrapTransform/_applyTransform for how the wrap itself
    // works, and the per-feature loop below for how "one copy" of the
    // map's content is built once and reused for all three.
    this.wrapEnabled = !filterIds && (projection ?? "naturalEarth1") !== "identity";
    this._wrapPeriod = null; // one world-width, in projected px at the current fitSize scale — set in _reflow
    this._homeLeft = null; // left edge of that same world, in the same units

    const fullGeojson = feature(topology, topology.objects[objectKey]);
    // When restricted to a continent, drop everything else entirely (not
    // just visually) so the projection fits to, and only renders, that
    // region. Features with no stable id (disputed/non-ISO territories)
    // never pass a filter, since they can never be "in" a continent.
    const geojson = filterIds
      ? { type: "FeatureCollection", features: fullGeojson.features.filter((f) => f.id && filterIds.has(f.id)) }
      : fullGeojson;
    this.geojson = geojson;

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

    // Everything below is built once, directly, into the home copy;
    // ghost copies (if any) are populated as <use> clones of it further
    // down.
    this.featuresById = new Map(); // playable id -> home copy's <path>
    this.hitAreasById = new Map();
    this.hitClipsById = new Map();
    // id -> raw geojson feature (not just playable ones' <path> elements) —
    // used by distanceToBorderKm, which needs the actual ring coordinates,
    // not anything SVG/projection-dependent.
    this._geometryById = new Map(geojson.features.filter((f) => f.id).map((f) => [f.id, f]));

    this.borderGroup = document.createElementNS(SVG_NS, "g");
    this.borderGroup.setAttribute("class", "border-lines");
    this.homeGroup.appendChild(this.borderGroup);
    this.hitGroup = document.createElementNS(SVG_NS, "g");
    this.hitGroup.setAttribute("class", "hit-areas");
    this.homeGroup.appendChild(this.hitGroup);

    // The dropped-pin marker (pin mode only) — decorative, never itself a
    // click target (pointer-events: none, see style.css), so every click
    // on the map — including one that lands on top of the current pin —
    // reaches the whole-map click listener below and repositions it.
    this.pinMarker = document.createElementNS(SVG_NS, "circle");
    this.pinMarker.id = `${this._instanceId}-pin`;
    this.pinMarker.setAttribute("class", "pin-marker");
    this.pinMarker.setAttribute("r", "3"); // also in style.css; set directly too rather than relying solely on CSS geometry-property support
    this.pinMarker.style.display = "none";
    this.homeGroup.appendChild(this.pinMarker);

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

    for (const [index, f] of geojson.features.entries()) {
      // "Playable" gates click handling, normal styling, and a hit-circle —
      // independent of whether the topology happens to have assigned this
      // feature an id. This is what lets e.g. Kosovo exist in the topology
      // year-round but only be interactive when the extra-territories
      // setting is on: playableIds is derived from whatever the current
      // game's item list actually is.
      const playable = Boolean(f.id) && (!playableIds || playableIds.has(f.id));

      const path = document.createElementNS(SVG_NS, "path");
      path.id = `${this._instanceId}-f${index}`;
      path.setAttribute("class", "country" + (playable ? "" : " country--unplayable"));

      if (playable) {
        path.dataset.id = f.id;
        this.featuresById.set(f.id, path);

        if (!this.pinMode) {
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
      for (const path of this._pathsByIndex) {
        const use = this._makeUse(path.id);
        use.setAttribute("class", "country-ghost");
        const fId = path.dataset.id;
        if (fId && !this.pinMode) {
          use.addEventListener("click", () => {
            if (this.clickEnabled && this.onClick) this.onClick(fId);
          });
        }
        group.appendChild(use);
      }
      for (const { path } of this.borderLines) group.appendChild(this._makeUse(path.id));
      group.appendChild(this._makeUse(this.pinMarker.id));
    }

    this.currentTransform = initialTransform ?? zoomIdentity;
    this.zoomBehavior = zoom()
      .scaleExtent([1, 10])
      .on("start", () => this.svg.classList.add("world-map--panning"))
      .on("zoom", (event) => {
        this.currentTransform = this._wrapTransform(event.transform);
        this._applyTransform(this.currentTransform);
      })
      // A cheap, well-established SVG performance trick: while a pan/zoom
      // gesture is actively in progress, drop rendering quality (blockier
      // edges, no antialiasing niceties) in exchange for faster per-frame
      // repaints, then restore full quality the instant it ends — the
      // player is looking at the whole shape while moving, not a single
      // edge, so the drop is barely noticeable, but repainting ~240
      // country paths (more with wrap's ghost copies) at full quality on
      // every drag/wheel tick is real work that a phone GPU in particular
      // can fall behind on, which is what actually reads as "not smooth".
      // These are d3-zoom's own dispatched "start"/"end" gesture events
      // (via `zoomBehavior.on`), not native DOM events — unlike
      // "dblclick.zoom" below, they don't exist to bind via the
      // selection's own `.on(...)`.
      .on("end", () => this.svg.classList.remove("world-map--panning"));
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
    this.projection.fitSize([width, height], this.geojson);

    if (this.wrapEnabled) {
      const b = this.pathGen.bounds(this.geojson);
      if (Number.isFinite(b[0][0]) && Number.isFinite(b[1][0])) {
        this._homeLeft = b[0][0];
        this._wrapPeriod = b[1][0] - b[0][0];
      }
    }

    // The reference area both hit-region thresholds are measured against
    // — see the comment above AREA_RATIO_SINGLE/LARGEST_PART_TIER1_RATIO/LARGEST_PART_TIER2_RATIO for
    // why this needs to scale with the map's own viewport/feature-count,
    // not be a fixed px² value shared by every dataset this class renders.
    const evenSplitArea = this.featuresById.size > 0 ? (width * height) / this.featuresById.size : Infinity;

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
    if (qualifying.length > 0 && sites.length > 0) {
      const delaunay = Delaunay.from(sites.map((s) => [s.cx, s.cy]));
      const voronoi = delaunay.voronoi([0, 0, width, height]);
      const siteIndexById = new Map(sites.map((s, i) => [s.id, i]));

      for (const q of qualifying) {
        const hull = this._computeHull(q.f, q.cx, q.cy);
        if (!hull) continue;

        const hitArea = this.hitAreasById.get(q.id);
        const clip = this.hitClipsById.get(q.id);
        hitArea.setAttribute("points", hull.map(([x, y]) => `${x},${y}`).join(" "));
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

    this.zoomBehavior
      .extent([[0, 0], [width, height]])
      .translateExtent(this.wrapEnabled ? [[-Infinity, 0], [Infinity, height]] : [[0, 0], [width, height]]);
    this._selection.call(this.zoomBehavior.transform, resetZoom ? zoomIdentity : this.currentTransform);
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
      if (!f.id || !this.featuresById.has(f.id)) continue; // unplayable — never a valid guess
      if (pointInFeature(lon, lat, f)) return f.id;
    }
    return null;
  }

  // Distance (km) from a lon/lat point to the nearest edge of feature `id`'s
  // own outline — 0 if the point already falls inside it. Used by pin-drop
  // mode's post-confirm feedback: "how far off was this guess" is more
  // useful measured against the country's actual shape than against its
  // centroid, especially for large or oddly-shaped countries where a pin
  // dropped well inside the border can otherwise read as "hundreds of km
  // from the center".
  distanceToBorderKm(lon, lat, id) {
    const f = this._geometryById.get(id);
    if (!f) return null;
    if (pointInFeature(lon, lat, f)) return 0;
    return featureBorderDistanceKm(lon, lat, f);
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
  // current fitSize scale), takes their convex hull, and pushes each hull
  // vertex outward from (cx, cy) by HULL_PADDING. For a multi-part
  // feature this hull naturally spans and fills the space between parts
  // (an archipelago's inter-island water); for a single compact blob it's
  // effectively a slightly-enlarged version of the country's own outline.
  _computeHull(f, cx, cy) {
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
    if (hullPoints.length < 3) return null;

    return hullPoints.map(([x, y]) => {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < 1e-6) return [x, y];
      const scale = (dist + HULL_PADDING) / dist;
      return [cx + dx * scale, cy + dy * scale];
    });
  }

  getTransform() {
    return this.currentTransform;
  }

  setClickable(enabled, onClick) {
    this.clickEnabled = enabled;
    this.onClick = onClick ?? null;
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
  }

  // Applies to both the real path (every copy — ghost copies are <use>
  // clones of the home path, so they pick up its classes automatically;
  // only the home copy's own hit-region additionally needs the class
  // added directly, since it's a separate element, not a clone) — for a
  // country small enough to need a hit-region, the real shape is often
  // too tiny to see any fill change on, so the hit-region is what
  // actually shows the player their selection/result.
  _mark(id, className) {
    const path = this.featuresById.get(id);
    if (path) path.classList.add(className);
    const hitArea = this.hitAreasById.get(id);
    if (hitArea) hitArea.classList.add(className);
  }

  _forEachMarked(fn) {
    for (const path of this.featuresById.values()) fn(path);
    for (const hitArea of this.hitAreasById.values()) fn(hitArea);
  }

  destroy() {
    this._resizeObserver.disconnect();
    this._selection.on(".zoom", null);
    this.svg.remove();
  }
}
