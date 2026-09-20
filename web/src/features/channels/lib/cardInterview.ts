/**
 * The decision-card interview, as a PURE state machine.
 *
 * `DecisionCard.tsx` renders one question at a time and drops the user into
 * the next as soon as one is answered. All of the sequencing that makes that
 * work — which question is on screen, which are answered, where "next" is,
 * when the interview is complete, what the submission payload looks like —
 * lives here, with no React, no storage and no clock.
 *
 * That is not tidiness. A stepper implemented inside a component is only
 * testable by mounting the component, and a mutation to its sequencing then
 * fails (or does not fail) for reasons entangled with rendering. Here the
 * mutation is exact: make {@link advance} return the index it was given and
 * `answering question 1 advances to question 2` is the test that dies.
 *
 * ## State vs. view
 *
 * {@link CardInterviewState} is the minimum that must be PERSISTED (the
 * answers, the note, the question on screen). {@link interviewView} derives
 * everything a renderer wants from `(card, state)` — counts, completeness,
 * whether a partial can be sent — so no derived value is ever stored, and a
 * draft restored from disk cannot disagree with the card it is restored
 * against.
 *
 * ## Advance is "next UNANSWERED", not "next"
 *
 * A user who goes back to revise question 2 of 4 and re-answers it should
 * land on whatever is still open, not be marched through answers they already
 * gave. So {@link advance} looks forward for the next unanswered question,
 * wraps to look backward, and stays put when there is none — the last case
 * being exactly the auto-submit trigger, which the caller reads off
 * `isComplete` rather than off the index.
 *
 * ## Bounds are the ANSWER format's, and are not re-litigated here
 *
 * A selection this module holds is a candidate answer, not a published one.
 * `buildCardAnswerTag` is the authority on what may go on the wire (unknown
 * option ids, single-select given two options, empty selections, the tag
 * budget) and it THROWS. This module's job is to never hand it a draft it
 * would refuse in the ordinary course: single-select replaces rather than
 * accumulates, a toggle that empties a multi-select removes the answer
 * entirely, and {@link interviewDraft} omits every unanswered question.
 */

import type { CardAnswerDraft, CardAnswerSelection } from "./cardAnswerTag.ts";
import type { CardQuestion, DecisionCard } from "./decisionCard.ts";

/** One question's in-progress answer. Chosen ids XOR typed text. */
export interface CardInterviewAnswer {
  /** Chosen option ids in CARD OPTION ORDER. Empty exactly when `text` is set. */
  optionIds: string[];
  /** A typed answer. Present exactly when `optionIds` is empty. */
  text?: string;
}

/**
 * Everything that must survive a reload. Deliberately small and
 * JSON-serializable: `cardDraft.ts` writes this verbatim.
 */
export interface CardInterviewState {
  /** The question on screen. Always a valid index into `card.questions`. */
  index: number;
  /** questionId → answer. Unanswered questions are ABSENT, never empty. */
  answers: Record<string, CardInterviewAnswer>;
  /** The interview-level note ("Anything else?"). `""` when untouched. */
  note: string;
}

/** Everything a renderer needs, derived — never stored. */
export interface CardInterviewView {
  /** The question on screen. */
  question: CardQuestion;
  /** Its 0-based position. */
  index: number;
  /** `card.questions.length`. */
  total: number;
  /** How many questions carry an answer. */
  answeredCount: number;
  /** The answer for the question on screen, or null. */
  current: CardInterviewAnswer | null;
  /** Every question answered — the auto-submit condition. */
  isComplete: boolean;
  /** At least one answer, so there is something to publish. */
  canSubmit: boolean;
  /** Something answered AND something left — the "Send what I have" gate. */
  canSendPartial: boolean;
  /** There is an earlier question to step back to. */
  canGoBack: boolean;
}

/** Is this question answered? */
export function isAnswered(
  state: CardInterviewState,
  questionId: string,
): boolean {
  return state.answers[questionId] !== undefined;
}

/**
 * The first question with no answer, or `-1` when the interview is complete.
 * This is where a restored draft resumes.
 */
export function firstUnansweredIndex(
  card: DecisionCard,
  state: CardInterviewState,
): number {
  return card.questions.findIndex(
    (question) => !isAnswered(state, question.id),
  );
}

/** A fresh interview: nothing answered, sitting on question one. */
export function emptyInterviewState(): CardInterviewState {
  return { index: 0, answers: {}, note: "" };
}

/**
 * Start (or resume) an interview.
 *
 * A restored draft is validated AGAINST THE CARD rather than trusted: answers
 * naming a question the card does not have, option ids the question does not
 * offer, and an index off the end are all dropped. Drafts key on the card's
 * event id, which is content-derived, so a stale draft cannot bind to an
 * edited question set — but the draft also crosses a storage boundary and a
 * build boundary, and "the key makes it impossible" is not a reason to hand
 * unchecked input to the answer builder.
 *
 * The resumed index is the first UNANSWERED question, not the one the user
 * was last looking at: after a reload the useful place to be is the work
 * that is left. A complete draft resumes on its last question.
 */
export function startInterview(
  card: DecisionCard,
  restored?: Partial<CardInterviewState> | null,
): CardInterviewState {
  const state = emptyInterviewState();
  if (restored && typeof restored === "object") {
    const answers: Record<string, CardInterviewAnswer> = {};
    const raw = restored.answers;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const question of card.questions) {
        const candidate = (raw as Record<string, unknown>)[question.id];
        const answer = sanitizeAnswer(question, candidate);
        if (answer) {
          answers[question.id] = answer;
        }
      }
    }
    state.answers = answers;
    state.note = typeof restored.note === "string" ? restored.note : "";
  }
  const open = firstUnansweredIndex(card, state);
  state.index = open === -1 ? card.questions.length - 1 : open;
  return state;
}

/** A restored answer, or null when it does not fit this question. */
function sanitizeAnswer(
  question: CardQuestion,
  candidate: unknown,
): CardInterviewAnswer | null {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return null;
  }
  const entry = candidate as Record<string, unknown>;
  if (typeof entry.text === "string" && entry.text.length > 0) {
    return { optionIds: [], text: entry.text };
  }
  if (!Array.isArray(entry.optionIds)) {
    return null;
  }
  const chosen = new Set(
    entry.optionIds.filter((id): id is string => typeof id === "string"),
  );
  // Card option order, and only ids this question actually offers.
  const optionIds = question.options
    .filter((option) => chosen.has(option.id))
    .map((option) => option.id);
  if (optionIds.length === 0) {
    return null;
  }
  // A single-select question restored with several ticks keeps the first in
  // card order — the builder would refuse the rest anyway.
  return { optionIds: question.multiSelect ? optionIds : [optionIds[0]] };
}

/** The derived view for one render. */
export function interviewView(
  card: DecisionCard,
  state: CardInterviewState,
): CardInterviewView {
  const total = card.questions.length;
  const index = Math.min(Math.max(state.index, 0), total - 1);
  const question = card.questions[index];
  let answeredCount = 0;
  for (const candidate of card.questions) {
    if (isAnswered(state, candidate.id)) {
      answeredCount += 1;
    }
  }
  const isComplete = answeredCount === total;
  return {
    question,
    index,
    total,
    answeredCount,
    current: state.answers[question.id] ?? null,
    isComplete,
    canSubmit: answeredCount > 0,
    canSendPartial: answeredCount > 0 && !isComplete,
    canGoBack: index > 0,
  };
}

/**
 * Where answering the question at `from` should leave the user.
 *
 * Next unanswered AFTER `from`; failing that, the first unanswered BEFORE it;
 * failing that, `from` itself — the interview is complete and the caller
 * submits rather than navigating.
 *
 * Pure and index-only on purpose: this is the one rule the whole stepper
 * turns on, so it is the one thing a mutation can break in isolation.
 */
export function advance(
  card: DecisionCard,
  state: CardInterviewState,
  from: number,
): number {
  const total = card.questions.length;
  for (let offset = 1; offset <= total; offset += 1) {
    const candidate = (from + offset) % total;
    if (!isAnswered(state, card.questions[candidate].id)) {
      return candidate;
    }
  }
  return from;
}

/** Step back one question. Never past the first. */
export function back(state: CardInterviewState): CardInterviewState {
  return state.index <= 0 ? state : { ...state, index: state.index - 1 };
}

/** Jump to a question by index — the progress segments' revisit affordance. */
export function skipTo(
  card: DecisionCard,
  state: CardInterviewState,
  index: number,
): CardInterviewState {
  if (index < 0 || index >= card.questions.length || index === state.index) {
    return state;
  }
  return { ...state, index };
}

/** Replace the note. */
export function setNote(
  state: CardInterviewState,
  note: string,
): CardInterviewState {
  return note === state.note ? state : { ...state, note };
}

/**
 * Answer a SINGLE-SELECT question and move on.
 *
 * Replaces rather than accumulates, and advances in the same transition —
 * Sam's stated flow is answer-and-advance, so there is no confirm tap and no
 * intermediate state where a single-select question holds two choices.
 */
export function select(
  card: DecisionCard,
  state: CardInterviewState,
  questionId: string,
  optionId: string,
): CardInterviewState {
  const index = indexOfQuestion(card, questionId);
  if (index === -1) {
    return state;
  }
  const question = card.questions[index];
  if (!question.options.some((option) => option.id === optionId)) {
    return state;
  }
  const answers = { ...state.answers, [questionId]: { optionIds: [optionId] } };
  const next = { ...state, answers };
  return { ...next, index: advance(card, next, index) };
}

/**
 * Toggle one option of a MULTI-SELECT question. Does NOT advance — the user
 * says when they are done with a Continue button, which is the only way a
 * multi-select can express "these two and nothing else".
 *
 * Unticking the last option removes the ANSWER, not just the id: an entry
 * with an empty `optionIds` is a shape the answer builder refuses, and
 * "answered with nothing" is not a state this machine should be able to hold.
 */
export function toggle(
  card: DecisionCard,
  state: CardInterviewState,
  questionId: string,
  optionId: string,
): CardInterviewState {
  const index = indexOfQuestion(card, questionId);
  if (index === -1) {
    return state;
  }
  const question = card.questions[index];
  if (!question.options.some((option) => option.id === optionId)) {
    return state;
  }
  if (!question.multiSelect) {
    return select(card, state, questionId, optionId);
  }
  const current = state.answers[questionId];
  // A typed answer and chosen options are exclusive, so ticking an option
  // over a typed answer discards the text rather than sending both.
  const held = new Set(
    current?.text === undefined ? (current?.optionIds ?? []) : [],
  );
  if (held.has(optionId)) {
    held.delete(optionId);
  } else {
    held.add(optionId);
  }
  const optionIds = question.options
    .filter((option) => held.has(option.id))
    .map((option) => option.id);
  const answers = { ...state.answers };
  if (optionIds.length === 0) {
    delete answers[questionId];
  } else {
    answers[questionId] = { optionIds };
  }
  return { ...state, answers };
}

/**
 * Commit a multi-select question's current ticks and move on. A no-op when
 * nothing is ticked — the Continue button is disabled in that state, and a
 * machine that advanced anyway would leave the question silently unanswered.
 */
export function commitMultiSelect(
  card: DecisionCard,
  state: CardInterviewState,
  questionId: string,
): CardInterviewState {
  const index = indexOfQuestion(card, questionId);
  if (index === -1 || !isAnswered(state, questionId)) {
    return state;
  }
  return { ...state, index: advance(card, state, index) };
}

/**
 * Answer a question with typed text and move on. Blank text is a no-op, not
 * an answer — the input is always mounted, so `""` is what an untouched
 * field holds.
 */
export function typeAnswer(
  card: DecisionCard,
  state: CardInterviewState,
  questionId: string,
  text: string,
): CardInterviewState {
  const index = indexOfQuestion(card, questionId);
  if (index === -1 || text.trim().length === 0) {
    return state;
  }
  const answers = {
    ...state.answers,
    [questionId]: { optionIds: [], text },
  };
  const next = { ...state, answers };
  return { ...next, index: advance(card, next, index) };
}

/** Drop one question's answer — the "actually, skip this" affordance. */
export function clearAnswer(
  state: CardInterviewState,
  questionId: string,
): CardInterviewState {
  if (!isAnswered(state, questionId)) {
    return state;
  }
  const answers = { ...state.answers };
  delete answers[questionId];
  return { ...state, answers };
}

function indexOfQuestion(card: DecisionCard, questionId: string): number {
  return card.questions.findIndex((question) => question.id === questionId);
}

/**
 * The submission payload for `sendCardInterviewAnswer`.
 *
 * In CARD ORDER, unanswered questions omitted, and the note omitted when it
 * is blank. `done` is not here and cannot be: the answer builder DERIVES it
 * from the answer count against the card, so no caller — including this one
 * — can claim an interview concluded when it did not.
 */
export function interviewDraft(
  card: DecisionCard,
  state: CardInterviewState,
): CardAnswerDraft {
  const answers: CardAnswerSelection[] = [];
  for (const question of card.questions) {
    const answer = state.answers[question.id];
    if (!answer) {
      continue;
    }
    answers.push(
      answer.text === undefined
        ? { questionId: question.id, optionIds: answer.optionIds }
        : { questionId: question.id, optionIds: [], text: answer.text },
    );
  }
  const draft: CardAnswerDraft = { answers };
  if (state.note.trim().length > 0) {
    draft.note = state.note;
  }
  return draft;
}

/**
 * One line summarising an answered question, for the collapsed rows and the
 * "You replied" state. Labels are the card's own text and are rendered as
 * TEXT by the caller (never markdown), same as v1's option labels.
 */
export function answerSummary(
  question: CardQuestion,
  answer: CardInterviewAnswer | undefined,
): string {
  if (!answer) {
    return "";
  }
  if (answer.text !== undefined) {
    return answer.text;
  }
  return answer.optionIds
    .map((id) => {
      const option = question.options.find((candidate) => candidate.id === id);
      return option ? option.label : id;
    })
    .join(", ");
}
