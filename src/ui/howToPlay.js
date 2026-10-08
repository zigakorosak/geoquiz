// "How to Play" screen, reachable from the home screen: a short, static
// guide to the games, the answer types, the map controls and the Map
// explorer. Same page shell as Settings (menu-screen + Back). Keep it in
// step with the real labels — answer types are named exactly as the games
// wizard shows them (gameWizard.js's answerKindLabels).

const sections = [
  {
    title: "Playing a game",
    items: [
      "Games → pick a subject (Countries, Capitals, Flags, Emblems or Currencies).",
      "Choose what you're shown, how you'll answer, and which part of the world to play.",
      "Under America you'll also find US States, and under Asia the provinces of China.",
      "Pick your answer, then press Confirm — or tap your choice again to confirm it.",
      "After each answer, press Next or tap anywhere to move on.",
    ],
  },
  {
    title: "Ways to answer",
    items: [
      "Type it — type the name; capitals and accents don't matter.",
      "Multiple choice / Pick the picture — choose one of the options.",
      "Click it on the map — tap the right country, state or province.",
      "Click its region — tap any country on the right continent.",
      "Drop a pin — no borders shown; drop a pin where it is. Scored by Region (inside it, or within 20 km of its border) or by Capital (within 50 km of the capital). You'll see how far off you were.",
    ],
  },
  {
    title: "Using the map",
    items: [
      "Drag to move; pinch or scroll to zoom.",
      "Tiny countries and islands have a larger tap area around them, so you don't have to hit them exactly.",
      "☰ (top right) has Restart, Back (to the previous setup step) and Home.",
    ],
  },
  {
    title: "Exploring",
    items: [
      "Map → pick World, USA or China, then tap anywhere to see its name, capital and more.",
      "Random jumps to a random country, state or province.",
    ],
  },
  {
    title: "Settings",
    items: ["Choose whether the map keeps its zoom between rounds or resets every round."],
  },
];

export function renderHowToPlay(container, onBack) {
  container.innerHTML = "";

  const root = document.createElement("div");
  root.className = "menu-screen wizard-screen how-to-play";

  const back = document.createElement("button");
  back.type = "button";
  back.className = "wizard-back";
  back.textContent = "← Back";
  back.addEventListener("click", onBack);
  root.appendChild(back);

  const heading = document.createElement("h1");
  heading.textContent = "How to Play";
  root.appendChild(heading);

  for (const { title, items } of sections) {
    const section = document.createElement("section");
    section.className = "menu-step";
    const h2 = document.createElement("h2");
    h2.textContent = title;
    const list = document.createElement("ul");
    for (const text of items) {
      const li = document.createElement("li");
      li.textContent = text;
      list.appendChild(li);
    }
    section.append(h2, list);
    root.appendChild(section);
  }

  container.appendChild(root);
}
