// Free-explore map for any dataset (World, USA, China — picked on the
// Map choice screen, main.js): every item clickable, no quiz mechanics. Clicking a country (or
// Random) shows an info card floating over the top of the map — name,
// continent, flag, emblem, capital (also marked on the map) and currency —
// in the same overlay style as the game's map rounds. Header mirrors the
// game screen's: a label on the left, Random in the bar, the shared ☰
// menu on the right. Reuses WorldMap exactly as the game screens do.

import { loadDataset } from "../core/datasets.js";
import { WorldMap } from "../map/WorldMap.js";
import { createHamburgerMenu } from "./hamburgerMenu.js";

const BASE = import.meta.env?.BASE_URL ?? "/";

export function renderMapExplore(container, { datasetKey = "countries", onBack, onHome }) {
  container.innerHTML = "";

  const root = document.createElement("div");
  root.className = "game-screen";

  const header = document.createElement("div");
  header.className = "game-header";

  const label = document.createElement("span");
  label.className = "explore-label";
  label.textContent = { "us-states": "Tap a state", china: "Tap a province" }[datasetKey] ?? "Tap a country";

  const randomButton = document.createElement("button");
  randomButton.type = "button";
  randomButton.className = "action-button";
  randomButton.textContent = "Random";
  randomButton.disabled = true; // until the map has loaded

  // Back (to the map choice screen) and Home, behind the ☰ menu like the
  // game screen's Restart/Back/Home.
  const leave = (to) => {
    cancelled = true;
    map?.destroy();
    to();
  };
  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "exit-button";
  backButton.textContent = "Back";
  backButton.addEventListener("click", () => leave(onBack));
  const homeButton = document.createElement("button");
  homeButton.type = "button";
  homeButton.className = "exit-button";
  homeButton.textContent = "Home";
  homeButton.addEventListener("click", () => leave(onHome ?? onBack));

  header.append(label, randomButton, createHamburgerMenu(root, [backButton, homeButton], { label: "Map menu" }));

  // Same structure as a game map round (game.js): the map fills the area
  // and the info card floats over its top edge, so showing/hiding the card
  // never moves or resizes the map.
  const roundArea = document.createElement("div");
  roundArea.className = "round-area round-area--map-overlay";

  const mapArea = document.createElement("div");
  mapArea.className = "answer-area explore-area";
  mapArea.textContent = "Loading map…";

  const overlay = document.createElement("div");
  overlay.className = "map-overlay";
  const card = document.createElement("div");
  card.className = "explore-card";
  card.hidden = true;
  overlay.append(card);

  roundArea.append(mapArea, overlay);
  root.append(header, roundArea);
  container.appendChild(root);

  let map = null;
  let cancelled = false;

  function showInfo(item) {
    card.replaceChildren();
    if (!item) {
      card.hidden = true;
      map?.showCapital(null);
      return;
    }
    const title = document.createElement("div");
    title.className = "explore-card-title";
    title.textContent = item.name;

    const sub = document.createElement("div");
    sub.className = "explore-card-sub";
    // Whatever classification the dataset has: a China division's type
    // ("Autonomous Region"), a country's continent · sub-region, nothing
    // for US states.
    sub.textContent = item.type ?? [item.region, item.subregion].filter(Boolean).join(" · ");

    const images = document.createElement("div");
    images.className = "explore-card-images";
    for (const [url, alt] of [
      [item.flagUrl, `Flag of ${item.name}`],
      [item.emblemUrl, `Emblem of ${item.name}`],
    ]) {
      if (!url) continue;
      const img = document.createElement("img");
      img.src = `${BASE}${url}`;
      img.alt = alt;
      images.append(img);
    }

    const facts = document.createElement("dl");
    facts.className = "explore-card-facts";
    for (const [term, value] of [
      // China's divisions carry what their name means (from the reference
      // map in docs/reference/, via generate-china-data.mjs).
      ["Name means", item.meaning ? `“${item.meaning}”` : null],
      ["Capital", item.capital],
      ["Currency", item.currency],
    ]) {
      if (!value) continue;
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      facts.append(dt, dd);
    }

    card.append(title);
    if (sub.textContent) card.append(sub);
    if (images.childElementCount) card.append(images);
    if (facts.childElementCount) card.append(facts);
    if (item.meaningNote) {
      const note = document.createElement("div");
      note.className = "explore-card-note";
      note.textContent = item.meaningNote;
      card.append(note);
    }
    card.hidden = false;
    // The capital's location, as a dot on the map itself.
    map?.showCapital(item.capitalLatLng ?? null);
  }

  loadDataset(datasetKey)
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
        projection: dataset.projection,
        // Only real items are clickable/bright — scenery shapes with no
        // item behind them (Antarctica and the other Antarctic-region
        // territories) render muted and inert, as in every game.
        playableIds: new Set(dataset.items.map((i) => i.id)),
      });
      const byId = new Map(dataset.items.map((i) => [i.id, i]));
      const select = (id) => {
        map.select(id);
        showInfo(byId.get(id) ?? null);
      };
      map.setClickable(true, select);

      randomButton.disabled = false;
      randomButton.addEventListener("click", () => {
        const items = dataset.items;
        const item = items[Math.floor(Math.random() * items.length)];
        select(item.id);
        // Frame it below the card, which covers the top of the map.
        const overlayBottom = card.getBoundingClientRect().bottom - mapArea.getBoundingClientRect().top;
        map.focusOn(item.id, { topInset: Math.max(0, overlayBottom + 8) });
      });
    })
    .catch((err) => {
      console.error(err);
      mapArea.textContent = "Could not load map data.";
    });
}
