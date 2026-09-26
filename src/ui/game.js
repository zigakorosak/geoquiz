// Game screen: drives a QuizSession through its rounds. Generic over
// whatever question/answer attributes were picked in the wizard — it only
// ever calls into the prompt/input widget registries by kind.
//
// Flow per round: prompt shown -> player picks a provisional answer
// (widgets report this via onSelect, never auto-submitting) -> player hits
// Confirm, or (map-click only) clicks the already-selected country again
// -> result shown -> player advances via the same button (now labelled
// Next) or by clicking anywhere else on the screen.

import { QuizSession } from "../core/engine.js";
import { renderPrompt } from "./prompts.js";
import { renderAnswerInput } from "./inputs.js";

export function renderGame(
  container,
  { dataset, regionItems, region, keepZoom, questionAttr, answerAttr, answerKind, answerOptionCount, pinTarget },
  onExit
) {
  const session = new QuizSession({ dataset, questionAttr, answerAttr });
  // answerAttr can support more than one input style (e.g. "name" via
  // typing or multiple choice — see attributes.js); the wizard picks a
  // specific one and passes it as answerKind, falling back to the
  // attribute's first supported kind if omitted.
  const resolvedAnswerKind = answerKind ?? answerAttr.answerKinds[0];

  // Where the map starts framed. The map itself always renders the whole
  // dataset — a region is never a crop — so this only decides the initial
  // zoom/pan; everything outside it is still there, muted, a pan or a
  // zoom-out away. Built from regionItems rather than dataset.items so a
  // shape that belongs to the region but isn't currently quizzable (e.g.
  // Kosovo within Europe under "All Sovereign") still counts toward the
  // framing, exactly as it counts toward what the player sees.
  //
  // `region.fitExclude` (by name, core/regions.js) drops members that
  // would wreck that framing without being what the region is "about" —
  // Europe includes Russia, but fitting to Russia's full eastern extent
  // gives nothing like a standard map of Europe. Excluded members remain
  // fully playable and rendered; they're just not what the view centers
  // on. Null (World, or a dataset with no region concept) means "frame
  // everything".
  const focusIds =
    region && region.key !== "world"
      ? new Set(
          (regionItems ?? dataset.items)
            .filter((i) => !region.fitExclude?.has(i.name))
            .map((i) => i.id)
        )
      : null;

  // Soft gate, always active: only items actually in play this game (after
  // region + sovereignty filtering) are clickable/normally styled.
  // Everything else on the map (Indian Ocean Ter., Siachen Glacier, or
  // Kosovo/Somaliland/N. Cyprus when "All Sovereign" excludes them)
  // renders muted like today's "unplayable" shapes, regardless of
  // whether the topology itself assigned it an id.
  const playableIds = new Set(dataset.items.map((i) => i.id));

  container.innerHTML = "";
  const root = document.createElement("div");
  root.className = "game-screen";

  const header = document.createElement("div");
  header.className = "game-header";

  const progress = document.createElement("span");
  progress.className = "game-progress";

  const score = document.createElement("span");
  score.className = "game-score";

  const timerEl = document.createElement("span");
  timerEl.className = "game-timer";

  const exitButton = document.createElement("button");
  exitButton.type = "button";
  exitButton.className = "exit-button";
  exitButton.textContent = "Back to Menu";
  exitButton.addEventListener("click", () => {
    active = false;
    stopTimer();
    cleanupPrompt?.cleanup();
    answerWidget?.cleanup();
    onExit();
  });

  header.append(progress, score, timerEl, exitButton);

  const promptArea = document.createElement("div");
  promptArea.className = "prompt-area";

  const answerArea = document.createElement("div");
  answerArea.className = "answer-area";

  // A dedicated slot for post-confirm feedback text (e.g. "You picked X —
  // correct answer: Y"), separate from answerArea itself: answerArea can
  // hold a full-size map, and stuffing a text line in alongside it there
  // would fight the map for space in that flex row.
  const feedbackArea = document.createElement("div");
  feedbackArea.className = "feedback-area";

  const actionButton = document.createElement("button");
  actionButton.type = "button";
  actionButton.className = "action-button";

  root.append(header, promptArea, answerArea, feedbackArea, actionButton);
  container.appendChild(root);

  let cleanupPrompt = null;
  let answerWidget = null;
  let selection = null;
  let phase = "answering"; // "answering" | "result"
  let active = true; // false once we've left this round loop (summary or exit)
  let suppressNextRootAdvance = false;
  let lastTransform = null; // carried forward between rounds when keepZoom is on
  let timerInterval = null;
  let roundStartedAt = null;
  const roundTimes = [];

  function updateHeader() {
    progress.textContent = `Round ${session.roundNumber} / ${session.roundCount}`;
    score.textContent = `Score: ${session.score}`;
  }

  function startTimer() {
    roundStartedAt = performance.now();
    timerEl.textContent = "0.0s";
    timerInterval = setInterval(() => {
      timerEl.textContent = `${((performance.now() - roundStartedAt) / 1000).toFixed(1)}s`;
    }, 100);
  }

  function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    if (roundStartedAt == null) return 0;
    const elapsed = (performance.now() - roundStartedAt) / 1000;
    timerEl.textContent = `${elapsed.toFixed(1)}s`;
    return elapsed;
  }

  function startRound() {
    phase = "answering";
    selection = null;
    updateHeader();
    startTimer();
    actionButton.textContent = "Confirm";
    actionButton.disabled = true;
    feedbackArea.innerHTML = "";

    const item = session.currentItem;
    const initialTransform = keepZoom ? lastTransform : null;

    cleanupPrompt = renderPrompt(promptArea, questionAttr.promptKind, {
      item,
      attr: questionAttr,
      dataset,
      focusIds,
      playableIds,
      initialTransform,
    });

    answerWidget = renderAnswerInput(answerArea, resolvedAnswerKind, {
      item,
      attr: answerAttr,
      dataset,
      focusIds,
      playableIds,
      optionCount: answerOptionCount,
      pinTarget,
      initialTransform,
      feedbackContainer: feedbackArea,
      onSelect: (value) => {
        selection = value;
        actionButton.disabled = phase !== "answering" || selection == null;
      },
      onConfirm: () => attemptConfirm(),
    });
  }

  function attemptConfirm() {
    if (phase !== "answering" || selection == null) return;
    const result = session.submitAnswer(selection);
    answerWidget.showResult(result);
    roundTimes.push(stopTimer());
    phase = "result";
    updateHeader();
    actionButton.disabled = false;
    const isLastRound = session.roundNumber >= session.roundCount;
    actionButton.textContent = isLastRound ? "See Results" : "Next";
    // A confirm triggered by clicking something other than the action
    // button (re-clicking the selected country) is itself a click that
    // will go on to bubble up to the root's "click anywhere advances"
    // listener below. Without this, that single click would both confirm
    // *and* immediately advance, and the result would never be visible.
    suppressNextRootAdvance = true;
  }

  function cleanupRoundDom() {
    if (keepZoom) {
      lastTransform = answerWidget?.getTransform?.() ?? cleanupPrompt?.getTransform?.() ?? lastTransform;
    }
    cleanupPrompt?.cleanup();
    answerWidget?.cleanup();
  }

  function goNext() {
    stopTimer();
    cleanupRoundDom();
    if (session.advance()) {
      startRound();
    } else {
      renderSummary();
    }
  }

  actionButton.addEventListener("click", () => {
    if (phase === "answering") attemptConfirm();
    else goNext();
  });

  // After a result is shown, clicking anywhere else on the round (the map,
  // the prompt, empty space) also advances — the action button remains the
  // explicit way to do it, this is just a shortcut.
  root.addEventListener("click", (e) => {
    if (suppressNextRootAdvance) {
      suppressNextRootAdvance = false;
      return;
    }
    if (active && phase === "result" && !actionButton.contains(e.target)) goNext();
  });

  function renderSummary() {
    active = false;
    root.innerHTML = "";
    const summary = document.createElement("div");
    summary.className = "game-summary";

    const heading = document.createElement("h2");
    heading.textContent = "Game Over";

    const scoreLine = document.createElement("p");
    scoreLine.className = "summary-score";
    scoreLine.textContent = `You scored ${session.score} / ${session.roundCount}`;

    const totalTime = roundTimes.reduce((a, b) => a + b, 0);
    const avgTime = roundTimes.length ? totalTime / roundTimes.length : 0;
    const timeLine = document.createElement("p");
    timeLine.className = "summary-time";
    timeLine.textContent = `Total time: ${totalTime.toFixed(1)}s — average ${avgTime.toFixed(1)}s / round`;

    const list = document.createElement("ul");
    list.className = "summary-list";
    session.history.forEach((entry, i) => {
      const li = document.createElement("li");
      li.className = entry.correct ? "summary-correct" : "summary-wrong";
      const time = roundTimes[i] != null ? ` (${roundTimes[i].toFixed(1)}s)` : "";
      li.textContent = `${entry.item.name}: ${entry.correct ? "correct" : `wrong (was ${entry.correctValue})`}${time}`;
      list.appendChild(li);
    });

    const playAgain = document.createElement("button");
    playAgain.type = "button";
    playAgain.textContent = "Play Again";
    playAgain.addEventListener("click", () =>
      renderGame(
        container,
        { dataset, regionItems, region, keepZoom, questionAttr, answerAttr, answerKind, answerOptionCount },
        onExit
      )
    );

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.textContent = "Back to Menu";
    menuButton.addEventListener("click", onExit);

    summary.append(heading, scoreLine, timeLine, list, playAgain, menuButton);
    root.appendChild(summary);
  }

  startRound();
}
