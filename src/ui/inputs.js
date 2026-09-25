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
    { dataset, attr, mapFeatureIds, playableIds, initialTransform, onSelect, onConfirm, feedbackContainer }
  ) => {
    const map = new WorldMap(container, {
      topology: dataset.topology,
      objectKey: dataset.topologyObject,
      filterIds: mapFeatureIds,
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
  // discrete country shape. The guess reported via onSelect is still just
  // a country id, same as "map-click" — whichever playable country's real
  // (invisible) shape the pin landed inside, or null over open
  // ocean/unplayable territory — so QuizSession/attributes.js need no
  // pin-specific logic at all; only the feedback (revealed outline +
  // distance) is different, handled entirely here.
  "map-pin": (
    container,
    { dataset, attr, mapFeatureIds, playableIds, initialTransform, onSelect, feedbackContainer }
  ) => {
    const map = new WorldMap(container, {
      topology: dataset.topology,
      objectKey: dataset.topologyObject,
      filterIds: mapFeatureIds,
      playableIds,
      projection: dataset.projection,
      initialTransform,
      pinMode: true,
    });
    let lastLon = null;
    let lastLat = null;
    map.setClickable(true, (lon, lat, containingId) => {
      lastLon = lon;
      lastLat = lat;
      onSelect(containingId);
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
        // 0 whenever the pin already landed inside the target's own shape
        // (distanceToBorderKm's own inside check) — a correct guess is
        // always exactly this case, but a wrong guess can be too, in the
        // (borderless-map, so invisible at guess time) gap between two
        // features' hulls never actually landing outside either one.
        const rawDistance = lastLon != null && lastLat != null ? map.distanceToBorderKm(lastLon, lastLat, attr.getValue(item)) : null;
        const distance = rawDistance != null ? Math.round(rawDistance) : null;
        const distanceText = distance != null ? ` You were ${distance} km from its border.` : "";
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
