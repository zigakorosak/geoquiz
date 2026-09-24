// Generic round/session logic. Knows nothing about "countries" or "maps" —
// it only knows it has a list of items, a question attribute, and an answer
// attribute (both from attributes.js), and that answer attributes know how
// to check a guess against an item. This is what lets question mode and
// answer mode be picked independently and mixed freely.

export function shuffle(array) {
  const result = array.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export class QuizSession {
  // A game always covers every item in the (already filtered, e.g. by
  // continent) dataset unless a smaller roundCount is explicitly passed.
  constructor({ dataset, questionAttr, answerAttr, roundCount = dataset.items.length }) {
    this.dataset = dataset;
    this.questionAttr = questionAttr;
    this.answerAttr = answerAttr;
    this.roundCount = Math.min(roundCount, dataset.items.length);
    this.pool = shuffle(dataset.items).slice(0, this.roundCount);
    this.index = 0;
    this.score = 0;
    this.history = [];
  }

  get currentItem() {
    return this.pool[this.index];
  }

  get roundNumber() {
    return this.index + 1;
  }

  get isFinished() {
    return this.index >= this.pool.length;
  }

  submitAnswer(rawGuess) {
    const item = this.currentItem;
    const correct = this.answerAttr.checkAnswer(rawGuess, item);
    const result = {
      item,
      guess: rawGuess,
      correct,
      correctValue: this.answerAttr.formatAnswer(item),
    };
    if (correct) this.score++;
    this.history.push(result);
    return result;
  }

  advance() {
    this.index++;
    return !this.isFinished;
  }
}
