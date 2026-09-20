import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCardTags } from "./decisionCard.ts";
import {
  advance,
  answerSummary,
  back,
  clearAnswer,
  commitMultiSelect,
  emptyInterviewState,
  firstUnansweredIndex,
  interviewDraft,
  interviewView,
  isAnswered,
  select,
  setNote,
  skipTo,
  startInterview,
  toggle,
  typeAnswer,
} from "./cardInterview.ts";

/**
 * The sequencing contract. Every card here is built through `parseCardTags`
 * rather than hand-written, so a case can only exercise shapes the wire
 * format actually admits — and the ids are the ones the renderer will see.
 *
 * Discriminating values are chosen deliberately: four questions rather than
 * two (so "advance" and "the next index" are not the same number by
 * accident), question texts that differ from their option labels, and
 * multi-select ticks made in a different order from the card's.
 */
function card(payload) {
  const parsed = parseCardTags([["card", JSON.stringify(payload)]]);
  assert.ok(parsed, "the fixture payload must parse as a card");
  return parsed;
}

/** Four questions: single, multi, single, single. Explicit, non-numeric ids. */
const FOUR = card({
  v: 2,
  title: "Release shape",
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which surfaces?",
      options: [
        { id: "web", label: "Web only" },
        { id: "both", label: "Web + desktop" },
      ],
    },
    {
      id: "extras",
      question: "Which extras?",
      multiSelect: true,
      options: [
        { id: "docs", label: "Docs" },
        { id: "tests", label: "Tests" },
        { id: "perf", label: "Perf pass" },
      ],
    },
    {
      id: "when",
      question: "When?",
      options: [
        { id: "now", label: "Tonight" },
        { id: "mon", label: "Monday" },
      ],
    },
    {
      id: "who",
      question: "Who reviews?",
      options: [
        { id: "sam", label: "Sam" },
        { id: "nobody", label: "Nobody" },
      ],
    },
  ],
});

const ONE = card({
  v: 1,
  title: "Ship the claims fix?",
  options: [{ id: "now", label: "Relaunch now" }, { label: "Let it ride" }],
});

test("a fresh interview starts on question one with nothing answered", () => {
  const state = startInterview(FOUR);
  assert.equal(state.index, 0);
  assert.deepEqual(state.answers, {});
  assert.equal(state.note, "");
  const view = interviewView(FOUR, state);
  assert.equal(view.question.question, "Which surfaces?");
  assert.equal(view.total, 4);
  assert.equal(view.answeredCount, 0);
  assert.equal(view.isComplete, false);
  assert.equal(view.canSubmit, false);
  assert.equal(view.canSendPartial, false);
  assert.equal(view.canGoBack, false);
});

test("answering question 1 advances to question 2", () => {
  // THE sequencing test. `advance` returning the index it was given is the
  // mutation this file exists to kill: the expected index is 1 and the card
  // has four questions, so a no-op advance reads 0 and cannot pass.
  const state = select(FOUR, startInterview(FOUR), "scope", "web");
  assert.equal(state.index, 1);
  assert.equal(interviewView(FOUR, state).question.question, "Which extras?");
  assert.deepEqual(state.answers.scope, { optionIds: ["web"] });
  assert.equal(interviewView(FOUR, state).answeredCount, 1);
});

test("advance skips answered questions and wraps backwards", () => {
  // Hardcoded expectations, never `index + 1`. Answer 1 and 3, sit on 1,
  // advance: 2 is answered, so the next OPEN question is 3 (0-based).
  let state = startInterview(FOUR);
  state = select(FOUR, state, "scope", "web"); // -> index 1
  state = toggle(FOUR, state, "extras", "docs");
  state = commitMultiSelect(FOUR, state, "extras"); // -> index 2
  state = select(FOUR, state, "when", "now"); // -> index 3
  assert.equal(state.index, 3);
  // Now go back and re-answer question 1; the only open question is 4.
  state = skipTo(FOUR, state, 0);
  state = select(FOUR, state, "scope", "both");
  assert.equal(state.index, 3, "wraps forward past answered 2 and 3");
  // Answer the last one: nothing is open, so advance stays put and the view
  // reports completeness, which is what the caller auto-submits on.
  state = select(FOUR, state, "who", "sam");
  assert.equal(state.index, 3);
  const view = interviewView(FOUR, state);
  assert.equal(view.isComplete, true);
  assert.equal(view.answeredCount, 4);
  assert.equal(view.canSendPartial, false);
});

test("advance wraps BACKWARD to an earlier open question", () => {
  // Answer 2, 3 and 4, leaving question 1 open, then re-answer 4. There is
  // nothing after it, so the next open question is index 0 — a forward-only
  // implementation would return 3 and strand the user.
  let state = { ...emptyInterviewState(), index: 1 };
  state = toggle(FOUR, state, "extras", "tests");
  state = commitMultiSelect(FOUR, state, "extras");
  state = skipTo(FOUR, state, 2);
  state = select(FOUR, state, "when", "mon");
  state = skipTo(FOUR, state, 3);
  state = select(FOUR, state, "who", "sam");
  assert.equal(state.index, 0);
  assert.equal(advance(FOUR, state, 3), 0);
});

test("a one-question card takes the same path as an interview", () => {
  // The spine of the design: v1 is not a second renderer or a second code
  // path, it is an interview of length one. Answering it completes it, and
  // `advance` has nowhere to go.
  const state = select(ONE, startInterview(ONE), "0", "now");
  assert.equal(state.index, 0);
  const view = interviewView(ONE, state);
  assert.equal(view.total, 1);
  assert.equal(view.isComplete, true);
  assert.equal(view.canSubmit, true);
  assert.equal(view.canSendPartial, false);
  assert.equal(advance(ONE, state, 0), 0);
});

test("single-select replaces its choice instead of accumulating", () => {
  let state = select(FOUR, startInterview(FOUR), "scope", "web");
  state = skipTo(FOUR, state, 0);
  state = select(FOUR, state, "scope", "both");
  assert.deepEqual(state.answers.scope, { optionIds: ["both"] });
  assert.equal(interviewView(FOUR, state).answeredCount, 1);
});

test("multi-select toggles, stays put, and serializes in CARD order", () => {
  // Ticked perf first, then docs — the payload must read docs, perf.
  let state = skipTo(FOUR, startInterview(FOUR), 1);
  state = toggle(FOUR, state, "extras", "perf");
  assert.equal(state.index, 1, "a toggle must not advance");
  state = toggle(FOUR, state, "extras", "docs");
  assert.deepEqual(state.answers.extras, { optionIds: ["docs", "perf"] });
  assert.equal(state.index, 1);
  state = commitMultiSelect(FOUR, state, "extras");
  assert.equal(state.index, 2, "Continue is what advances a multi-select");
});

test("unticking the last option removes the answer, not just the id", () => {
  // An entry with an empty optionIds is a shape `buildCardAnswerTag` refuses
  // outright, so this machine must never be able to hold one.
  let state = skipTo(FOUR, startInterview(FOUR), 1);
  state = toggle(FOUR, state, "extras", "docs");
  assert.equal(isAnswered(state, "extras"), true);
  state = toggle(FOUR, state, "extras", "docs");
  assert.equal(isAnswered(state, "extras"), false);
  assert.equal(Object.hasOwn(state.answers, "extras"), false);
  assert.deepEqual(interviewDraft(FOUR, state).answers, []);
  // And Continue with nothing ticked is a no-op rather than a silent skip.
  assert.equal(commitMultiSelect(FOUR, state, "extras").index, 1);
});

test("toggling an option over a typed answer discards the text", () => {
  // `optionIds` and `text` are exclusive on the wire; holding both would be
  // a draft the builder refuses at submit time, i.e. a dead end.
  let state = skipTo(FOUR, startInterview(FOUR), 1);
  state = typeAnswer(FOUR, state, "extras", "a changelog entry");
  assert.deepEqual(state.answers.extras, {
    optionIds: [],
    text: "a changelog entry",
  });
  state = skipTo(FOUR, state, 1);
  state = toggle(FOUR, state, "extras", "tests");
  assert.deepEqual(state.answers.extras, { optionIds: ["tests"] });
});

test("a typed answer advances exactly like an option tap", () => {
  const state = typeAnswer(FOUR, startInterview(FOUR), "scope", "both, ish");
  assert.equal(state.index, 1);
  assert.deepEqual(state.answers.scope, { optionIds: [], text: "both, ish" });
  // Blank text is not an answer; the input is always mounted.
  const untouched = typeAnswer(FOUR, startInterview(FOUR), "scope", "   ");
  assert.equal(untouched.index, 0);
  assert.deepEqual(untouched.answers, {});
});

test("unknown questions and unknown options are no-ops", () => {
  const start = startInterview(FOUR);
  assert.equal(select(FOUR, start, "budget", "web"), start);
  assert.equal(select(FOUR, start, "scope", "mobile"), start);
  assert.equal(toggle(FOUR, start, "extras", "mobile"), start);
  assert.equal(typeAnswer(FOUR, start, "budget", "x"), start);
  assert.equal(skipTo(FOUR, start, 9), start);
  assert.equal(skipTo(FOUR, start, -1), start);
  assert.equal(back(start), start);
});

test("back steps one question and stops at the first", () => {
  let state = select(FOUR, startInterview(FOUR), "scope", "web");
  assert.equal(state.index, 1);
  state = back(state);
  assert.equal(state.index, 0);
  assert.equal(back(state).index, 0);
});

test("the draft is card-ordered, gap-free and carries no done flag", () => {
  // Answered out of order on purpose: question 3 first, then question 1.
  let state = skipTo(FOUR, startInterview(FOUR), 2);
  state = select(FOUR, state, "when", "mon");
  state = skipTo(FOUR, state, 0);
  state = select(FOUR, state, "scope", "web");
  state = setNote(state, "  ");
  const draft = interviewDraft(FOUR, state);
  assert.deepEqual(draft.answers, [
    { questionId: "scope", optionIds: ["web"] },
    { questionId: "when", optionIds: ["mon"] },
  ]);
  // A blank note is an ABSENT note, and `done` is the builder's to derive.
  assert.equal(Object.hasOwn(draft, "note"), false);
  assert.equal(Object.hasOwn(draft, "done"), false);
  const withNote = interviewDraft(FOUR, setNote(state, "keep the CLI as is"));
  assert.equal(withNote.note, "keep the CLI as is");
});

test("a partial reports 2 of 4 and can send what it has", () => {
  let state = select(FOUR, startInterview(FOUR), "scope", "web");
  state = toggle(FOUR, state, "extras", "tests");
  state = commitMultiSelect(FOUR, state, "extras");
  const view = interviewView(FOUR, state);
  assert.equal(view.answeredCount, 2);
  assert.equal(view.total, 4);
  assert.equal(view.isComplete, false);
  assert.equal(view.canSubmit, true);
  assert.equal(view.canSendPartial, true);
  assert.equal(firstUnansweredIndex(FOUR, state), 2);
});

test("clearing an answer reopens the question", () => {
  let state = select(FOUR, startInterview(FOUR), "scope", "web");
  assert.equal(firstUnansweredIndex(FOUR, state), 1);
  state = clearAnswer(state, "scope");
  assert.equal(firstUnansweredIndex(FOUR, state), 0);
  assert.equal(interviewView(FOUR, state).answeredCount, 0);
});

test("a restored draft resumes at the first UNANSWERED question", () => {
  // 2 of 4 answered, so the resume point is index 2 — not 0, and not the
  // index the user happened to be looking at (3) when the tab died.
  const restored = startInterview(FOUR, {
    index: 3,
    answers: {
      scope: { optionIds: ["both"] },
      extras: { optionIds: ["docs", "perf"] },
    },
    note: "half done",
  });
  assert.equal(restored.index, 2);
  assert.equal(restored.note, "half done");
  assert.equal(interviewView(FOUR, restored).answeredCount, 2);
  assert.deepEqual(restored.answers.extras, { optionIds: ["docs", "perf"] });
});

test("a COMPLETE restored draft resumes on its last question", () => {
  const restored = startInterview(FOUR, {
    index: 0,
    answers: {
      scope: { optionIds: ["web"] },
      extras: { optionIds: ["docs"] },
      when: { optionIds: ["now"] },
      who: { optionIds: ["sam"] },
    },
    note: "",
  });
  assert.equal(restored.index, 3);
  assert.equal(interviewView(FOUR, restored).isComplete, true);
});

test("a restored draft is validated against the card, not trusted", () => {
  const restored = startInterview(FOUR, {
    index: 99,
    answers: {
      // A question this card does not have.
      budget: { optionIds: ["web"] },
      // An option this question does not offer.
      scope: { optionIds: ["mobile"] },
      // A single-select restored with two ticks keeps the first in CARD
      // order — "both" is second in the card, so "web" survives.
      when: { optionIds: ["mon", "now"] },
      // Ticks in the wrong order are re-sorted into card order.
      extras: { optionIds: ["perf", "docs"] },
    },
    note: 42,
  });
  assert.equal(Object.hasOwn(restored.answers, "budget"), false);
  assert.equal(Object.hasOwn(restored.answers, "scope"), false);
  assert.deepEqual(restored.answers.when, { optionIds: ["now"] });
  assert.deepEqual(restored.answers.extras, { optionIds: ["docs", "perf"] });
  assert.equal(restored.note, "", "a non-string note is dropped");
  // scope is open, so that is where it resumes — the stored index (99) is
  // not merely clamped, it is ignored.
  assert.equal(restored.index, 0);
});

test("garbage in the restored slot cold-starts rather than throwing", () => {
  for (const junk of [null, undefined, "nope", 7, [], { answers: 3 }]) {
    const state = startInterview(FOUR, junk);
    assert.deepEqual(state.answers, {});
    assert.equal(state.index, 0);
    assert.equal(state.note, "");
  }
});

test("answerSummary reads the card's own labels, comma-joined", () => {
  let state = skipTo(FOUR, startInterview(FOUR), 1);
  state = toggle(FOUR, state, "extras", "perf");
  state = toggle(FOUR, state, "extras", "docs");
  assert.equal(
    answerSummary(FOUR.questions[1], state.answers.extras),
    "Docs, Perf pass",
  );
  state = typeAnswer(FOUR, state, "when", "after the release");
  assert.equal(
    answerSummary(FOUR.questions[2], state.answers.when),
    "after the release",
  );
  assert.equal(answerSummary(FOUR.questions[0], undefined), "");
});

test("every transition returns a NEW state and never mutates its input", () => {
  // The component holds this in `useState`; an in-place mutation would be a
  // render that never happens.
  const start = startInterview(FOUR);
  const frozenAnswers = JSON.stringify(start.answers);
  const next = select(FOUR, start, "scope", "web");
  assert.notEqual(next, start);
  assert.equal(JSON.stringify(start.answers), frozenAnswers);
  assert.equal(start.index, 0);
});
