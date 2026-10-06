import "./style.css";
import { renderHome } from "./ui/home.js";
import { startGameWizard } from "./ui/gameWizard.js";
import { renderMapExplore } from "./ui/mapExplore.js";
import { renderSettings } from "./ui/settingsScreen.js";
import { renderChoiceScreen } from "./ui/screenKit.js";

const app = document.querySelector("#app");

function showHome() {
  renderHome(app, { onGames: showGames, onMap: showMap, onSettings: showSettings });
}

function showGames() {
  startGameWizard(app, showHome);
}

// Map → pick which map to explore. Keys are datasets.js dataset keys.
const exploreMaps = [
  { datasetKey: "countries", label: "World" },
  { datasetKey: "us-states", label: "USA" },
  { datasetKey: "china", label: "China" },
];

function showMap() {
  renderChoiceScreen(app, {
    title: "Which map?",
    options: exploreMaps,
    labelFn: (m) => m.label,
    onPick: (m) => renderMapExplore(app, { datasetKey: m.datasetKey, onBack: showMap, onHome: showHome }),
    onBack: showHome,
  });
}

function showSettings() {
  renderSettings(app, showHome);
}

showHome();
