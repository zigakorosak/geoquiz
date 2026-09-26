// Answer-input widget registry, keyed by one of attribute.answerKinds (see
// core/attributes.js). Each renderer mounts its interactive input into
// `container` (which may be map-sized) and its post-confirm feedback text
// into the separate `ctx.feedbackContainer` (a slot that's never fighting
// a map for flex space — see game.js). Returns `{ cleanup, showResult,
// getTransform? }` — getTransform is only present for map-based widgets.
//
// Widgets never submit on their own — picking a value (typing, clicking a
// country) is provisional and reported via `ctx.onSelect(value | null)`.
// The game screen owns the single Confirm/Next button and calls
// `ctx.onConfirm()` on behalf of the player (or a widget may call it
// itself: pressing Enter in a text field, or clicking an already-selected
// country again, both confirm immediately). `showResult` is called once,
// after confirmation, to render right/wrong feedback.

import { WorldMap } from "../map/WorldMap.js";
import { shuffle } from "../core/engine.js";

const EARTH_RADIUS_KM = 6371;

// Great-circle distance between two `[lat, lon]` points (world-countries'
// own field order — see core/datasets.js items, `latlng`/`capitalLatLng`)
// — used only by "map-pin"'s "capital" pinTarget, to pre-check correctness
// at click time (a plain point-to-point figure is all that's needed there;
// the post-confirm feedback's own distance/reveal goes through WorldMap.js's
// revealCapitalDistance instead, which needs the map's own lon/lat
// conventions and draws the reveal, not just a number).
function haversineKm([lat1, lon1], [lat2, lon2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// How close (km) a pin has to land to a capital's own exact point to count
// as correct under "capital" pinTarget scoring — a capital is a single
// point, not a region with its own natural "am I inside it" test the way a
// country's shape gives "region" scoring for free, so this has to be some
// chosen radius. 50km is roughly a large metro area's own extent — tight
// enough to actually require knowing where the capital is (not just the
// country), generous enough not to demand pixel-perfect clicking.
const CAPITAL_CORRECT_RADIUS_KM = 50;

// A guess value guaranteed never to equal any real item id (all of which
// are ccn3 numeric strings or short hand-picked codes like "UNK"/"SML"/
// "XNC" — see core/datasets.js) — reported instead of the pin's actual
// containingId when it's the *right* country but *too far* from the
// capital under "capital" pinTarget scoring, so QuizSession's plain
// `guessId === item.id` check correctly reads it as wrong without needing
// pin-specific logic of its own.
const TOO_FAR_FROM_CAPITAL = "__too-far-from-capital__";

const renderers = {
  "multiple-choice": (container, { item, dataset, attr, optionCount, onSelect, onConfirm, feedbackContainer }) => {
    const correctValue = attr.getValue(item);
    const distractorPool = dataset.items.filter((i) => i !== item);
    const distractorCount = Math.min((optionCount ?? 4) - 1, distractorPool.length);
    const values = shuffle([correctValue, ...shuffle(distractorPool).slice(0, distractorCount).map((i) => attr.getValue(i))]);

    const list = document.createElement("div");
    list.className = "menu-options multiple-choice-options";

    // Locked (not the native `disabled` attribute) once a result is shown:
    // a disabled element never dispatches a click event at all, which
    // would silently swallow the "click anywhere advances" behavior for
    // anyone who clicks directly on one of these buttons afterward,
    // instead of clicking elsewhere. Locking is just a flag the click
    // handler checks itself, so the click still fires and bubbles to
    // game.js's root listener exactly like clicking empty space does.
    let selectedValue = null;
    let locked = false;
    const buttons = new Map(); // value -> button
    for (const value of values) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "menu-option";
      btn.textContent = value;
      btn.addEventListener("click", () => {
        if (locked) return;
        if (value === selectedValue) {
          onConfirm();
          return;
        }
        selectedValue = value;
        for (const b of buttons.values()) b.classList.remove("menu-option--selected");
        btn.classList.add("menu-option--selected");
        onSelect(value);
      });
      buttons.set(value, btn);
      list.appendChild(btn);
    }
    container.appendChild(list);

    const feedback = document.createElement("div");
    feedback.className = "answer-feedback";
    feedbackContainer.appendChild(feedback);

    return {
      cleanup: () => {
        list.remove();
        feedback.remove();
      },
      showResult({ correct, item, guess }) {
        locked = true;
        for (const [value, b] of buttons) {
          b.classList.add("menu-option--locked");
          if (value === correctValue) b.classList.add("menu-option--correct");
          else if (value === guess) b.classList.add("menu-option--wrong");
        }
        feedback.textContent = correct ? "Correct!" : `Correct answer: ${attr.formatAnswer(item)}`;
      },
    };
  },

  "text-guess": (container, { dataset, attr, onSelect, onConfirm, feedbackContainer }) => {
    const form = document.createElement("form");
    form.className = "answer-text-form";

    const listId = "answer-options";
    const datalist = document.createElement("datalist");
    datalist.id = listId;
    for (const item of dataset.items) {
      const option = document.createElement("option");
      option.value = attr.getValue(item);
      datalist.appendChild(option);
    }

    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("list", listId);
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("spellcheck", "false");
    input.placeholder = `Type the ${attr.label.toLowerCase()}...`;

    const feedback = document.createElement("div");
    feedback.className = "answer-feedback";

    form.append(input, datalist);
    container.appendChild(form);
    feedbackContainer.appendChild(feedback);
    input.addEventListener("input", () => {
      onSelect(input.value.trim() ? input.value : null);
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      onSelect(input.value);
      onConfirm();
    });

    input.focus();

    return {
      cleanup: () => {
        form.remove();
        feedback.remove();
      },
      showResult({ correct, item }) {
        // readOnly, not disabled — a disabled input never dispatches a
        // click event, which would swallow "click anywhere advances" for
        // anyone who clicks directly on the input afterward (see the
        // matching comment in the multiple-choice renderer above).
        input.readOnly = true;
        input.classList.add(correct ? "input--correct" : "input--wrong");
        feedback.textContent = correct
          ? "Correct!"
          : `Correct answer: ${attr.formatAnswer(item)}`;
      },
    };
  },

  "map-click": (
    container,
    { dataset, attr, focusIds, playableIds, initialTransform, onSelect, onConfirm, feedbackContainer }
  ) => {
    const map = new WorldMap(container, {
      topology: dataset.topology,
      objectKey: dataset.topologyObject,
      focusIds,
      playableIds,
      dashedBorders: dataset.dashedBorders,
      projection: dataset.projection,
      initialTransform,
    });
    let selectedId = null;
    map.setClickable(true, (id) => {
      if (id === selectedId) {
        onConfirm();
        return;
      }
      selectedId = id;
      map.select(id);
      onSelect(id);
    });

    const feedback = document.createElement("div");
    feedback.className = "answer-feedback";
    feedbackContainer.appendChild(feedback);

    return {
      cleanup: () => {
        map.destroy();
        feedback.remove();
      },
      getTransform: () => map.getTransform(),
      showResult({ guess, item, correct }) {
        map.setClickable(false, null);
        map.markResult(guess, attr.getValue(item));
        if (correct) {
          feedback.textContent = "Correct!";
        } else {
          const guessedName = dataset.items.find((i) => i.id === guess)?.name ?? "an unrecognized area";
          feedback.textContent = `You picked ${guessedName} — correct answer: ${attr.formatAnswer(item)}`;
        }
      },
    };
  },

  // Borderless map: the player drops a pin anywhere rather than clicking a
  // discrete country shape. `pinTarget` (gameWizard.js's follow-up step,
  // "region" or "capital" — defaulting to "region" if ever omitted) decides
  // what the guess is actually scored against:
  //  - "region": the guess reported via onSelect is a country id, same as
  //    "map-click" — whichever playable country's real (invisible) shape
  //    the pin landed inside, or null over open ocean/unplayable territory
  //    — so QuizSession/attributes.js's plain id-equality checkAnswer needs
  //    no pin-specific logic at all.
  //  - "capital": correctness isn't about which country's shape the pin
  //    fell inside at all, but whether it's within CAPITAL_CORRECT_RADIUS_KM
  //    of the target's own exact capital point. To reuse that same
  //    id-equality checkAnswer unchanged, the guess reported is *item.id*
  //    itself when within radius (forcing a match) or a guaranteed-never-
  //    equal sentinel otherwise (forcing a mismatch) — never `null` for a
  //    real, definite miss, since `null` specifically means "no selection
  //    yet" elsewhere (game.js disables Confirm while `selection == null`),
  //    and a pin that's simply too far from the capital is still a
  //    complete, confirmable answer, not a pending one.
  "map-pin": (
    container,
    { item, dataset, attr, focusIds, playableIds, pinTarget, initialTransform, onSelect, onConfirm, feedbackContainer }
  ) => {
    const target = pinTarget ?? "region";
    const map = new WorldMap(container, {
      topology: dataset.topology,
      objectKey: dataset.topologyObject,
      focusIds,
      playableIds,
      projection: dataset.projection,
      initialTransform,
      pinMode: true,
    });
    map.setClickable(
      true,
      (lon, lat, containingId) => {
        if (target === "capital" && item.capitalLatLng) {
          const distanceKm = haversineKm([lat, lon], item.capitalLatLng);
          const withinRadius = distanceKm <= CAPITAL_CORRECT_RADIUS_KM;
          onSelect(withinRadius ? item.id : containingId === item.id ? TOO_FAR_FROM_CAPITAL : containingId);
        } else {
          onSelect(containingId);
        }
      },
      // Clicking the just-dropped pin itself (its own padded hit-area, not
      // just anywhere on the map) confirms immediately — the pin-mode
      // equivalent of map-click/multiple-choice's reclick-to-confirm.
      onConfirm
    );

    const feedback = document.createElement("div");
    feedback.className = "answer-feedback";
    feedbackContainer.appendChild(feedback);

    return {
      cleanup: () => {
        map.destroy();
        feedback.remove();
      },
      getTransform: () => map.getTransform(),
      showResult({ item, correct }) {
        map.setClickable(false, null);
        // Always null guessId: unlike map-click, pin mode never reveals
        // the country the pin actually landed in when wrong — only ever
        // the target's own shape. Revealing "here's the real country you
        // were standing in" would give away exactly the kind of shape
        // information a borderless map exists to withhold.
        map.markResult(null, attr.getValue(item));
        // revealBorderDistance/revealCapitalDistance both compute the km
        // figure below *and* draw the reveal on the map itself —
        // revealBorderDistance shows 0/no line whenever the pin already
        // landed inside the target's own shape (always true for a correct
        // guess under "region" scoring, by definition); revealCapitalDistance
        // always shows the capital's own point + a line to it, correct or
        // not, since the precise distance is worth seeing either way.
        const rawDistance =
          target === "capital" ? map.revealCapitalDistance(item.capitalLatLng) : map.revealBorderDistance(attr.getValue(item));
        const distance = rawDistance != null ? Math.round(rawDistance) : null;
        const distanceLabel = target === "capital" ? "the capital" : "its border";
        const distanceText = distance != null ? ` You were ${distance} km from ${distanceLabel}.` : "";
        feedback.textContent = correct ? `Correct!${distanceText}` : `Correct answer: ${attr.formatAnswer(item)}.${distanceText}`;
      },
    };
  },
};

export function renderAnswerInput(container, kind, ctx) {
  const renderer = renderers[kind];
  if (!renderer) throw new Error(`Unknown answer kind: ${kind}`);
  container.innerHTML = "";
  return renderer(container, ctx);
}
