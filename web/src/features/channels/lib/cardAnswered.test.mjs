import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The answered-card index and the summary it renders.
 *
 * `DecisionCard.test.mjs` proves the component uses these; this file proves
 * they are right. Every case here is phrased so a wrong answer LOOKS different
 * from a right one — the partial and the stranger's reply are in the buffer
 * for exactly that reason, because an index that simply matched `replyToId`
 * would pass a happy-path-only suite and then clear a card somebody else
 * answered.
 */

const { answeredByMe, answeredCardReplies, cardReplySummary, myReplyToCard } =
  await import("./cardAnswered.ts");
const { parseCardTags } = await import("./decisionCard.ts");

const ME = "a".repeat(64);
const SOMEONE_ELSE = "b".repeat(64);

const CARD_PAYLOAD = {
  v: 2,
  title: "Release shape",
  questions: [
    {
      id: "scope",
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
      ],
    },
  ],
};

const CARD = parseCardTags([["card", JSON.stringify(CARD_PAYLOAD)]]);
assert.ok(CARD, "the fixture card must parse");

function message(overrides) {
  return {
    id: "m",
    channelId: "ch-1",
    authorPubkey: ME,
    createdAt: 100,
    content: "",
    kind: 9,
    rootId: null,
    replyToId: null,
    mentionPubkeys: [],
    imetaByUrl: new Map(),
    linkPreviews: [],
    card: null,
    cardAnswer: null,
    edited: false,
    deleted: false,
    ...overrides,
  };
}

function card(id = "card-1") {
  return message({ id, card: CARD, authorPubkey: SOMEONE_ELSE });
}

function answer(overrides) {
  return message({
    id: "answer-1",
    replyToId: "card-1",
    rootId: "card-1",
    content: "**Which surfaces?** — Web only",
    cardAnswer: {
      v: 2,
      cardId: "card-1",
      answers: [{ questionId: "scope", optionIds: ["web"] }],
      done: true,
    },
    ...overrides,
  });
}

test("answeredCardReplies finds MY completed answer, keyed by the card", () => {
  const index = answeredCardReplies([card(), answer()], ME);
  assert.equal(index.size, 1);
  assert.equal(index.get("card-1")?.id, "answer-1");
});

test("a partial answer does not make the card answered", () => {
  // The discriminating case: same author, same reply target, only `done`
  // differs. An index keyed on `replyToId` alone reports size 1 here.
  const partial = answer({
    cardAnswer: {
      v: 2,
      cardId: "card-1",
      answers: [{ questionId: "scope", optionIds: ["web"] }],
      done: false,
    },
  });
  assert.equal(answeredCardReplies([card(), partial], ME).size, 0);
  assert.equal(answeredByMe(partial, "card-1", ME), false);
  // …and it is still MY reply, which is what the inbox progress chip reads.
  assert.equal(myReplyToCard(partial, "card-1", ME), true);
});

test("someone else's answer never answers the card for me", () => {
  const theirs = answer({ id: "answer-them", authorPubkey: SOMEONE_ELSE });
  assert.equal(answeredCardReplies([card(), theirs], ME).size, 0);
});

test("a v1 plain reply with no tag answers the card", () => {
  // The arm that keeps v1 and dismiss-and-type-freely working: no
  // `card-answer` tag at all is COMPLETE.
  const plain = answer({ cardAnswer: null, content: "Web only" });
  const index = answeredCardReplies([card(), plain], ME);
  assert.equal(index.size, 1);
  assert.equal(cardReplySummary(CARD, index.get("card-1")), "Web only");
});

test("an unreadable card-answer tag is not evidence of an answer", () => {
  const unreadable = answer({
    cardAnswer: { v: 2, cardId: null, answers: [], done: false },
  });
  assert.equal(answeredCardReplies([card(), unreadable], ME).size, 0);
});

test("a deleted answer, and an answer to a deleted card, are not answers", () => {
  assert.equal(
    answeredCardReplies([card(), answer({ deleted: true })], ME).size,
    0,
  );
  assert.equal(
    answeredCardReplies([{ ...card(), deleted: true }, answer()], ME).size,
    0,
  );
});

test("a reply to an ordinary message never lands in the index", () => {
  // The index is restricted to cards present in the buffer, so an ordinary
  // conversation cannot populate it.
  const chatter = message({ id: "chat", authorPubkey: SOMEONE_ELSE });
  const replyToChatter = answer({
    id: "reply-chat",
    replyToId: "chat",
    cardAnswer: null,
    content: "sure",
  });
  const index = answeredCardReplies([card(), chatter, replyToChatter], ME);
  assert.equal(index.size, 0);
});

test("the NEWEST completed answer wins after a partial is finished", () => {
  const first = answer({ id: "answer-early", createdAt: 100 });
  const second = answer({
    id: "answer-late",
    createdAt: 200,
    cardAnswer: {
      v: 2,
      cardId: "card-1",
      answers: [
        { questionId: "scope", optionIds: ["both"] },
        { questionId: "extras", optionIds: ["docs", "tests"] },
      ],
      done: true,
    },
  });
  // Buffer order is deliberately newest-first, so a "last one wins" index
  // that ignored createdAt would pick the early one.
  const index = answeredCardReplies([card(), second, first], ME);
  assert.equal(index.get("card-1")?.id, "answer-late");
});

test("no self pubkey means no answers, not everyone's answers", () => {
  assert.equal(answeredCardReplies([card(), answer()], null).size, 0);
});

test("the summary reads option LABELS from the card, in card order", () => {
  const full = answer({
    cardAnswer: {
      v: 2,
      cardId: "card-1",
      answers: [
        // Deliberately out of card order in the tag.
        { questionId: "extras", optionIds: ["docs", "tests"] },
        { questionId: "scope", optionIds: ["both"] },
      ],
      done: true,
    },
  });
  assert.equal(cardReplySummary(CARD, full), "Web + desktop · Docs, Tests");
});

test("a typed answer summarises as the typed text", () => {
  const typed = answer({
    cardAnswer: {
      v: 2,
      cardId: "card-1",
      answers: [
        { questionId: "scope", optionIds: [], text: "only the iOS shell" },
      ],
      done: true,
    },
  });
  assert.equal(cardReplySummary(CARD, typed), "only the iOS shell");
});

test("a tag naming questions this card lacks falls back to the content", () => {
  const foreign = answer({
    content: "answered elsewhere",
    cardAnswer: {
      v: 2,
      cardId: "card-1",
      answers: [{ questionId: "nope", optionIds: ["web"] }],
      done: true,
    },
  });
  assert.equal(cardReplySummary(CARD, foreign), "answered elsewhere");
});
