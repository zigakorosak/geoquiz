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

function promptAttributesFor(meta) {
  return resolveAttributes(meta.attributeKeys).filter((a) => a.canBePrompt);
}

function answerAttributesFor(meta, excludeKey) {
  return resolveAttributes(meta.attributeKeys).filter((a) => a.canBeAnswer && a.key !== excludeKey);
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
    options: promptAttributesFor(config.meta),
    labelFn: (a) => a.label,
    onPick: (a) =>
      showAnswerStep(container, { ...config, questionAttr: a }, () => showQuestionStep(container, config, goBack, onExit), onExit),
    onBack: goBack,
  });
}

function showAnswerStep(container, config, goBack, onExit) {
  renderChoiceScreen(container, {
    title: "How do you want to answer?",
    options: answerAttributesFor(config.meta, config.questionAttr.key),
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
  "map-click": "Click the map",
};

function goToAnswerKindOrSkip(container, config, goBack, onExit) {
  const kinds = config.answerAttr.answerKinds;
  if (kinds.length > 1) {
    showAnswerKindStep(container, config, goBack, onExit);
  } else {
    goToRegionOrSkip(container, { ...config, answerKind: kinds[0] }, goBack, onExit);
  }
}

function showAnswerKindStep(container, config, goBack, onExit) {
  renderChoiceScreen(container, {
    title: `How do you want to answer with the ${config.answerAttr.label.toLowerCase()}?`,
    options: config.answerAttr.answerKinds,
    labelFn: (k) => answerKindLabels[k] ?? k,
    onPick: (k) => {
      const stepBack = () => showAnswerKindStep(container, config, goBack, onExit);
      if (k === "multiple-choice") {
        showOptionCountStep(container, { ...config, answerKind: k }, stepBack, onExit);
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

function goToRegionOrSkip(container, config, goBack, onExit) {
  if (config.meta.supportsRegionFilter) {
    showRegionStep(container, config, goBack, onExit);
  } else {
    goToSovereigntyOrSkip(container, { ...config, region: getRegion("world") }, goBack, onExit);
  }
}

function showRegionStep(container, config, goBack, onExit) {
  renderChoiceScreen(container, {
    title: "Choose a map",
    options: regions,
    labelFn: (r) => r.label,
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
    labelFn: (r) => r.label,
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
        goToRegionOrSkip(container, { ...config, subject: { ...config.subject, datasetKey: r.datasetKey }, meta }, stepBack, onExit);
      } else {
        goToSovereigntyOrSkip(container, { ...config, region: r }, stepBack, onExit);
      }
    },
    onBack: goBack,
  });
}

function goToSovereigntyOrSkip(container, config, goBack, onExit) {
  if (config.meta.supportsSovereigntyFilter) {
    showSovereigntyStep(container, config, goBack, onExit);
  } else {
    startGame(container, { ...config, sovereignty: sovereigntyOptions[0] }, onExit);
  }
}

function showSovereigntyStep(container, config, goBack, onExit) {
  renderChoiceScreen(container, {
    title: "All countries, or sovereign states only?",
    options: sovereigntyOptions,
    labelFn: (s) => s.label,
    onPick: (s) => startGame(container, { ...config, sovereignty: s }, onExit),
    onBack: goBack,
  });
}

async function startGame(container, config, onExit) {
  container.innerHTML = '<div class="menu-screen wizard-screen"><h1>Loading…</h1></div>';
  try {
    const loaded = await loadDataset(config.subject.datasetKey);
    const regionItems = loaded.items.filter(config.region.match);
    const dataset = { ...loaded, items: regionItems.filter(config.sovereignty.match) };
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
      },
      onExit
    );
  } catch (err) {
    console.error(err);
    renderChoiceScreen(container, {
      title: "Could not load game data.",
      subtitle: "Check your connection and try again.",
      options: [{ key: "home", label: "Back to Home" }],
      labelFn: (o) => o.label,
      onPick: () => onExit(),
    });
  }
}
