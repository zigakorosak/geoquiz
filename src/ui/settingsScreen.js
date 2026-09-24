// Global settings screen, reachable from the home screen. Currently just
// the zoom-persistence preference (moved here from the old per-game menu
// step — a Settings screen implies something durable, not re-asked every
// game).

import { loadSettings, saveSettings } from "../core/settings.js";

const zoomOptions = [
  { key: "keep", label: "Keep zoom between rounds", keepZoom: true },
  { key: "reset", label: "Reset zoom every round", keepZoom: false },
];

export function renderSettings(container, onBack) {
  container.innerHTML = "";
  const settings = loadSettings();

  const root = document.createElement("div");
  root.className = "menu-screen wizard-screen";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "wizard-back";
  back.textContent = "← Back";
  back.addEventListener("click", onBack);
  root.appendChild(back);

  const heading = document.createElement("h1");
  heading.textContent = "Settings";
  root.appendChild(heading);

  const section = document.createElement("section");
  section.className = "menu-step";
  const label = document.createElement("h2");
  label.textContent = "Map zoom";
  section.appendChild(label);

  const list = document.createElement("div");
  list.className = "menu-options";
  const buttons = [];
  for (const option of zoomOptions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-option";
    btn.textContent = option.label;
    if (option.keepZoom === settings.keepZoom) btn.classList.add("menu-option--selected");
    btn.addEventListener("click", () => {
      for (const b of buttons) b.classList.remove("menu-option--selected");
      btn.classList.add("menu-option--selected");
      saveSettings({ ...settings, keepZoom: option.keepZoom });
    });
    buttons.push(btn);
    list.appendChild(btn);
  }
  section.appendChild(list);
  root.appendChild(section);

  container.appendChild(root);
}
