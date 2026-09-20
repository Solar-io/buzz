import assert from "node:assert/strict";
import { test } from "node:test";

import {
  askInterviewBadgeCount,
  groupAskInterviews,
  interviewIdOf,
} from "./askInterview.ts";
import { parseCardTags } from "@/features/channels/lib/decisionCard.ts";

/**
 * The grouping rule, exercised against the shape the relay actually produces:
 * a round-2 card is a REPLY to round 1's answer, so it carries round 1's
 * thread root and round 1's answer as its parent. Every fixture below is
 * built that way rather than by setting `rootId` to whatever would make the
 * assertion pass.
 */

const AGENT = "2".repeat(64);
const CHANNEL = "ch-1";

function cardWith(questionCount) {
  const card = parseCardTags([
    [
      "card",
      JSON.stringify({
        v: 2,
        title: "Release shape",
        questions: Array.from({ length: questionCount }, (_, index) => ({
          id: `q${index}`,
          question: `Question ${index}?`,
          options: [
            { id: "a", label: "Alpha" },
            { id: "b", label: "Beta" },
          ],
        })),
      }),
    ],
  ]);
  assert.ok(card, "the fixture payload must parse");
  return card;
}

/** A top-level (round 1) ask. */
function ask(id, createdAt, questionCount = 2) {
  return {
    id,
    channelId: CHANNEL,
    channelType: "stream",
    authorPubkey: AGENT,
    createdAt,
    card: cardWith(questionCount),
    rootId: null,
    replyToId: null,
  };
}

/**
 * A follow-up ask, published `--reply-to <answer event id>`: its NIP-10 root
 * is the ROUND-1 CARD and its parent is the answer event. That asymmetry is
 * the reason grouping keys on the root and not on the parent.
 */
function followUp(id, createdAt, rootCardId, answerId, questionCount = 2) {
  return {
    ...ask(id, createdAt, questionCount),
    rootId: rootCardId,
    replyToId: answerId,
  };
}

// ---- identity --------------------------------------------------------------

test("interviewIdOf: a top-level card is its own interview", () => {
  assert.equal(interviewIdOf(ask("card-1", 100)), "card-1");
});

test("interviewIdOf: a follow-up card resolves to the thread root", () => {
  assert.equal(
    interviewIdOf(followUp("card-2", 300, "card-1", "answer-1")),
    "card-1",
  );
});

test("interviewIdOf: a card replying with no root falls back to its parent", () => {
  // The NIP-10 shape a plain reply carries: a reply marker and no root, so
  // the parent IS the root (the same chain `cardAnswer.ts` uses to satisfy
  // the relay's ancestry check).
  assert.equal(
    interviewIdOf({ id: "card-2", rootId: null, replyToId: "card-1" }),
    "card-1",
  );
});

// ---- grouping --------------------------------------------------------------

test("two cards in one thread collapse to one row", () => {
  // THE grouping assertion, and the fixture is chosen so the COUNT is what
  // discriminates: both cards are open, so keying the fold on `ask.id`
  // instead of the thread root yields 2 rows. That is the live regression it
  // stands for — a superseded round-1 question presented as though it were
  // still waiting alongside round 2.
  const rows = groupAskInterviews(
    [ask("card-1", 100), followUp("card-2", 300, "card-1", "answer-1")],
    {},
  );
  assert.equal(rows.length, 1, "one interview, one row");
  assert.equal(rows[0].id, "card-1", "keyed on the thread root");
  assert.equal(rows[0].ask.id, "card-2", "showing the newest open card");
});

test("a thread whose earlier round is answered is still one row", () => {
  // The ordinary refinement shape: round 1 answered, round 2 waiting.
  const rows = groupAskInterviews(
    [ask("card-1", 100), followUp("card-2", 300, "card-1", "answer-1")],
    { "card-1": "answer-1" },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "card-1", "keyed on the thread root");
  assert.equal(rows[0].ask.id, "card-2");
  assert.equal(rows[0].earlier, 0, "the answered round is not still waiting");
});

test("two cards in DIFFERENT threads stay two rows", () => {
  // The discriminator: a grouper that collapsed everything would pass the
  // case above.
  const rows = groupAskInterviews([ask("card-1", 100), ask("card-9", 200)], {});
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["card-9", "card-1"],
    "newest interview first",
  );
});

test("the representative is the NEWEST unanswered card, not the newest card", () => {
  const rows = groupAskInterviews(
    [
      ask("card-1", 100),
      followUp("card-2", 300, "card-1", "answer-1"),
      followUp("card-3", 500, "card-1", "answer-2"),
    ],
    { "card-1": "answer-1", "card-3": "answer-3" },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ask.id, "card-2", "card-3 is answered; card-2 is not");
});

test("an interview with every round answered produces no row", () => {
  const rows = groupAskInterviews(
    [ask("card-1", 100), followUp("card-2", 300, "card-1", "answer-1")],
    { "card-1": "answer-1", "card-2": "answer-2" },
  );
  assert.deepEqual(rows, []);
});

// ---- round numbering -------------------------------------------------------

test("the round number counts the card's position in the thread", () => {
  const rows = groupAskInterviews(
    [
      ask("card-1", 100),
      followUp("card-2", 300, "card-1", "answer-1"),
      followUp("card-3", 500, "card-1", "answer-2"),
    ],
    { "card-1": "answer-1", "card-2": "answer-2" },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].round, 3, "card-3 is the third card in its thread");
  assert.equal(rows[0].rounds, 3);
});

test("a round-1 card is round 1, whatever order the asks arrive in", () => {
  // Input order is the feed's, which is newest-first — the fold must sort.
  const rows = groupAskInterviews(
    [followUp("card-2", 300, "card-1", "answer-1"), ask("card-1", 100)],
    {},
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].round, 2, "the row shows round 2");
  assert.equal(rows[0].ask.id, "card-2");
});

test("an answered round-1 card still counts toward the round number", () => {
  // The reason answered asks are an input at all: fold only the unanswered
  // set and this reads 1.
  const rows = groupAskInterviews(
    [ask("card-1", 100), followUp("card-2", 300, "card-1", "answer-1")],
    { "card-1": "answer-1" },
  );
  assert.equal(rows[0].round, 2);
});

// ---- the +N earlier affordance --------------------------------------------

test("a second unanswered card in one thread counts as earlier, not as a row", () => {
  const rows = groupAskInterviews(
    [ask("card-1", 100), followUp("card-2", 300, "card-1", "answer-1")],
    {},
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ask.id, "card-2", "the newest open card leads");
  assert.equal(rows[0].earlier, 1, "one older question is still open");
});

test("a single open card has nothing earlier", () => {
  const rows = groupAskInterviews([ask("card-1", 100)], {});
  assert.equal(rows[0].earlier, 0);
});

// ---- progress --------------------------------------------------------------

test("progress totals come from the CARD, not from the partial answer", () => {
  const rows = groupAskInterviews([ask("card-1", 100, 4)], {});
  assert.deepEqual(rows[0].progress, { answered: 0, total: 4 });
});

test("a published partial supplies the answered half of the chip", () => {
  const rows = groupAskInterviews(
    [ask("card-1", 100, 4)],
    {},
    {
      "card-1": { answered: 2, total: 4, at: 200 },
    },
  );
  assert.deepEqual(rows[0].progress, { answered: 2, total: 4 });
});

test("a partial recorded against another card does not leak into this row", () => {
  const rows = groupAskInterviews(
    [ask("card-1", 100, 4)],
    {},
    {
      "card-9": { answered: 3, total: 4, at: 200 },
    },
  );
  assert.equal(rows[0].progress.answered, 0);
});

test("a v1 single-question card reports one question", () => {
  const card = parseCardTags([
    [
      "card",
      JSON.stringify({
        v: 1,
        title: "Ship it?",
        options: [{ label: "Yes" }, { label: "No" }],
      }),
    ],
  ]);
  assert.ok(card, "the v1 payload must parse");
  const rows = groupAskInterviews([{ ...ask("card-1", 100), card }], {});
  assert.deepEqual(rows[0].progress, { answered: 0, total: 1 });
  assert.equal(rows[0].round, 1, "and no round chip is earned");
});

// ---- the badge -------------------------------------------------------------

test("the badge counts ROWS, so it can never exceed what the inbox shows", () => {
  const rows = groupAskInterviews(
    [
      ask("card-1", 100),
      followUp("card-2", 300, "card-1", "answer-1"),
      ask("card-9", 200),
    ],
    {},
  );
  assert.equal(rows.length, 2);
  assert.equal(askInterviewBadgeCount(rows), 2);
});

test("the badge is zero when every interview is answered", () => {
  assert.equal(
    askInterviewBadgeCount(
      groupAskInterviews([ask("card-1", 100)], { "card-1": "answer-1" }),
    ),
    0,
  );
});
