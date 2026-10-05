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
// NOTE the [lat, lon] argument order — the opposite of WorldMap.js's own
// (module-private) haversine, which takes [lon, lat] to match d3's
// convention. The name spells the order out so the two can never be
// confused at a call site.
function haversineKmLatLon([lat1, lon1], [lat2, lon2]) {
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
// Region-scored pins count as correct within this many km of the target's
// border, not only strictly inside it. Borderless mode never draws a
// microstate as its own shape, and Monaco/Vatican/San Marino/the small
// Caribbean islands are a few km across — a pixel-exact fingertip target
// even fully zoomed in, so they were effectively unanswerable. Same idea
// as CAPITAL_CORRECT_RADIUS_KM, deliberately tighter: for a normal-sized
// country it only forgives a pin landing just over the border.
const REGION_BORDER_TOLERANCE_KM = 20;

// A guess value guaranteed never to equal any real item id (all of which
// are ccn3 numeric strings or short hand-picked codes like "UNK"/"SML"/
// "XNC" — see core/datasets.js) — reported instead of the pin's actual
// containingId when it's the *right* country but *too far* from the
// capital under "capital" pinTarget scoring, so QuizSession's plain
// `guessId === item.id` check correctly reads it as wrong without needing
// pin-specific logic of its own.
const TOO_FAR_FROM_CAPITAL = "__too-far-from-capital__";

let textGuessInstanceCounter = 0;

const renderers = {
  "multiple-choice": (container, { item, dataset, attr, questionAttr, optionCount, onSelect, onConfirm, feedbackContainer }) => {
    const correctValue = attr.getValue(item);
    // A non-identifying question value (region "Europe", currency "Euro")
    // is consistent with many items, and the engine (QuizSession) accepts
    // an answer matching ANY of them — so no item consistent with the
    // shown question value may appear as a distractor, or the round would
    // offer several "correct" options while styling only one as such.
    // For an identifying question this excludes nothing beyond the target.
    const questionValue = questionAttr?.getValue(item);
    // Deduplicated by *value*, not just by item: two different countries
    // can share the exact same currency name (a whole Eurozone's worth all
    // read "Euro") — sampling distractors by item alone would happily
    // offer "Euro" twice, both a visually confusing duplicate option and,
    // since `buttons` below is itself keyed by value, one silently
    // unstyled at result time (whichever registered second would overwrite
    // the first's entry). Same distinct-value pool as showResult's own
    // `guess === value` / `correctValue === value` comparisons rely on.
    const seenValues = new Set([correctValue]);
    const distractorValues = [];
    for (const candidate of shuffle(dataset.items.filter((i) => i !== item))) {
      if (distractorValues.length >= (optionCount ?? 4) - 1) break;
      const value = attr.getValue(candidate);
      if (value == null || seenValues.has(value)) continue;
      if (questionAttr && questionAttr.getValue(candidate) === questionValue) continue;
      seenValues.add(value);
      distractorValues.push(value);
    }
    const values = shuffle([correctValue, ...distractorValues]);

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
      showResult({ correct, item, guess, ambiguous }) {
        locked = true;
        for (const [value, b] of buttons) {
          b.classList.add("menu-option--locked");
          if (value === correctValue) b.classList.add("menu-option--correct");
          else if (value === guess) b.classList.add("menu-option--wrong");
        }
        feedback.textContent = correct ? "Correct!" : `Correct answer: ${ambiguous ? "e.g. " : ""}${attr.formatAnswer(item)}`;
      },
    };
  },

  // flag/emblem's answerKind (core/attributes.js) — the image-grid analog
  // of "multiple-choice" above. Options are *items*, not raw values (a
  // flag/emblem URL isn't something the player is choosing between in any
  // meaningful sense — they're choosing a country, which happens to be
  // pictured by it), so the guess reported is the picked option's own id,
  // matching how "location"'s map-click already works. No value-collision
  // risk here the way multiple-choice's text values have (see there): a
  // real flag/emblem image is 1:1 with its country by construction, so
  // distractors are sampled by item alone, same as "location" would be.
  "picture-choice": (container, { item, dataset, attr, questionAttr, optionCount, onSelect, onConfirm, feedbackContainer }) => {
    // Same consistent-with-the-question exclusion as multiple-choice above
    // (today every pairing that reaches picture-choice has an identifying
    // question, so this excludes nothing — kept so a future non-identifying
    // pairing can't silently offer two "correct" pictures).
    const questionValue = questionAttr?.getValue(item);
    const distractorPool = shuffle(
      dataset.items.filter((i) => i !== item && !(questionAttr && questionAttr.getValue(i) === questionValue))
    );
    const distractorCount = Math.min((optionCount ?? 4) - 1, distractorPool.length);
    const options = shuffle([item, ...distractorPool.slice(0, distractorCount)]);

    const list = document.createElement("div");
    list.className = "menu-options picture-choice-options";

    // Same locked-not-disabled reasoning as multiple-choice above.
    let selectedId = null;
    let locked = false;
    const buttons = new Map(); // item.id -> button
    for (const option of options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "menu-option menu-option--picture";
      const img = document.createElement("img");
      img.src = `${import.meta.env?.BASE_URL ?? "/"}${attr.getValue(option)}`;
      img.alt = ""; // decorative — naming it would hand the answer to anyone using a screen reader
      btn.appendChild(img);
      btn.addEventListener("click", () => {
        if (locked) return;
        if (option.id === selectedId) {
          onConfirm();
          return;
        }
        selectedId = option.id;
        for (const b of buttons.values()) b.classList.remove("menu-option--selected");
        btn.classList.add("menu-option--selected");
        onSelect(option.id);
      });
      buttons.set(option.id, btn);
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
      showResult({ correct, item, guess, ambiguous }) {
        locked = true;
        for (const [id, b] of buttons) {
          b.classList.add("menu-option--locked");
          if (id === item.id) b.classList.add("menu-option--correct");
          else if (id === guess) b.classList.add("menu-option--wrong");
        }
        feedback.textContent = correct ? "Correct!" : `Correct answer: ${ambiguous ? "e.g. " : ""}${attr.formatAnswer(item)}`;
      },
    };
  },

  "text-guess": (container, { dataset, attr, onSelect, onConfirm, feedbackContainer }) => {
    const form = document.createElement("form");
    form.className = "answer-text-form";

    // Instance-scoped id (not a static string) — the only hardcoded DOM id
    // in the widget layer otherwise, and WorldMap.js already namespaces
    // all of its own ids per instance for the same reason.
    const listId = `answer-options-${textGuessInstanceCounter++}`;
    const datalist = document.createElement("datalist");
    datalist.id = listId;
    // Deduplicated by value: many items share one value for some
    // attributes (a whole Eurozone's worth of "Euro"; six region names
    // across ~235 countries), and one <option> per *item* filled the
    // autocomplete dropdown with dozens of identical entries.
    const seenValues = new Set();
    for (const item of dataset.items) {
      const value = attr.getValue(item);
      if (value == null || seenValues.has(value)) continue;
      seenValues.add(value);
      const option = document.createElement("option");
      option.value = value;
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
      showResult({ correct, item, ambiguous }) {
        // readOnly, not disabled — a disabled input never dispatches a
        // click event, which would swallow "click anywhere advances" for
        // anyone who clicks directly on the input afterward (see the
        // matching comment in the multiple-choice renderer above).
        input.readOnly = true;
        input.classList.add(correct ? "input--correct" : "input--wrong");
        feedback.textContent = correct
          ? "Correct!"
          : `Correct answer: ${ambiguous ? "e.g. " : ""}${attr.formatAnswer(item)}`;
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
      showResult({ guess, item, correct, ambiguous }) {
        map.setClickable(false, null);
        // A non-identifying question ("Europe — click a country there")
        // can be answered correctly by clicking an item other than the
        // sampled one (see QuizSession's consistent-set check) — mark the
        // country actually clicked as correct in that case, rather than
        // painting it wrong and revealing the sampled one as if the guess
        // had missed. For an identifying question, correct implies
        // guess === the target's own id, so this changes nothing there.
        map.markResult(guess, correct ? guess : attr.getValue(item));
        if (correct) {
          feedback.textContent = "Correct!";
        } else {
          const guessedName = dataset.items.find((i) => i.id === guess)?.name ?? "an unrecognized area";
          feedback.textContent = `You picked ${guessedName} — correct answer: ${ambiguous ? "e.g. " : ""}${attr.formatAnswer(item)}`;
        }
      },
    };
  },

  // `region`'s map-based answer (attributes.js) — map-click's country
  // *picker* with a region-scale *checker*: click any country, and the
  // guess reported is that country's own region (via `attr.getValue`, the
  // same field this attribute's text-guess/multiple-choice guesses are
  // already compared against) rather than the clicked country's id — so
  // clicking any country in the right continent counts as correct, not
  // only one specific one, and `checkAnswer` needs no changes at all to
  // handle that: it was always a plain string comparison.
  //
  // The reveal reuses `markResult(guessId, correctId)` with a choice of
  // arguments that makes its id-equality coloring do the right thing for
  // a *region* match instead of an *item* match: passing the clicked id
  // for both arguments when correct marks only what was actually clicked,
  // in the "correct" color; passing the clicked id against the target's
  // own id when wrong marks the click "wrong" and additionally reveals
  // the target's own specific country as one concrete example of what
  // *would* have been right — not the only one, which the feedback text
  // says explicitly, since a single highlighted country can't represent
  // "any of Europe's 52 countries" by itself.
  "map-region-click": (
    container,
    { item, dataset, attr, focusIds, playableIds, initialTransform, onSelect, onConfirm, feedbackContainer }
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
    const byId = new Map(dataset.items.map((i) => [i.id, i]));
    let selectedId = null;
    map.setClickable(true, (id) => {
      if (id === selectedId) {
        onConfirm();
        return;
      }
      selectedId = id;
      map.select(id);
      onSelect(attr.getValue(byId.get(id)));
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
      showResult({ correct }) {
        map.setClickable(false, null);
        map.markResult(selectedId, correct ? selectedId : item.id);
        const clicked = byId.get(selectedId);
        if (correct) {
          feedback.textContent = `Correct! (${clicked?.name} is in ${attr.formatAnswer(item)})`;
        } else {
          feedback.textContent = `Correct answer: ${attr.formatAnswer(item)} (e.g. ${item.name}) — you picked ${clicked?.name ?? "an unrecognized area"}, in ${clicked ? attr.getValue(clicked) : "no region"}`;
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
          const distanceKm = haversineKmLatLon([lat, lon], item.capitalLatLng);
          const withinRadius = distanceKm <= CAPITAL_CORRECT_RADIUS_KM;
          onSelect(withinRadius ? item.id : containingId === item.id ? TOO_FAR_FROM_CAPITAL : containingId);
        } else {
          // Target-aware tolerance (see REGION_BORDER_TOLERANCE_KM): a pin
          // just outside the target's border reports the target itself, so
          // the plain id-equality checkAnswer scores it correct. Anything
          // else reports whatever shape the pin actually landed in.
          const d = containingId === item.id ? 0 : map.borderDistanceKm(item.id, lon, lat);
          onSelect(d != null && d <= REGION_BORDER_TOLERANCE_KM ? item.id : containingId);
        }
      },
      // Clicking close enough to the just-dropped pin confirms immediately
      // (WorldMap's whole-map listener does the distance check — there is
      // no clickable overlay element) — the pin-mode equivalent of
      // map-click/multiple-choice's reclick-to-confirm.
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
