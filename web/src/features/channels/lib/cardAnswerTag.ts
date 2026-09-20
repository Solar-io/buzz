/**
 * Decision-card ANSWERS — the other half of the wire contract in
 * `decisionCard.ts`, and the half an agent actually reads.
 *
 * One submission is ONE ordinary kind 9 reply whose NIP-10 reply marker
 * names the card, carrying BOTH halves of the answer:
 *
 * - `content` — deterministic, human-readable text. This is the only thing
 *   the asking agent's LLM, Buzz Desktop and every plain nostr reader ever
 *   see, so it must let a reader recover WHICH OPTION was chosen for WHICH
 *   QUESTION with no other context. One `**<question>** — <answer>` line per
 *   question of the card, in author order, and nothing else but an optional
 *   trailing `_Note: …_`.
 * - `["card-answer", "<compact JSON>"]` — the machine half. Keys are short
 *   because nobody reads them:
 *
 *     {"v":2,"c":"<card event id>",
 *      "a":[{"q":"scope","o":["web"]},          // single-select
 *           {"q":"1","o":["a","c"]},            // multi-select
 *           {"q":"when","t":"after the release"}], // typed, no option id
 *      "n":"optional freeform note",
 *      "done":true}
 *
 *   It is the only carrier of OPTION IDS — v1's real wart was that the reply
 *   was the label verbatim, so the client could never repaint "you answered
 *   X" after a reload without string-matching labels back onto the card.
 *
 * ## `done` is DERIVED, never asserted
 *
 * `done` is `answers.length === card.questions.length` — the builder
 * computes it and no caller can override it. The failure this guards is the
 * one that costs real money: an agent acting on 2 of 4 answers as though the
 * interview concluded. A caller that could pass `done: true` alongside a gap
 * is a caller that can manufacture exactly that, and "Send what I have" needs
 * no such power — a submission with a gap IS a partial, whatever the user
 * meant by it. A partial does not clear the ask badge (`askDetection.ts`).
 *
 * ## Unreadable is NOT the same as absent
 *
 * `parseCardAnswerTags` returns `null` only when there is no `card-answer`
 * tag at all — a v1 reply, or the dismiss-and-type-freely path, both of which
 * are COMPLETE by the badge rule. A tag that is present but unreadable (a
 * future `v:3`, a corrupt payload, two tags) returns
 * {@link UNREADABLE_CARD_ANSWER}: `done:false`, `cardId:null`. We know an
 * answer claims to be here and we know it does not claim to be complete, so
 * the badge stays lit. Assuming completeness from a payload we could not read
 * is the one direction that loses the ask.
 *
 * Pure: no React, no IO, and — like the card parser — TOTAL on the read side.
 * Every malformed shape resolves to a value; nothing throws. The BUILD side
 * throws, deliberately, in the same style as `buildCardTag`: authoring is
 * stricter than rendering.
 */

import {
  CARD_LIMITS,
  cardTrim,
  containsUnpairedSurrogate,
  isPlainObject,
  type CardQuestion,
  type DecisionCard,
} from "./decisionCard.ts";

/**
 * Bounds for the answer payload. Derived from `CARD_LIMITS` wherever the
 * answer is quoting the card back (ids, option counts, the tag budget), so a
 * card that fits can always be answered — an answer bounded independently
 * would eventually refuse a legal card's own ids. The tests hardcode every
 * value rather than restating these expressions.
 */
export const ANSWER_LIMITS = {
  /** Answer tag JSON, UTF-16 units. Same client-side self-cap as the card. */
  maxTagBytes: CARD_LIMITS.maxTagBytes,
  /** One answer entry per question, so the card's question cap. */
  maxAnswers: CARD_LIMITS.maxQuestions,
  /** Selected options for one question — at most the question's own cap. */
  maxOptionsPerAnswer: CARD_LIMITS.maxOptions,
  /** Question and option ids, echoed from the card. */
  maxIdChars: CARD_LIMITS.maxIdChars,
  /** `c` — a nostr event id is 32 bytes of hex. */
  maxCardIdChars: 64,
  /** A typed per-question answer. Bounded like an option label, so typing
   * cannot smuggle in more than choosing could. */
  maxTextChars: CARD_LIMITS.maxLabelChars,
  /** The interview-level note — matches the card composer's input maxLength. */
  maxNoteChars: 2000,
} as const;

/** One question's answer: chosen option ids, or typed text. Never both. */
export interface CardAnswerSelection {
  /** The answered question's id, as the card carries it. */
  questionId: string;
  /**
   * Chosen option ids in CARD OPTION ORDER (the builder sorts them), so two
   * users choosing the same set produce identical bytes. Empty exactly when
   * `text` is set.
   */
  optionIds: string[];
  /** A typed answer. Present exactly when `optionIds` is empty. */
  text?: string;
}

export interface CardAnswer {
  /** Wire version. Only 2 exists; there was no v1 answer payload. */
  v: 2;
  /**
   * The card this answers, per the tag's own `c` field — redundant with the
   * reply-marker e-tag, which is what detection actually keys on, so nothing
   * branches on this. **`null` means the tag was unreadable** (see
   * {@link UNREADABLE_CARD_ANSWER}); a readable answer always names a card.
   */
  cardId: string | null;
  /** One entry per ANSWERED question. Unanswered questions are absent. */
  answers: CardAnswerSelection[];
  /** Interview-level freeform note. */
  note?: string;
  /** Every question answered. Derived by the builder; false when unreadable. */
  done: boolean;
}

/**
 * A `card-answer` tag was present and could not be read. Not a parse
 * failure to be swallowed: it is the honest statement that an answer exists
 * and does not claim completeness. Frozen and shared, so it is also
 * reference-stable for React consumers.
 */
export const UNREADABLE_CARD_ANSWER: CardAnswer = Object.freeze({
  v: 2,
  cardId: null,
  answers: Object.freeze([]) as unknown as CardAnswerSelection[],
  done: false,
});

/** Did this answer come off the wire intact? */
export function isReadableCardAnswer(answer: CardAnswer): boolean {
  return answer.cardId !== null;
}

/** Questions this answer actually answered — the inbox's `N` in `N/M`. */
export function answeredQuestionCount(answer: CardAnswer): number {
  return answer.answers.length;
}

/** What a caller submits. `done` is absent on purpose — see the module doc. */
export interface CardAnswerDraft {
  /** Answered questions, in any order. The content renders in card order. */
  answers: CardAnswerSelection[];
  /** Optional interview-level note ("Anything else?"). */
  note?: string;
}

/**
 * Line separators are collapsed to a single space in every string that
 * reaches the answer `content`.
 *
 * This is the property that makes the content parseable at all: the contract
 * is ONE LINE PER QUESTION, and a newline inside a question, an option label
 * or a typed answer silently splits one line into two — after which no reader
 * can tell which fragment belongs to which question. Card text rides the wire
 * verbatim (that is the card format's rule and not ours to change), so the
 * collapse happens where the line structure is created: here.
 *
 * U+2028/U+2029 are included because `JSON.parse` admits them and a markdown
 * renderer breaks on them.
 */
const LINE_SEPARATORS = /[\r\n\u2028\u2029]+/g;

function oneLine(value: string): string {
  return cardTrim(value.replace(LINE_SEPARATORS, " "));
}

// ---- authoring ------------------------------------------------------------

/** Authoring-side failure, same style as `buildCardTag`. */
function reject(message: string): never {
  throw new Error(message);
}

function boundedAnswerText(
  value: unknown,
  maxChars: number,
  message: string,
): string {
  if (typeof value !== "string") {
    reject(message);
  }
  const normalized = oneLine(value);
  if (normalized.length === 0 || normalized.length > maxChars) {
    reject(message);
  }
  return normalized;
}

/**
 * Ids in a parsed card are NOT guaranteed unique, and that is a real hole
 * rather than a hypothetical: `parseCardTags` fills omitted ids positionally
 * (`"0"`, `"1"`, …) and accepts explicit ones verbatim, so a card whose
 * question 0 declares `id:"1"` and whose question 1 declares none produces
 * two questions both called `"1"`. An agent that can choose the ids can
 * therefore author a card whose structured answer is ambiguous — the tag
 * would carry two `{"q":"1"}` entries with no way to tell them apart.
 *
 * The content fallback stays unambiguous either way (it keys on question TEXT
 * in author order), so this is not a reason to refuse to render. It is a
 * reason to refuse to BUILD: an ambiguous machine payload is worse than no
 * machine payload. Answer such a card with the plain-text path.
 */
function requireUniqueIds(card: DecisionCard): void {
  const seen = new Set<string>();
  for (const question of card.questions) {
    if (seen.has(question.id)) {
      reject(`card has two questions with id ${JSON.stringify(question.id)}`);
    }
    seen.add(question.id);
    const optionIds = new Set<string>();
    for (const option of question.options) {
      if (optionIds.has(option.id)) {
        reject(
          `question ${JSON.stringify(question.id)} has two options with id ${JSON.stringify(option.id)}`,
        );
      }
      optionIds.add(option.id);
    }
  }
}

function buildSelection(
  question: CardQuestion,
  selection: CardAnswerSelection,
): CardAnswerSelection {
  const label = JSON.stringify(question.id);
  const rawIds = Array.isArray(selection.optionIds) ? selection.optionIds : [];
  const hasText =
    typeof selection.text === "string" && oneLine(selection.text).length > 0;
  if (rawIds.length > 0 && hasText) {
    reject(`answer for question ${label} has both options and typed text`);
  }
  if (rawIds.length === 0 && !hasText) {
    // The multiSelect-with-nothing-ticked case, and the "advanced past a
    // question without touching it" case. Neither is an answer; a question
    // nobody answered is simply absent from the payload and shows as
    // "(not answered)" in the content.
    reject(`answer for question ${label} chose nothing and typed nothing`);
  }
  if (hasText) {
    return {
      questionId: question.id,
      optionIds: [],
      text: boundedAnswerText(
        selection.text,
        ANSWER_LIMITS.maxTextChars,
        `typed answer for question ${label} must be 1-${ANSWER_LIMITS.maxTextChars} characters`,
      ),
    };
  }
  if (!question.multiSelect && rawIds.length > 1) {
    reject(`question ${label} takes one option, got ${rawIds.length}`);
  }
  if (rawIds.length > ANSWER_LIMITS.maxOptionsPerAnswer) {
    reject(
      `question ${label} takes at most ${ANSWER_LIMITS.maxOptionsPerAnswer} options`,
    );
  }
  const chosen = new Set<string>();
  for (const id of rawIds) {
    if (typeof id !== "string") {
      reject(`option ids for question ${label} must be strings`);
    }
    if (chosen.has(id)) {
      reject(`question ${label} names option ${JSON.stringify(id)} twice`);
    }
    // An id that is not on THIS card is the attacker-echo case: an answer is
    // only ever a choice among the options the author actually offered, so an
    // unknown id is refused rather than passed through as a pseudo-option
    // the asking agent would then have to interpret.
    if (!question.options.some((option) => option.id === id)) {
      reject(`question ${label} has no option ${JSON.stringify(id)}`);
    }
    chosen.add(id);
  }
  return {
    questionId: question.id,
    // Card order, not tap order: identical choices serialize identically.
    optionIds: question.options
      .filter((option) => chosen.has(option.id))
      .map((option) => option.id),
  };
}

/**
 * Build the machine tag AND the human content for one submission.
 *
 * Mirrors `buildCardTag`'s contract deliberately: it throws on anything it
 * will not put on the wire, and it generates the text from the answer AS THE
 * PARSER SEES IT rather than from the caller's draft, so the text a plain
 * client reads is provably the text for the payload the machine half carries.
 */
export function buildCardAnswerTag(
  card: DecisionCard,
  cardId: string,
  draft: CardAnswerDraft,
): { tag: string[][]; fallbackContent: string; answer: CardAnswer } {
  requireUniqueIds(card);
  const id = boundedAnswerText(
    cardId,
    ANSWER_LIMITS.maxCardIdChars,
    `card id must be 1-${ANSWER_LIMITS.maxCardIdChars} characters`,
  );
  const rawAnswers = Array.isArray(draft.answers) ? draft.answers : [];
  if (rawAnswers.length === 0) {
    reject("an answer must answer at least one question");
  }
  if (rawAnswers.length > ANSWER_LIMITS.maxAnswers) {
    reject(`an answer carries at most ${ANSWER_LIMITS.maxAnswers} questions`);
  }
  const byQuestionId = new Map(card.questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  const selections: CardAnswerSelection[] = [];
  for (const selection of rawAnswers) {
    if (!isPlainObject(selection) || typeof selection.questionId !== "string") {
      reject("every answer must name a question");
    }
    const questionId = selection.questionId;
    const question = byQuestionId.get(questionId);
    if (!question) {
      reject(`this card has no question ${JSON.stringify(questionId)}`);
    }
    if (seen.has(questionId)) {
      reject(`two answers for question ${JSON.stringify(questionId)}`);
    }
    seen.add(questionId);
    selections.push(buildSelection(question, selection));
  }
  // Card order — the tag and the content agree, and the payload is a
  // function of the choices rather than of the order they were made in.
  selections.sort(
    (a, b) =>
      card.questions.findIndex((q) => q.id === a.questionId) -
      card.questions.findIndex((q) => q.id === b.questionId),
  );

  // A blank note is an ABSENT note, not a refusal — the composer input is
  // always mounted, so "" is what an untouched field submits.
  let note: string | undefined;
  if (draft.note !== undefined) {
    const message = `note must be 1-${ANSWER_LIMITS.maxNoteChars} characters`;
    if (typeof draft.note !== "string") {
      reject(message);
    }
    if (oneLine(draft.note).length > 0) {
      note = boundedAnswerText(draft.note, ANSWER_LIMITS.maxNoteChars, message);
    }
  }

  const answer: CardAnswer = {
    v: 2,
    cardId: id,
    answers: selections,
    // DERIVED. See the module doc: no caller may assert completeness.
    done: selections.length === card.questions.length,
  };
  if (note !== undefined) {
    answer.note = note;
  }
  if (containsUnpairedSurrogate(answer)) {
    // Same refusal as the card builder and for the same measured reason:
    // JSON.stringify escapes a lone surrogate happily and serde_json then
    // cannot decode the payload at all, so the CLI could not read back an
    // answer this builder emitted.
    reject("answer must not contain unpaired surrogates");
  }
  const json = serializeCardAnswerPayload(answer);
  if (json.length > ANSWER_LIMITS.maxTagBytes) {
    reject(
      `answer payload exceeds ${ANSWER_LIMITS.maxTagBytes} characters after serialization`,
    );
  }
  const tag = [["card-answer", json]];
  const parsed = parseCardAnswerTags(tag);
  if (!parsed || !isReadableCardAnswer(parsed)) {
    reject("internal: built answer payload failed its own parse");
  }
  return { tag, fallbackContent: cardAnswerFallbackText(card, parsed), answer };
}

/** The compact wire payload for an already-validated answer. */
export function serializeCardAnswerPayload(answer: CardAnswer): string {
  const payload: Record<string, unknown> = { v: 2, c: answer.cardId };
  payload.a = answer.answers.map((selection) => {
    const entry: Record<string, unknown> = { q: selection.questionId };
    if (selection.text !== undefined) {
      entry.t = selection.text;
    } else {
      entry.o = selection.optionIds;
    }
    return entry;
  });
  if (answer.note !== undefined) {
    payload.n = answer.note;
  }
  payload.done = answer.done;
  return JSON.stringify(payload);
}

// ---- the human half -------------------------------------------------------

/** What one question's line says after the em-dash. */
function selectionText(
  question: CardQuestion,
  selection: CardAnswerSelection | undefined,
): string {
  if (!selection) {
    return "_(not answered)_";
  }
  if (selection.text !== undefined) {
    return selection.text;
  }
  return selection.optionIds
    .map((id) => {
      const option = question.options.find((candidate) => candidate.id === id);
      // Total by construction for a built answer (the builder refuses
      // unknown ids); the id is the honest rendering for anything else.
      return option ? oneLine(option.label) : id;
    })
    .join(", ");
}

/**
 * The `content` an answer event carries — the contract with the asking agent
 * and with every plain client.
 *
 * Exact shape, and it is a CONTRACT, not a presentation choice:
 *
 *     [Answered N of M — the rest are still open.]   <- partials only, + blank line
 *     **<question 1>** — <answer or _(not answered)_>
 *     **<question 2>** — <answer>
 *                                                     <- blank line, note only
 *     _Note: <note>_
 *
 * One line per question OF THE CARD, in author order, answered or not — an
 * omitted line would make "this question was not asked" and "this question
 * was not answered" the same text. Multi-select answers are the chosen
 * labels comma-joined on that one line, in card option order.
 */
export function cardAnswerFallbackText(
  card: DecisionCard,
  answer: CardAnswer,
): string {
  const byQuestionId = new Map(
    answer.answers.map((selection) => [selection.questionId, selection]),
  );
  const lines: string[] = [];
  if (!answer.done) {
    // Leads, so an agent that reads only the first line still learns the
    // interview is unfinished (R4).
    lines.push(
      `Answered ${answer.answers.length} of ${card.questions.length} — the rest are still open.`,
      "",
    );
  }
  for (const question of card.questions) {
    lines.push(
      `**${oneLine(question.question)}** — ${selectionText(question, byQuestionId.get(question.id))}`,
    );
  }
  if (answer.note !== undefined) {
    lines.push("", `_Note: ${answer.note}_`);
  }
  return lines.join("\n");
}

// ---- reading --------------------------------------------------------------

function readBounded(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = cardTrim(value);
  if (trimmed.length === 0 || trimmed.length > maxChars) {
    return null;
  }
  return trimmed;
}

function readSelection(raw: unknown): CardAnswerSelection | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const questionId = readBounded(raw.q, ANSWER_LIMITS.maxIdChars);
  if (!questionId) {
    return null;
  }
  const hasOptions = raw.o !== undefined;
  const hasText = raw.t !== undefined;
  if (hasOptions === hasText) {
    // Neither (an empty answer) and both (ambiguous) are equally unreadable.
    return null;
  }
  if (hasText) {
    const text = readBounded(raw.t, ANSWER_LIMITS.maxTextChars);
    if (!text) {
      return null;
    }
    return { questionId, optionIds: [], text };
  }
  if (!Array.isArray(raw.o)) {
    return null;
  }
  if (raw.o.length === 0 || raw.o.length > ANSWER_LIMITS.maxOptionsPerAnswer) {
    return null;
  }
  const optionIds: string[] = [];
  for (const candidate of raw.o) {
    const id = readBounded(candidate, ANSWER_LIMITS.maxIdChars);
    if (!id || optionIds.includes(id)) {
      return null;
    }
    optionIds.push(id);
  }
  return { questionId, optionIds };
}

/**
 * Read the `card-answer` tag off a signed event's tags.
 *
 * Three outcomes, and the difference between the last two is the badge rule:
 *
 * - `null` — no `card-answer` tag. A v1 reply or a freely-typed one, which
 *   are COMPLETE answers (`askDetection.answeredByMe`).
 * - {@link UNREADABLE_CARD_ANSWER} — a tag is present and could not be read.
 *   Not complete: a future version or a corrupt payload must not be assumed
 *   to have concluded the interview.
 * - the answer.
 *
 * Total: nothing throws, for the same reason the card parser is total — this
 * runs on every event off the relay.
 */
export function parseCardAnswerTags(tags: string[][]): CardAnswer | null {
  // `tag?.[0]`, like parseCardTags: the totality promise is this module's,
  // so a tags array carrying a hole is this module's problem too.
  const matches = tags.filter(
    (tag) => tag?.[0] === "card-answer" && tag.length >= 2,
  );
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    // Two answers in one event: which one is the answer? Unanswerable.
    return UNREADABLE_CARD_ANSWER;
  }
  const payload = matches[0][1];
  if (
    typeof payload !== "string" ||
    payload.length === 0 ||
    payload.length > ANSWER_LIMITS.maxTagBytes
  ) {
    return UNREADABLE_CARD_ANSWER;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return UNREADABLE_CARD_ANSWER;
  }
  if (!isPlainObject(parsed) || containsUnpairedSurrogate(parsed)) {
    return UNREADABLE_CARD_ANSWER;
  }
  // Strict on a number, exactly as the card parser is: `v:"2"` and `v:3` are
  // both unknown versions. There is no v1 answer payload to be lenient about.
  if (parsed.v !== 2) {
    return UNREADABLE_CARD_ANSWER;
  }
  const cardId = readBounded(parsed.c, ANSWER_LIMITS.maxCardIdChars);
  if (!cardId) {
    return UNREADABLE_CARD_ANSWER;
  }
  // `done` must be an explicit boolean. A missing one is NOT "false by
  // default": it is a payload we do not understand, and guessing either way
  // is worse than saying so.
  if (typeof parsed.done !== "boolean") {
    return UNREADABLE_CARD_ANSWER;
  }
  if (
    !Array.isArray(parsed.a) ||
    parsed.a.length === 0 ||
    parsed.a.length > ANSWER_LIMITS.maxAnswers
  ) {
    return UNREADABLE_CARD_ANSWER;
  }
  const answers: CardAnswerSelection[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.a) {
    const selection = readSelection(raw);
    if (!selection || seen.has(selection.questionId)) {
      return UNREADABLE_CARD_ANSWER;
    }
    seen.add(selection.questionId);
    answers.push(selection);
  }
  const answer: CardAnswer = {
    v: 2,
    cardId,
    answers,
    done: parsed.done,
  };
  if (parsed.n !== undefined) {
    const note = readBounded(parsed.n, ANSWER_LIMITS.maxNoteChars);
    if (!note) {
      return UNREADABLE_CARD_ANSWER;
    }
    answer.note = note;
  }
  return answer;
}
