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
  onBack,
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
  // region + sovereignty filtering) are clickable/normally styled. Any
  // real country outside it (out-of-region members, or Kosovo/Somaliland/
  // N. Cyprus when "All Sovereign" excludes them) renders muted and inert.
  // Id-less terrain shapes (Siachen Glacier, Indian Ocean Ter.) are a
  // separate case — plain ground, never muted — see WorldMap.js's
  // `.country--terrain`.
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

  // Sits between the timer and the hamburger menu (not down with the prompt/
  // answer/feedback stack, where it used to live) — the round's own
  // "advance" control read as belonging with the rest of the round's
  // meta-controls once there was more than one thing up there, not
  // separated from them by the whole prompt+map.
  const actionButton = document.createElement("button");
  actionButton.type = "button";
  actionButton.className = "action-button";

  // Same full config the game was started with — a restart is exactly the
  // summary screen's Play Again (fresh session, fresh shuffle), just
  // reachable mid-game without finishing first. Everything the wizard
  // chose is carried through; only the round pool/score/timer reset.
  const restartButton = document.createElement("button");
  restartButton.type = "button";
  restartButton.className = "exit-button restart-button";
  restartButton.textContent = "Restart";
  restartButton.addEventListener("click", () => {
    active = false;
    stopTimer();
    cleanupPrompt?.cleanup();
    answerWidget?.cleanup();
    renderGame(
      container,
      { dataset, regionItems, region, keepZoom, questionAttr, answerAttr, answerKind, answerOptionCount, pinTarget },
      onBack,
      onExit
    );
  });

  // Tears down the live round exactly like Home below, then hands control
  // to the wizard step the game was launched from (`onBack` — the last
  // choice screen shown before Loading, so the player lands back on e.g.
  // the continent picker with every earlier pick intact).
  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "exit-button";
  backButton.textContent = "Back";
  backButton.addEventListener("click", () => {
    active = false;
    stopTimer();
    cleanupPrompt?.cleanup();
    answerWidget?.cleanup();
    onBack();
  });

  const exitButton = document.createElement("button");
  exitButton.type = "button";
  exitButton.className = "exit-button";
  exitButton.textContent = "Home";
  exitButton.addEventListener("click", () => {
    active = false;
    stopTimer();
    cleanupPrompt?.cleanup();
    answerWidget?.cleanup();
    onExit();
  });

  // Restart / Back / Home live behind a hamburger toggle rather than as
  // three always-visible buttons — they're rare, deliberate actions, and
  // the row they occupied crowded the header (especially on tablets).
  // The dropdown is plain show/hide, closed by picking an action, tapping
  // the toggle again, or tapping anywhere else on the game screen (that
  // listener lives on `root`, so it's torn down with the screen — no
  // document-level listener to leak across restarts).
  const menuWrap = document.createElement("div");
  menuWrap.className = "game-menu";
  const menuToggle = document.createElement("button");
  menuToggle.type = "button";
  menuToggle.className = "exit-button game-menu-toggle";
  menuToggle.setAttribute("aria-label", "Game menu");
  menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.textContent = "☰";
  const menuDropdown = document.createElement("div");
  menuDropdown.className = "game-menu-dropdown";
  menuDropdown.hidden = true;
  const setMenuOpen = (open) => {
    menuDropdown.hidden = !open;
    menuToggle.setAttribute("aria-expanded", String(open));
  };
  menuToggle.addEventListener("click", (event) => {
    // Don't let the screen-wide "click anywhere to advance" listener see
    // the toggle, and don't let the outside-click closer immediately undo
    // the open.
    event.stopPropagation();
    setMenuOpen(menuDropdown.hidden);
  });
  menuDropdown.append(restartButton, backButton, exitButton);
  menuWrap.append(menuToggle, menuDropdown);
  root.addEventListener("click", (event) => {
    if (!menuWrap.contains(event.target)) setMenuOpen(false);
  });

  header.append(progress, score, timerEl, actionButton, menuWrap);

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

  // Whichever side (prompt or answer — never both; question and answer
  // are always different attributes, and only one map-oriented attribute
  // can be chosen per side) is a real WorldMap gets to flex-grow and fill
  // the available height, exactly as before. The other three elements
  // (and, when NEITHER side is a map — most Flags/Emblems/Currencies/
  // Region rounds — all of prompt+answer+feedback) size to their own
  // content instead of each individually stretching to fill the screen.
  // `.round-area`'s own `justify-content: center` is what then keeps that
  // whole small cluster grouped together, any extra vertical space
  // distributed symmetrically around it rather than specifically wedged
  // in between the answer widget and the feedback line below it — which
  // is exactly where it used to end up: answerArea's flex:1 filled the
  // entire remaining screen height regardless of how small its actual
  // content was (a single text input, a few multiple-choice buttons), so
  // the feedback line — a sibling *below* that now-enormous box, not
  // inside it — landed at the very bottom of the screen, visibly far from
  // the flag/text the player was just looking at.
  const isPromptMap = questionAttr.promptKind === "map-highlight";
  const isAnswerMap = resolvedAnswerKind.startsWith("map");
  promptArea.classList.toggle("prompt-area--map", isPromptMap);
  answerArea.classList.toggle("answer-area--map", isAnswerMap);

  const roundArea = document.createElement("div");
  roundArea.className = "round-area";
  // Feedback normally sits below the answer widget — fine when that
  // widget is small (a text input, a button row), where .round-area's own
  // centering keeps the whole cluster grouped together. When the answer
  // IS the map (map-click/map-pin/map-region-click), it fills all
  // available height on its own, leaving nothing for centering to work
  // with — feedback below it would land off the bottom of the screen,
  // out of view without scrolling, right after the player just clicked
  // somewhere near the top of a tall map. Placed before the map instead
  // so it's immediately visible, in the same spot every round.
  if (isAnswerMap) {
    roundArea.append(promptArea, feedbackArea, answerArea);
  } else {
    roundArea.append(promptArea, answerArea, feedbackArea);
  }

  root.append(header, roundArea);
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
      // The choice widgets (multiple-choice / picture-choice) need the
      // question attribute too: a distractor consistent with the shown
      // question value (another "Europe" country, another Euro user) would
      // be a second correct option — see the exclusion in inputs.js.
      questionAttr,
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
    // The timer was already stopped when the result was confirmed
    // (attemptConfirm) — goNext only ever runs in the "result" phase.
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
      // Label each round by what the player was actually *shown* — the
      // question value, not always the item's name. In a Capitals game the
      // prompt was "Paris", so "Paris: wrong (was France)" tells the whole
      // story; labeling by item name produced "France: wrong (was France)",
      // the answer echoed as its own correction. When the correction would
      // just repeat the label (name→location games: both are the country's
      // name), drop it rather than echo it.
      const label = questionAttr.formatAnswer(entry.item);
      const correction = entry.correct || entry.correctValue === label ? "" : ` (was ${entry.correctValue})`;
      li.textContent = `${label}: ${entry.correct ? "correct" : "wrong"}${correction}${time}`;
      list.appendChild(li);
    });

    const playAgain = document.createElement("button");
    playAgain.type = "button";
    playAgain.textContent = "Play Again";
    playAgain.addEventListener("click", () =>
      renderGame(
        container,
        // The full config this game was started with — anything omitted
        // here silently reverts to its default on replay (pinTarget was
        // once missing, so a Capital-scored pin game replayed as
        // Region-scored).
        { dataset, regionItems, region, keepZoom, questionAttr, answerAttr, answerKind, answerOptionCount, pinTarget },
        onBack,
        onExit
      )
    );

    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.textContent = "Home";
    menuButton.addEventListener("click", onExit);

    summary.append(heading, scoreLine, timeLine, list, playAgain, menuButton);
    root.appendChild(summary);
  }

  startRound();
}
