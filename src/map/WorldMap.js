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
// A country's real projected bounding box (at identity zoom) has to be
// smaller than this, in px, to count as "tiny" and get an assist circle
// at all. Calibrated against the actual dataset at a ~800px-wide map:
// true microstates (Vatican City 0.02px, Monaco 0.12px, San Marino
// 0.25px, Liechtenstein 0.54px, Malta 0.84px, Bahrain 1.16px, Mauritius
// 1.37px) sit under this; ordinary small-but-real countries (Luxembourg
// 1.82px, Cyprus/Kosovo ~3.7px, Qatar 4.2px, Jamaica 4.6px) don't, and
// shouldn't get one.
const TINY_THRESHOLD = 1.5;
// The hit-circle's own diameter (px) once a country qualifies as tiny —
// just enough to be reliably tappable, not a big invisible blob that
// could swallow clicks meant for a larger neighbor.
const HIT_DIAMETER = 6;

let instanceCounter = 0;

export class WorldMap {
  constructor(container, { topology, objectKey, filterIds, playableIds, dashedBorders, projection, initialTransform }) {
    this.container = container;
    this.topology = topology;
    this.objectKey = objectKey;
    this.onClick = null;
    this.clickEnabled = false;
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
    this.hitCirclesById = new Map();
    this.hitClipsById = new Map();

    this.projection = (PROJECTIONS[projection] ?? PROJECTIONS.naturalEarth1)();
    this.pathGen = geoPath(this.projection);

    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("class", "world-map");
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
        this.featuresById.set(f.id, path);
        path.addEventListener("click", () => {
          if (this.clickEnabled && this.onClick) this.onClick(f.id);
        });

        const circle = document.createElementNS(SVG_NS, "circle");
        circle.setAttribute("class", "country-hitarea");
        circle.style.display = "none"; // shown only if the shape turns out tiny, in _reflow
        circle.addEventListener("click", () => {
          if (this.clickEnabled && this.onClick) this.onClick(f.id);
        });
        this.hitGroup.appendChild(circle);
        this.hitCirclesById.set(f.id, circle);

        // Lets two nearby tiny countries' hit-circles be clipped to the
        // Voronoi cell around each one's center, so overlapping assist
        // circles never actually overlap — see _reflow.
        const clipId = `${this._instanceId}-hitclip-${f.id}`;
        const clipPath = document.createElementNS(SVG_NS, "clipPath");
        clipPath.id = clipId;
        const polygon = document.createElementNS(SVG_NS, "polygon");
        clipPath.appendChild(polygon);
        this.defs.appendChild(clipPath);
        this.hitClipsById.set(f.id, { clipId, polygon });
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

    // Pass 1: lay out every path, and every tiny country's hit-circle at
    // its full (unclipped) size, collecting the tiny ones for pass 2.
    const tiny = []; // { id, cx, cy }
    for (const f of this.geojson.features) {
      const path = this.featuresById.get(f.id) ?? this._findUnplayablePath(f);
      if (path) path.setAttribute("d", this.pathGen(f));

      const circle = this.hitCirclesById.get(f.id);
      if (!circle) continue;

      const bounds = this.pathGen.bounds(f);
      const bw = bounds[1][0] - bounds[0][0];
      const bh = bounds[1][1] - bounds[0][1];
      const isTiny = Number.isFinite(bw) && Number.isFinite(bh) && Math.max(bw, bh) < TINY_THRESHOLD;
      circle.removeAttribute("clip-path");
      if (!isTiny) {
        circle.style.display = "none";
        continue;
      }
      const cx = (bounds[0][0] + bounds[1][0]) / 2;
      const cy = (bounds[0][1] + bounds[1][1]) / 2;
      circle.setAttribute("cx", cx);
      circle.setAttribute("cy", cy);
      circle.setAttribute("r", HIT_DIAMETER / 2);
      circle.style.display = "";
      tiny.push({ id: f.id, cx, cy });
    }

    // Pass 2: two (or more) tiny countries close enough for their circles
    // to overlap get clipped to their Voronoi cell — the region closer to
    // that country's center than to any other tiny country's — so the
    // boundary between them is exactly the line equidistant from both,
    // and the circles never actually overlap. A country with no nearby
    // tiny neighbor gets a cell far bigger than its own circle, so this
    // is a no-op for it.
    if (tiny.length > 0) {
      const delaunay = Delaunay.from(tiny.map((t) => [t.cx, t.cy]));
      const voronoi = delaunay.voronoi([0, 0, width, height]);
      tiny.forEach((t, i) => {
        const cell = voronoi.cellPolygon(i);
        const clip = this.hitClipsById.get(t.id);
        if (!cell || !clip) return;
        clip.polygon.setAttribute("points", cell.map(([x, y]) => `${x},${y}`).join(" "));
        this.hitCirclesById.get(t.id).setAttribute("clip-path", `url(#${clip.clipId})`);
      });
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

    this.zoomBehavior.extent([[0, 0], [width, height]]).translateExtent([[0, 0], [width, height]]);
    this._selection.call(this.zoomBehavior.transform, resetZoom ? zoomIdentity : this.currentTransform);
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

  // Applies to both the real path and its hit-circle (if any) — for a
  // country small enough to need a hit-circle, the real shape is often
  // too tiny to see any fill change on, so the circle is what actually
  // shows the player their selection/result.
  _mark(id, className) {
    const path = this.featuresById.get(id);
    if (path) path.classList.add(className);
    const circle = this.hitCirclesById.get(id);
    if (circle) circle.classList.add(className);
  }

  _forEachMarked(fn) {
    for (const path of this.featuresById.values()) fn(path);
    for (const circle of this.hitCirclesById.values()) fn(circle);
  }

  destroy() {
    this._resizeObserver.disconnect();
    this._selection.on(".zoom", null);
    this.svg.remove();
  }
}
