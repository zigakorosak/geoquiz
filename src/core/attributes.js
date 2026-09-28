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
  currency: {
    key: "currency",
    label: "Currency",
    canBePrompt: true,
    canBeAnswer: true,
    promptKind: "text",
    answerKinds: ["text-guess", "multiple-choice"],
    getValue: (item) => item.currency,
    checkAnswer: (guess, item) => normalizeText(guess) === normalizeText(item.currency),
    formatAnswer: (item) => item.currency,
  },
  // The broad continent (world-countries' own `region` — "Europe",
  // "Africa", "Americas", "Asia", "Oceania", "Antarctic"), not the finer
  // `subregion` ("Western Europe" etc.) core/regions.js's own region
  // *filter* step matches against — a distinct concept from that step
  // despite the shared name: this is a quizzable fact about one item
  // ("what continent is Peru in"), that step is which items are in play
  // at all. Every item has one (unlike capital/currency/flag/emblem, no
  // gaps to worry about), so its widgets are the simplest here: reuses
  // text/text-guess/multiple-choice wholesale, same as currency.
  //
  // A question attribute's value doesn't have to pin down one exact item
  // for every possible *answer* to make sense of it — it only has to for
  // whichever answer is actually paired with it. Region genuinely doesn't
  // identify one country (only 6 values shared across all 238 — Africa
  // alone covers 58), so "Europe — pick its flag" has no well-defined
  // correct picture and "Europe — pick its capital" has no well-defined
  // correct one either; but "Europe — name a country here" (typed/
  // multiple-choice) or "Europe — click it on the map" are both perfectly
  // fine, coarser-grained questions that were never claiming to identify
  // a specific country in the first place. So the fix isn't disallowing
  // region as a question (tried that; overcorrected — it disallowed the
  // fine pairings along with the broken one) — it's `gameWizard.js`'s
  // `answerAttributesFor` excluding specifically `flag`/`emblem` as
  // *answers* to a `region` question, leaving every other pairing (in
  // both directions) alone.
  region: {
    key: "region",
    label: "Region",
    canBePrompt: true,
    canBeAnswer: true,
    promptKind: "text",
    // "map-region-click" (inputs.js) is location's map-click widget with a
    // coarser correctness check: click any country, and it's right iff
    // *that country's own region* matches the target's — not "the same
    // country", the way map-click's location check works. Reports the
    // clicked country's region string via onSelect, so it reuses this
    // attribute's own checkAnswer unchanged (string comparison, exactly
    // like text-guess/multiple-choice's guesses already go through).
    answerKinds: ["text-guess", "multiple-choice", "map-region-click"],
    getValue: (item) => item.region,
    checkAnswer: (guess, item) => normalizeText(guess) === normalizeText(item.region),
    formatAnswer: (item) => item.region,
  },
  // flag/emblem share everything but which URL field they read and their
  // label — both are "show a picture, name (or pick) the country" facts,
  // never typeable, so their only answerKind is "picture-choice" (a new
  // image-grid input, inputs.js) rather than text-guess/multiple-choice.
  // Correctness is checked by *item identity* (`guessId === item.id`),
  // the same as "location" — not by the URL string — since the thing
  // being asked is fundamentally "which country is this", regardless of
  // which fact (shape, flag, emblem) was used to ask it.
  flag: {
    key: "flag",
    label: "Flag",
    canBePrompt: true,
    canBeAnswer: true,
    promptKind: "image",
    answerKinds: ["picture-choice"],
    getValue: (item) => item.flagUrl,
    checkAnswer: (guessId, item) => guessId === item.id,
    formatAnswer: (item) => item.name,
  },
  emblem: {
    key: "emblem",
    label: "Emblem",
    canBePrompt: true,
    canBeAnswer: true,
    promptKind: "image",
    answerKinds: ["picture-choice"],
    getValue: (item) => item.emblemUrl,
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
