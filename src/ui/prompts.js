// Prompt widget registry, keyed by attribute.promptKind (see core/attributes.js).
// Each renderer mounts the question into `container` and returns
// `{ cleanup, getTransform? }` — getTransform is only present for map-based
// prompts, and is how the game screen carries a zoom level forward between
// rounds when the "keep zoom" setting is on. The game screen never
// branches on which attribute is active — it just looks up the widget by
// kind.

import { WorldMap } from "../map/WorldMap.js";

const renderers = {
  text: (container, { item, attr }) => {
    const el = document.createElement("div");
    el.className = "prompt-text";
    el.textContent = attr.getValue(item);
    container.appendChild(el);
    return { cleanup: () => el.remove() };
  },

  "map-highlight": (container, { item, dataset, focusIds, playableIds, initialTransform }) => {
    const map = new WorldMap(container, {
      topology: dataset.topology,
      objectKey: dataset.topologyObject,
      focusIds,
      playableIds,
      dashedBorders: dataset.dashedBorders,
      projection: dataset.projection,
      initialTransform,
    });
    map.highlight(item.id);
    return { cleanup: () => map.destroy(), getTransform: () => map.getTransform() };
  },
};

export function renderPrompt(container, kind, ctx) {
  const renderer = renderers[kind];
  if (!renderer) throw new Error(`Unknown prompt kind: ${kind}`);
  container.innerHTML = "";
  return renderer(container, ctx);
}
