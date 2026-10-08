// Main hub screen: Games / Map / How to Play / Settings.

import { renderChoiceScreen } from "./screenKit.js";

const destinations = [
  { key: "games", label: "Games" },
  { key: "map", label: "Map" },
  { key: "howto", label: "How to Play" },
  { key: "settings", label: "Settings" },
];

export function renderHome(container, { onGames, onMap, onHowTo, onSettings }) {
  const handlers = { games: onGames, map: onMap, howto: onHowTo, settings: onSettings };
  renderChoiceScreen(container, {
    title: "Geography Quiz",
    options: destinations,
    labelFn: (d) => d.label,
    onPick: (d) => handlers[d.key](),
  });
}
