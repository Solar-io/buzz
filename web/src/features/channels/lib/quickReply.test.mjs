import assert from "node:assert/strict";
import test from "node:test";

import { detectQuickReply, openQuickReplies } from "./quickReply.ts";
import {
  QUICK_REPLY_NEGATIVES,
  QUICK_REPLY_POSITIVES,
} from "./quickReply.corpus.ts";

const SELF = "a".repeat(64);
const AGENT = "b".repeat(64);

test("every positive fixture is detected", () => {
  // Hardcoded: a corpus that resolved to nothing must not pass.
  assert.equal(QUICK_REPLY_POSITIVES.length, 14);
  for (const content of QUICK_REPLY_POSITIVES) {
    assert.equal(detectQuickReply(content), "yesno", JSON.stringify(content));
  }
});

test("every negative fixture is refused", () => {
  assert.equal(QUICK_REPLY_NEGATIVES.length, 27);
  for (const content of QUICK_REPLY_NEGATIVES) {
    assert.equal(detectQuickReply(content), null, JSON.stringify(content));
  }
});

function message(id, authorPubkey, createdAt, content, overrides = {}) {
  return {
    id,
    authorPubkey,
    createdAt,
    content,
    kind: 9,
    mentionPubkeys: [],
    ...overrides,
  };
}

test("only a question aimed at me opens: it mentions me, or this is a DM", () => {
  const aimed = message("q1", AGENT, 100, "Ship it? Reply yes or no.", {
    mentionPubkeys: [SELF],
  });
  const ambient = message("q2", AGENT, 101, "Ship it? Reply yes or no.");
  assert.deepEqual(
    [...openQuickReplies([aimed, ambient], SELF, { isDm: false })],
    [["q1", "yesno"]],
  );
  assert.deepEqual(
    [...openQuickReplies([aimed, ambient], SELF, { isDm: true }).keys()],
    ["q1", "q2"],
  );
  // No identity, no buttons.
  assert.equal(openQuickReplies([aimed], null, { isDm: true }).size, 0);
});

test("buttons close once I have replied", () => {
  const question = message("q1", AGENT, 100, "Ship it? Reply yes or no.");
  const mine = message("m1", SELF, 105, "Yes");
  assert.equal(openQuickReplies([question], SELF, { isDm: true }).size, 1);
  assert.equal(openQuickReplies([question, mine], SELF, { isDm: true }).size, 0);
  // A question asked AFTER my last message is open again.
  const later = message("q2", AGENT, 110, "And the second one? (yes/no)");
  assert.deepEqual(
    [...openQuickReplies([question, mine, later], SELF, { isDm: true }).keys()],
    ["q2"],
  );
});

test("my own questions, cards, answers, deleted and non-chat rows never open", () => {
  const text = "Ship it? Reply yes or no.";
  const rows = [
    message("own", SELF, 100, text),
    message("card", AGENT, 101, text, { card: { v: 2 } }),
    message("answer", AGENT, 102, text, { cardAnswer: { done: true } }),
    message("gone", AGENT, 103, text, { deleted: true }),
    message("system", AGENT, 104, text, { kind: 40099 }),
  ];
  // `own` is at 100, so anything after it could open — and none of these may.
  assert.equal(openQuickReplies(rows, SELF, { isDm: true }).size, 0);
});
