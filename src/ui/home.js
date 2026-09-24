// Main hub screen: Games / Map / Settings.

import { renderChoiceScreen } from "./screenKit.js";

const destinations = [
  { key: "games", label: "Games" },
  { key: "map", label: "Map" },
  { key: "settings", label: "Settings" },
];

export function renderHome(container, { onGames, onMap, onSettings }) {
  const handlers = { games: onGames, map: onMap, settings: onSettings };
  renderChoiceScreen(container, {
    title: "Geography Quiz",
    options: destinations,
    labelFn: (d) => d.label,
    onPick: (d) => handlers[d.key](),
  });
}
