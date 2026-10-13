// Global settings screen, reachable from the home screen. Durable
// preferences (zoom persistence, auto next) — moved here from the old
// per-game menu step, since a Settings screen implies something durable,
// not re-asked every game.

import { loadSettings, saveSettings } from "../core/settings.js";

// Each group edits one settings key; every option carries the value it sets.
const groups = [
  {
    title: "Map zoom",
    key: "keepZoom",
    options: [
      { label: "Keep zoom between rounds", value: true },
      { label: "Reset zoom every round", value: false },
    ],
  },
  {
    title: "Auto next",
    key: "autoNextDelay",
    options: [
      { label: "Off — wait for Next", value: 0 },
      { label: "After 1 second", value: 1 },
      { label: "After 2 seconds", value: 2 },
      { label: "After 3 seconds", value: 3 },
    ],
  },
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

  for (const group of groups) {
    const section = document.createElement("section");
    section.className = "menu-step";
    const label = document.createElement("h2");
    label.textContent = group.title;
    section.appendChild(label);

    const list = document.createElement("div");
    list.className = "menu-options";
    const buttons = [];
    for (const option of group.options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "menu-option";
      btn.textContent = option.label;
      if (option.value === settings[group.key]) btn.classList.add("menu-option--selected");
      btn.addEventListener("click", () => {
        for (const b of buttons) b.classList.remove("menu-option--selected");
        btn.classList.add("menu-option--selected");
        // Re-read rather than spreading the snapshot above, or a change in
        // one group would revert an earlier change in another.
        saveSettings({ ...loadSettings(), [group.key]: option.value });
      });
      buttons.push(btn);
      list.appendChild(btn);
    }
    section.appendChild(list);
    root.appendChild(section);
  }

  container.appendChild(root);
}
