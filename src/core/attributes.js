// The attribute registry is the data-driven core of the game.
//
// Every quizzable fact about an item (a country's name, its location, its
// capital, later its flag, ...) is described here exactly once: how to show it
// as a *question* (prompt) and how to collect + check it as an *answer*.
// The menu, the round engine, and the game screen all read this registry —
// none of them know about "name" or "location" specifically, so adding a
// new attribute (e.g. "capital") never requires touching them.
//
// An attribute's `promptKind` / `answerKinds` reference a renderer/input
// widget registered in src/ui/prompts.js / src/ui/inputs.js. Multiple
// attributes can share the same widget (e.g. "name" and, later, "capital"
// both use the "text-guess" input). `answerKinds` is a list, not a single
// value, because one attribute can support more than one way to answer
// with it (typing "name" vs. multiple choice); the wizard shows a picker
// between them when there's more than one, and auto-selects the only one
// when there's just one (e.g. "location" only has "map-click").

function normalizeText(value) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const attributes = {
  name: {
    key: "name",
    label: "Name",
    canBePrompt: true,
    canBeAnswer: true,
    promptKind: "text",
    answerKinds: ["text-guess", "multiple-choice"],
    getValue: (item) => item.name,
    checkAnswer: (guess, item) => normalizeText(guess) === normalizeText(item.name),
    formatAnswer: (item) => item.name,
  },
  capital: {
    key: "capital",
    label: "Capital",
    canBePrompt: true,
    canBeAnswer: true,
    promptKind: "text",
    answerKinds: ["text-guess", "multiple-choice"],
    getValue: (item) => item.capital,
    checkAnswer: (guess, item) => normalizeText(guess) === normalizeText(item.capital),
    formatAnswer: (item) => item.capital,
  },
  location: {
    key: "location",
    label: "Location on the Map",
    canBePrompt: true,
    canBeAnswer: true,
    promptKind: "map-highlight",
    // "map-pin" (drop a pin on a borderless map, scored on which country's
    // shape it lands in) only makes sense for datasets with real
    // geographic coordinates — gameWizard.js prunes it back out for a
    // dataset using a pre-projected "identity" projection (US states),
    // where there's no lon/lat to invert a click to.
    answerKinds: ["map-click", "map-pin"],
    getValue: (item) => item.id,
    checkAnswer: (guessId, item) => guessId === item.id,
    formatAnswer: (item) => item.name,
  },
};

export function listPromptAttributes() {
  return Object.values(attributes).filter((a) => a.canBePrompt);
}

export function listAnswerAttributes(excludeKey) {
  return Object.values(attributes).filter((a) => a.canBeAnswer && a.key !== excludeKey);
}

export function resolveAttributes(keys) {
  return keys.map((key) => attributes[key]);
}

export { normalizeText };
