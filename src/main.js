import "./style.css";
import { renderHome } from "./ui/home.js";
import { startGameWizard } from "./ui/gameWizard.js";
import { renderMapExplore } from "./ui/mapExplore.js";
import { renderSettings } from "./ui/settingsScreen.js";

const app = document.querySelector("#app");

function showHome() {
  renderHome(app, { onGames: showGames, onMap: showMap, onSettings: showSettings });
}

function showGames() {
  startGameWizard(app, showHome);
}

function showMap() {
  renderMapExplore(app, showHome);
}

function showSettings() {
  renderSettings(app, showHome);
}

showHome();
