// Free-explore map: the whole world, every item (including extra
// territories) clickable, no quiz mechanics — just click a country to see
// its name. Reuses WorldMap exactly as the game screens do, just without
// a QuizSession driving it.

import { loadDataset } from "../core/datasets.js";
import { WorldMap } from "../map/WorldMap.js";

export function renderMapExplore(container, onBack) {
  container.innerHTML = "";

  const root = document.createElement("div");
  root.className = "game-screen";

  const header = document.createElement("div");
  header.className = "game-header";

  const label = document.createElement("span");
  label.className = "explore-label";
  label.textContent = "Click a country to see its name";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "exit-button";
  back.textContent = "← Back";
  back.addEventListener("click", () => {
    cancelled = true;
    map?.destroy();
    onBack();
  });

  header.append(label, back);

  const mapArea = document.createElement("div");
  mapArea.className = "answer-area explore-area";
  mapArea.textContent = "Loading map…";

  root.append(header, mapArea);
  container.appendChild(root);

  let map = null;
  let cancelled = false;

  loadDataset("countries")
    .then((dataset) => {
      // Back was clicked while the data was still loading — building the
      // map now would mount it into a detached node and leak the whole
      // WorldMap (its ResizeObserver keeps observing the detached
      // container, holding the topology alive).
      if (cancelled) return;
      mapArea.textContent = "";
      map = new WorldMap(mapArea, {
        topology: dataset.topology,
        objectKey: dataset.topologyObject,
        dashedBorders: dataset.dashedBorders,
      });
      const byId = new Map(dataset.items.map((i) => [i.id, i]));
      map.setClickable(true, (id) => {
        map.select(id);
        const item = byId.get(id);
        label.textContent = item ? item.name : "Unknown area";
      });
    })
    .catch((err) => {
      console.error(err);
      mapArea.textContent = "Could not load map data.";
    });
}
