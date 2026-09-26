// The "Games" flow from the home screen: a sequence of full-screen
// choices — subject -> question type -> answer type [-> how to answer,
// if that attribute supports more than one way -> how many options, if
// multiple choice] -> region [-> a sub-region for Africa/America] ->
// sovereignty — that ends by loading the chosen subject's data and
// handing off to game.js.
//
// Back-navigation uses continuation-passing rather than a history stack:
// each step, when advancing to the next one, passes a `goBack` closure
// that simply re-renders the step you're currently on (with the same
// config, so nothing already chosen is lost). Simple and doesn't need any
// shared router state.
//
// Subject is asked *before* question/answer type specifically so those
// two steps can be scoped to the chosen subject's own `attributeKeys`
// (via `resolveAttributes`) rather than the global attribute registry —
// a subject with a narrower or different attribute set just sees fewer/
// different options, no special-casing needed elsewhere in the wizard.

import { resolveAttributes } from "../core/attributes.js";
import { subjects } from "../core/subjects.js";
import { datasetMeta, loadDataset } from "../core/datasets.js";
import { regions, getRegion } from "../core/regions.js";
import { sovereigntyOptions } from "../core/sovereignty.js";
import { loadSettings } from "../core/settings.js";
import { renderChoiceScreen } from "./screenKit.js";
import { renderGame } from "./game.js";

// A subject's own attributeKeys (see subjects.js) take priority over its
// dataset's full list — this is what lets Countries and Capitals share
// one dataset/fetch but still read as two separate games, each scoped to
// its own pair of attributes rather than offering every fact at once.
function promptAttributesFor(config) {
  return resolveAttributes(config.subject.attributeKeys ?? config.meta.attributeKeys).filter((a) => a.canBePrompt);
}

function answerAttributesFor(config, excludeKey) {
  return resolveAttributes(config.subject.attributeKeys ?? config.meta.attributeKeys).filter(
    (a) => a.canBeAnswer && a.key !== excludeKey
  );
}

// Not every item necessarily has a value for every attribute (a few
// countries have no recorded capital — Antarctica, Macau, ...; District
// of Columbia has no state capital of its own, being a federal district
// rather than a state) — an item missing a value for the chosen question
// or answer attribute isn't a fair round to include. Applied to the final
// playable item set (see startGame) and to the region/sovereignty step
// counts so the number shown there matches what the player actually gets
// — never to `regionItems` itself (used for the map's hard crop in
// game.js), so an excluded item still renders muted rather than leaving a
// hole, the same as a sovereignty-excluded one does.
function isAskable(item, questionAttr, answerAttr) {
  return questionAttr.getValue(item) != null && answerAttr.getValue(item) != null;
}

export function startGameWizard(container, onExit) {
  showSubjectStep(container, {}, onExit, onExit);
}

function showSubjectStep(container, config, goBack, onExit) {
  renderChoiceScreen(container, {
    title: "Choose a subject",
    options: subjects,
    labelFn: (s) => s.label,
    disabledFn: (s) => !s.available,
    descFn: (s) => (s.available ? null : "Coming soon"),
    onPick: (s) => {
      const meta = datasetMeta[s.datasetKey];
      showQuestionStep(container, { ...config, subject: s, meta }, () => showSubjectStep(container, config, goBack, onExit), onExit);
    },
    onBack: goBack,
  });
}

function showQuestionStep(container, config, goBack, onExit) {
  renderChoiceScreen(container, {
    title: "What should we show you?",
    options: promptAttributesFor(config),
    labelFn: (a) => a.label,
    onPick: (a) =>
      showAnswerStep(container, { ...config, questionAttr: a }, () => showQuestionStep(container, config, goBack, onExit), onExit),
    onBack: goBack,
  });
}

function showAnswerStep(container, config, goBack, onExit) {
  renderChoiceScreen(container, {
    title: "How do you want to answer?",
    options: answerAttributesFor(config, config.questionAttr.key),
    labelFn: (a) => a.label,
    onPick: (a) => {
      const stepBack = () => showAnswerStep(container, config, goBack, onExit);
      goToAnswerKindOrSkip(container, { ...config, answerAttr: a }, stepBack, onExit);
    },
    onBack: goBack,
  });
}

// A widget-input style, not a fact about the attribute, so its display
// labels live here rather than in attributes.js.
const answerKindLabels = {
  "text-guess": "Type it",
  "multiple-choice": "Multiple choice",
  "map-click": "Select region",
  "map-pin": "Drop a pin",
};

function availableAnswerKinds(config) {
  // "map-pin" needs a real lon/lat to invert a click to and score a
  // distance from — meaningless for a dataset using a pre-projected
  // "identity" projection (US states), so it's pruned out here rather
  // than never having been declared on the "location" attribute at all;
  // attributes.js stays dataset-agnostic, datasetMeta.projection is
  // already the signal that distinguishes the two cases.
  return config.answerAttr.answerKinds.filter((k) => k !== "map-pin" || config.meta.projection !== "identity");
}

function goToAnswerKindOrSkip(container, config, goBack, onExit) {
  const kinds = availableAnswerKinds(config);
  if (kinds.length > 1) {
    showAnswerKindStep(container, config, goBack, onExit);
  } else {
    goToRegionOrSkip(container, { ...config, answerKind: kinds[0] }, goBack, onExit);
  }
}

function showAnswerKindStep(container, config, goBack, onExit) {
  renderChoiceScreen(container, {
    title: `How do you want to answer with the ${config.answerAttr.label.toLowerCase()}?`,
    options: availableAnswerKinds(config),
    labelFn: (k) => answerKindLabels[k] ?? k,
    onPick: (k) => {
      const stepBack = () => showAnswerKindStep(container, config, goBack, onExit);
      if (k === "multiple-choice") {
        showOptionCountStep(container, { ...config, answerKind: k }, stepBack, onExit);
      } else if (k === "map-pin") {
        showPinTargetStep(container, { ...config, answerKind: k }, stepBack, onExit);
      } else {
        goToRegionOrSkip(container, { ...config, answerKind: k }, stepBack, onExit);
      }
    },
    onBack: goBack,
  });
}

const OPTION_COUNTS = [2, 3, 4, 5, 6];

function showOptionCountStep(container, config, goBack, onExit) {
  renderChoiceScreen(container, {
    title: "How many options?",
    options: OPTION_COUNTS,
    labelFn: (n) => String(n),
    onPick: (n) =>
      goToRegionOrSkip(container, { ...config, optionCount: n }, () => showOptionCountStep(container, config, goBack, onExit), onExit),
    onBack: goBack,
  });
}

// Follow-up step specific to "map-pin" (parallel to showOptionCountStep for
// multiple-choice): what counts as a correct pin drop, and what the
// post-confirm distance figure/reveal measures against. "region" (the
// original, default behavior) scores against the target's own shape — 0km
// if the pin landed anywhere inside it, otherwise distance to its nearest
// border. "capital" scores against the target's exact capital point
// instead — correct only within CAPITAL_CORRECT_RADIUS_KM of it (see
// inputs.js), with the distance/reveal measured to that point rather than
// the border. Independent of subject: whether the round's question was the
// country's name or its capital's name, the pinned target is the same
// item either way, just scored differently.
const PIN_TARGETS = ["region", "capital"];
const pinTargetLabels = {
  region: "Region",
  capital: "Capital",
};

function showPinTargetStep(container, config, goBack, onExit) {
  renderChoiceScreen(container, {
    title: "Score the pin against the region, or the capital?",
    options: PIN_TARGETS,
    labelFn: (t) => pinTargetLabels[t],
    onPick: (t) =>
      goToRegionOrSkip(container, { ...config, pinTarget: t }, () => showPinTargetStep(container, config, goBack, onExit), onExit),
    onBack: goBack,
  });
}

// Item count a region option would leave you with, for the "All (236)"-
// style label — null (no count shown) for an option that switches to a
// different dataset entirely (Caribbean's "US States" sibling), since
// there's no meaningful shared count against the currently-loaded items.
// A branch region (Africa, America — no `match` of its own, only
// children) counts everything any of its children would. Also excludes
// items that wouldn't actually be askable with the chosen question/answer
// attributes (see isAskable) so the number shown matches what the player
// will actually get.
function regionCount(config, region) {
  const items = config.loadedItems;
  if (!items || region.datasetKey) return null;
  const matched = region.match
    ? items.filter(region.match)
    : region.children
    ? items.filter((item) => region.children.some((c) => c.match?.(item)))
    : null;
  if (!matched) return null;
  return matched.filter((item) => isAskable(item, config.questionAttr, config.answerAttr)).length;
}

function withCount(label, count) {
  return count == null ? label : `${label} (${count})`;
}

function showLoadError(container, onExit) {
  renderChoiceScreen(container, {
    title: "Could not load game data.",
    subtitle: "Check your connection and try again.",
    options: [{ key: "home", label: "Back to Home" }],
    labelFn: (o) => o.label,
    onPick: () => onExit(),
  });
}

async function goToRegionOrSkip(container, config, goBack, onExit) {
  if (!config.meta.supportsRegionFilter && !config.meta.supportsSovereigntyFilter) {
    goToSovereigntyOrSkip(container, { ...config, region: getRegion("world") }, goBack, onExit);
    return;
  }
  // Loaded here rather than at the very end (startGame) specifically so
  // the region/sovereignty steps below can show each option's actual
  // item count ("All (236)") — both need the real item list, not just
  // the dataset's static meta.
  container.innerHTML = '<div class="menu-screen wizard-screen"><h1>Loading…</h1></div>';
  let loaded;
  try {
    loaded = await loadDataset(config.subject.datasetKey);
  } catch (err) {
    console.error(err);
    showLoadError(container, onExit);
    return;
  }
  const nextConfig = { ...config, loadedItems: loaded.items };
  if (config.meta.supportsRegionFilter) {
    showRegionStep(container, nextConfig, goBack, onExit);
  } else {
    goToSovereigntyOrSkip(container, { ...nextConfig, region: getRegion("world") }, goBack, onExit);
  }
}

function showRegionStep(container, config, goBack, onExit) {
  renderChoiceScreen(container, {
    title: "Choose a map",
    options: regions,
    labelFn: (r) => withCount(r.label, regionCount(config, r)),
    onPick: (r) => {
      const stepBack = () => showRegionStep(container, config, goBack, onExit);
      if (r.children) {
        showSubRegionStep(container, { ...config, regionParent: r }, stepBack, onExit);
      } else {
        goToSovereigntyOrSkip(container, { ...config, region: r }, stepBack, onExit);
      }
    },
    onBack: goBack,
  });
}

function showSubRegionStep(container, config, goBack, onExit) {
  renderChoiceScreen(container, {
    title: `Choose a ${config.regionParent.label} region`,
    options: config.regionParent.children,
    labelFn: (r) => withCount(r.label, regionCount(config, r)),
    onPick: (r) => {
      const stepBack = () => showSubRegionStep(container, config, goBack, onExit);
      if (r.datasetKey) {
        // Not a filter on the current dataset — switches to a different
        // one entirely (e.g. Caribbean's sibling "US States"). Re-enter
        // the same region/sovereignty skip chain with the new subject's
        // meta: since that dataset declares supportsRegionFilter/
        // supportsSovereigntyFilter false, it naturally skips straight
        // to the game — no bespoke skip path needed here.
        const meta = datasetMeta[r.datasetKey];
        // answerKind was picked back when the dataset was still the
        // *previous* one (answer type comes before region in the wizard),
        // so a choice only valid there — "map-pin" needs real lon/lat,
        // meaningless for an "identity"-projection dataset like US States
        // — has to be re-validated now rather than carried through as-is.
        const answerKind =
          config.answerKind === "map-pin" && meta.projection === "identity" ? "map-click" : config.answerKind;
        // pinTarget only means anything alongside "map-pin" — clear it
        // together with the downgrade above rather than letting a stale
        // "capital" choice from the previous (pre-switch) dataset silently
        // ride along into a game that never reads it.
        const pinTarget = answerKind === "map-pin" ? config.pinTarget : undefined;
        goToRegionOrSkip(
          container,
          { ...config, subject: { ...config.subject, datasetKey: r.datasetKey }, meta, answerKind, pinTarget },
          stepBack,
          onExit
        );
      } else {
        goToSovereigntyOrSkip(container, { ...config, region: r }, stepBack, onExit);
      }
    },
    onBack: goBack,
  });
}

function goToSovereigntyOrSkip(container, config, goBack, onExit) {
  if (config.meta.supportsSovereigntyFilter) {
    const regionItems = config.loadedItems.filter(config.region.match);
    showSovereigntyStep(container, { ...config, regionItems }, goBack, onExit);
  } else {
    startGame(container, { ...config, sovereignty: sovereigntyOptions[0] }, onExit);
  }
}

function showSovereigntyStep(container, config, goBack, onExit) {
  renderChoiceScreen(container, {
    title: "All countries, or sovereign states only?",
    options: sovereigntyOptions,
    labelFn: (s) =>
      withCount(
        s.label,
        config.regionItems.filter(s.match).filter((item) => isAskable(item, config.questionAttr, config.answerAttr)).length
      ),
    onPick: (s) => startGame(container, { ...config, sovereignty: s }, onExit),
    onBack: goBack,
  });
}

async function startGame(container, config, onExit) {
  container.innerHTML = '<div class="menu-screen wizard-screen"><h1>Loading…</h1></div>';
  try {
    // Already loaded once (in goToRegionOrSkip) for every dataset that has
    // a region/sovereignty step to show counts on; loadDataset's own
    // cache makes re-awaiting it here cheap and correct for every dataset
    // regardless (including one, like US states, that skipped straight
    // here without ever loading).
    const loaded = await loadDataset(config.subject.datasetKey);
    const regionItems = config.regionItems ?? loaded.items.filter(config.region.match);
    // regionItems itself stays unfiltered by askability (see isAskable) —
    // it's also what game.js crops the map to, and an item missing a
    // value for this round's question/answer attribute should still
    // render muted, not vanish and leave a hole, same as a sovereignty-
    // excluded one does.
    const dataset = {
      ...loaded,
      items: regionItems.filter(config.sovereignty.match).filter((item) => isAskable(item, config.questionAttr, config.answerAttr)),
    };
    const settings = loadSettings();
    renderGame(
      container,
      {
        dataset,
        regionItems,
        region: config.region,
        keepZoom: settings.keepZoom,
        questionAttr: config.questionAttr,
        answerAttr: config.answerAttr,
        answerKind: config.answerKind,
        answerOptionCount: config.optionCount,
        pinTarget: config.pinTarget,
      },
      onExit
    );
  } catch (err) {
    console.error(err);
    showLoadError(container, onExit);
  }
}
