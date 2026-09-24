// Reusable SVG map: renders any topojson object (keyed by feature id) with
// d3-geo/topojson-client, and exposes highlight/select/click/feedback hooks
// plus scroll-wheel/pinch zoom (d3-zoom). This module doesn't know about
// "countries" specifically — any dataset with a topojson topology +
// matching item ids works the same way, so a second map-based dataset
// (US states) reuses it with only its `projection` config differing.

import { geoNaturalEarth1, geoIdentity, geoPath } from "d3-geo";
import { feature, mesh } from "topojson-client";
import { zoom, zoomIdentity } from "d3-zoom";
import { select, pointer } from "d3-selection";
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
// A single-blob country (no second landmass to speak of) gets an assist
// hit-region if its own projected area (px², at a ~800px-wide map) is
// under this. Calibrated against the actual dataset: true microstates
// (Vatican City 0.0004px², Monaco 0.007px², San Marino 0.04px²,
// Liechtenstein 0.08px², Bahrain 0.28px², Mauritius 0.94px²) sit under
// this; ordinary small-but-real countries (Luxembourg 1.63px², Cyprus
// 3.12px²) don't, and shouldn't get one.
const AREA_THRESHOLD_SINGLE = 1.2;
// A country made of 2+ separate parts qualifies too, but only if none of
// its individual parts is already big enough to be a comfortable click
// target on its own (px², same ~800px-wide-map scale) — total area or
// part *count* isn't the signal: Philippines has 48 parts and a large
// total area (140px²) but its biggest single island is only 51px², so it
// still needs the gaps between islands filled in; Indonesia, Greece, the
// UK, Norway, Japan, Malaysia, Croatia, and every large sprawling country
// with a few stray offshore islets (Russia, Canada, USA, Brazil,
// Australia, China, ...) all have one part alone well past this, so
// their existing path is already a perfectly good click target and
// doesn't need (or safely tolerate — see HULL_BBOX_CAP) a hull spanning
// their full extent. Calibrated to sit strictly between Philippines'
// 51.46px² (must qualify) and Greece's 60.75px² (must not).
const LARGEST_PART_CAP = 55;
// Safety cap (px, bounding-box max dimension), independent of
// LARGEST_PART_CAP: catches a handful of cases that would otherwise slip
// through it — a country whose *largest* part is small but whose parts
// are scattered across a huge span, either because it has real
// far-offshore territory (Netherlands' Caribbean islands, ~167px from the
// mainland) or because the raw topology data wraps around the
// antimeridian and produces a bogus bounding box spanning almost the
// whole map (Kiribati 785px, Fiji 800px). No genuine, safe-to-hull-fill
// case in the actual dataset gets anywhere near this (Indonesia, the
// widest real one excluded solely by LARGEST_PART_CAP, is 103px;
// Micronesia, the widest one that still qualifies, is 57px).
const HULL_BBOX_CAP = 150;
// Every hit-region hull vertex gets pushed outward from the feature's own
// centroid by this many px, so even a naturally tiny/compact hull (two
// Maldives atolls barely 2.6px apart) ends up comfortably tappable
// instead of just "sized to its own coastline".
const HULL_PADDING = 3;

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

    const fullGeojson = feature(topology, topology.objects[objectKey]);
    // When restricted to a continent, drop everything else entirely (not
    // just visually) so the projection fits to, and only renders, that
    // region. Features with no stable id (disputed/non-ISO territories)
    // never pass a filter, since they can never be "in" a continent.
    const geojson = filterIds
      ? { type: "FeatureCollection", features: fullGeojson.features.filter((f) => f.id && filterIds.has(f.id)) }
      : fullGeojson;
    this.geojson = geojson;
    this.featuresById = new Map();
    this.hitAreasById = new Map();
    this.hitClipsById = new Map();

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

    this.pathsGroup = document.createElementNS(SVG_NS, "g");
    this.svg.appendChild(this.pathsGroup);
    // Two more groups stacked after every country path, in this order:
    // dashed disputed-border lines (visible on top of fills, but never
    // clickable), then hit-circles last so a tiny country's assist circle
    // always wins pointer hit-testing over a neighbouring country's much
    // larger shape.
    this.borderGroup = document.createElementNS(SVG_NS, "g");
    this.borderGroup.setAttribute("class", "border-lines");
    this.pathsGroup.appendChild(this.borderGroup);
    this.hitGroup = document.createElementNS(SVG_NS, "g");
    this.hitGroup.setAttribute("class", "hit-areas");
    this.pathsGroup.appendChild(this.hitGroup);

    // The dropped-pin marker (pin mode only) — decorative, never itself a
    // click target (pointer-events: none, see style.css), so every click
    // on the map — including one that lands on top of the current pin —
    // reaches the whole-map click listener below and repositions it.
    this.pinMarker = document.createElementNS(SVG_NS, "circle");
    this.pinMarker.setAttribute("class", "pin-marker");
    this.pinMarker.style.display = "none";
    this.pathsGroup.appendChild(this.pinMarker);

    // Data-driven, not hardcoded to any specific pair: dashedBorders is a
    // list of [idA, idB] country-id pairs (see core/datasets.js) whose
    // *shared* border — extracted via topojson's mesh(), not their whole
    // outline — renders dashed, to flag a disputed frontier instead of
    // drawing it like a normal international border.
    this.borderLines = (dashedBorders ?? []).map(([idA, idB]) => {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("class", "border--disputed");
      path.style.pointerEvents = "none";
      this.borderGroup.appendChild(path);
      return { idA, idB, path };
    });

    for (const f of geojson.features) {
      // "Playable" gates click handling, normal styling, and a hit-circle —
      // independent of whether the topology happens to have assigned this
      // feature an id. This is what lets e.g. Kosovo exist in the topology
      // year-round but only be interactive when the extra-territories
      // setting is on: playableIds is derived from whatever the current
      // game's item list actually is.
      const playable = Boolean(f.id) && (!playableIds || playableIds.has(f.id));

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("class", "country" + (playable ? "" : " country--unplayable"));

      if (playable) {
        path.dataset.id = f.id;
        // Still tracked in pin mode — needed so markResult() can find and
        // highlight the correct answer's (and, if the pin landed inside
        // some other country, the wrong guess's) real shape after
        // confirm — just never given its own click listener or hit-area,
        // since pin mode has no per-country click targets at all (see the
        // whole-map click listener below instead).
        this.featuresById.set(f.id, path);

        if (!this.pinMode) {
          path.addEventListener("click", () => {
            if (this.clickEnabled && this.onClick) this.onClick(f.id);
          });

          // A polygon rather than a circle so it can be shaped as a padded
          // convex hull around a country's parts (see _computeHull) — this
          // covers both compact microstates (hull ~= a small rounded blob)
          // and archipelagos (hull spans and fills the gaps between
          // islands) with one mechanism.
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

      this.pathsGroup.insertBefore(path, this.borderGroup);
    }

    this.currentTransform = initialTransform ?? zoomIdentity;
    this.zoomBehavior = zoom()
      .scaleExtent([1, 10])
      .on("zoom", (event) => {
        this.currentTransform = event.transform;
        this.pathsGroup.setAttribute("transform", String(event.transform));
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
      // country shape. `pointer(event, this.pathsGroup)` (not `this.svg`)
      // resolves the click through both the SVG's own viewBox scaling
      // *and* the paths group's current zoom/pan transform, landing back
      // in the same untransformed pixel space `this.projection` was fit
      // to — exactly what `.invert()` expects.
      this.svg.addEventListener("click", (event) => {
        if (!this.clickEnabled) return;
        const [x, y] = pointer(event, this.pathsGroup);
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

  _reflow({ resetZoom } = {}) {
    const width = this.container.clientWidth || 800;
    const height = this.container.clientHeight || 500;
    if (width === 0 || height === 0) return;
    const sizeChanged = this._lastSize && (this._lastSize.width !== width || this._lastSize.height !== height);
    if (resetZoom === undefined) resetZoom = Boolean(sizeChanged);
    this._lastSize = { width, height };

    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.projection.fitSize([width, height], this.geojson);

    // Pass 1: lay out every path. For every playable feature, also note
    // its bbox center as a Voronoi site (used below to bound assist
    // hit-regions against every real neighbor, not just other assisted
    // countries), and flag it as "qualifying" for an assist hit-region if
    // it's a compact single-blob microstate or has multiple separate
    // parts (an archipelago) — see the threshold constants above.
    const sites = []; // { id, cx, cy }
    const qualifying = []; // { id, f, cx, cy }
    for (const f of this.geojson.features) {
      const path = this.featuresById.get(f.id) ?? this._findUnplayablePath(f);
      if (path) path.setAttribute("d", this.pathGen(f));

      const hitArea = this.hitAreasById.get(f.id);
      if (!hitArea) continue;

      hitArea.removeAttribute("clip-path");
      hitArea.style.display = "none";

      const bounds = this.pathGen.bounds(f);
      const bw = bounds[1][0] - bounds[0][0];
      const bh = bounds[1][1] - bounds[0][1];
      const bboxMax = Math.max(bw, bh);
      if (!Number.isFinite(bboxMax)) continue;
      const cx = (bounds[0][0] + bounds[1][0]) / 2;
      const cy = (bounds[0][1] + bounds[1][1]) / 2;
      sites.push({ id: f.id, cx, cy });

      if (bboxMax >= HULL_BBOX_CAP) continue; // antimeridian-degenerate, or a real but far-flung exclave — skip
      const isMulti = f.geometry?.type === "MultiPolygon";
      const qualifies = isMulti
        ? this._largestPartArea(f) < LARGEST_PART_CAP
        : (() => {
            const area = this.pathGen.area(f);
            return Number.isFinite(area) && area < AREA_THRESHOLD_SINGLE;
          })();
      if (qualifies) qualifying.push({ id: f.id, f, cx, cy });
    }

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

    this.zoomBehavior.extent([[0, 0], [width, height]]).translateExtent([[0, 0], [width, height]]);
    this._selection.call(this.zoomBehavior.transform, resetZoom ? zoomIdentity : this.currentTransform);
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

  // The projected area (px², at the map's current fitSize scale) of a
  // MultiPolygon feature's single biggest part — see LARGEST_PART_CAP.
  _largestPartArea(f) {
    let max = 0;
    for (const coords of f.geometry.coordinates) {
      const area = this.pathGen.area({ type: "Polygon", coordinates: coords });
      if (Number.isFinite(area) && area > max) max = area;
    }
    return max;
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

  _findUnplayablePath(f) {
    // Unplayable features aren't in featuresById (no stable id, or a
    // stable id that isn't currently playable); locate by index instead
    // since geojson.features order matches DOM order.
    const index = this.geojson.features.indexOf(f);
    return this.pathsGroup.children[index] ?? null;
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

  // Applies to both the real path and its hit-region (if any) — for a
  // country small enough to need one, the real shape is often too tiny to
  // see any fill change on, so the hit-region is what actually shows the
  // player their selection/result.
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
