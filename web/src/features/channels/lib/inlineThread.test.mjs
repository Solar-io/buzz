import assert from "node:assert/strict";
import test from "node:test";

import {
  foldReplies,
  INLINE_THREAD_WINDOW,
  inlineReplyCount,
  inlineThreadRef,
  inlineThreadWindow,
  replyCountLabel,
} from "./inlineThread.ts";

test("a root row answers itself with one id for both markers", () => {
  assert.deepEqual(
    inlineThreadRef({ id: "root", rootId: null, replyToId: null }),
    { rootId: "root", replyToId: "root" },
  );
});

test("a reply to a reply carries the thread root", () => {
  // An orphan row: a reply to a reply whose root fell outside the buffer.
  // Replying under it must name the REAL root — the relay refuses a
  // self-rooted reply with "root tag does not match thread ancestry".
  assert.deepEqual(
    inlineThreadRef({ id: "reply-2", rootId: "root", replyToId: "reply-1" }),
    { rootId: "root", replyToId: "reply-2" },
  );
  // A plain reply carries only a reply marker: its parent IS the root.
  assert.deepEqual(
    inlineThreadRef({ id: "reply-1", rootId: null, replyToId: "root" }),
    { rootId: "root", replyToId: "reply-1" },
  );
});

test("a long thread shows the last six and counts the rest", () => {
  // Hardcoded, never derived from the constant under test.
  assert.equal(INLINE_THREAD_WINDOW, 6);
  const replies = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"];
  assert.deepEqual(inlineThreadWindow(replies, false), {
    visible: ["r4", "r5", "r6", "r7", "r8", "r9"],
    hidden: 3,
  });
  assert.deepEqual(inlineThreadWindow(replies, true), {
    visible: replies,
    hidden: 0,
  });
  // Exactly the window: nothing to hide, no "Show 0 earlier".
  assert.deepEqual(inlineThreadWindow(replies.slice(0, 6), false), {
    visible: ["r1", "r2", "r3", "r4", "r5", "r6"],
    hidden: 0,
  });
  assert.deepEqual(inlineThreadWindow([], false), { visible: [], hidden: 0 });
});

function reply(id, createdAt, rootId, replyToId, overrides = {}) {
  return {
    id,
    channelId: "c",
    authorPubkey: "a".repeat(64),
    createdAt,
    content: id,
    kind: 9,
    rootId,
    replyToId,
    mentionPubkeys: [],
    edited: false,
    deleted: false,
    ...overrides,
  };
}

const ids = (list) => (list ?? []).map((message) => message.id);

test("replies fold under their root at any depth, oldest first, deleted dropped", () => {
  const messages = [
    reply("root", 100, null, null),
    reply("r2", 130, "root", "r1"),
    reply("r1", 110, null, "root"),
    reply("gone", 120, null, "root", { deleted: true }),
    // Names the root, but its PARENT never loaded: a walk down from the root
    // cannot reach it, and the root marker still claims it.
    reply("stranded", 125, "root", "missing-parent"),
    reply("other-root", 105, null, null),
    reply("other-reply", 140, null, "other-root"),
  ];
  const { rowOf, replies } = foldReplies(messages);
  assert.deepEqual(ids(replies.get("root")), ["r1", "stranded", "r2"]);
  assert.deepEqual(ids(replies.get("other-root")), ["other-reply"]);
  // The two rows are rows; everything else folds — the deleted reply too,
  // so it cannot resurface at the top level.
  assert.deepEqual(
    [...rowOf.entries()].sort(([a], [b]) => a.localeCompare(b)),
    [
      ["gone", "root"],
      ["other-reply", "other-root"],
      ["r1", "root"],
      ["r2", "root"],
      ["stranded", "root"],
    ],
  );
  assert.equal(rowOf.has("root"), false);
  assert.equal(replies.has("r2"), false);
});

test("with the root unloaded, replies fold under the oldest loaded ancestor", () => {
  // Root R is outside the buffer. p1 answered R; p2 answered p1; m answered p2.
  const messages = [
    reply("p1", 100, null, "R"),
    reply("p2", 110, "R", "p1"),
    reply("m", 120, "R", "p2"),
    // A reply whose parent AND root are both missing is a row of its own.
    reply("lone", 130, "X", "Y"),
  ];
  const { rowOf, replies } = foldReplies(messages);
  assert.deepEqual(ids(replies.get("p1")), ["p2", "m"]);
  assert.equal(rowOf.has("p1"), false, "the orphan is the row");
  assert.equal(rowOf.has("lone"), false);
  assert.equal(rowOf.get("m"), "p1");
  // Every message is a row or folds under one: nothing is lost, nothing twice.
  const rows = messages.filter((message) => !rowOf.has(message.id));
  const folded = [...replies.values()].flat();
  assert.equal(rows.length + folded.length, messages.length);
});

test("a parent cycle terminates", () => {
  const messages = [
    reply("a", 100, null, "b"),
    reply("b", 110, null, "a"),
  ];
  const { rowOf } = foldReplies(messages);
  assert.equal(rowOf.size <= 2, true);
});

test("the chip counts the larger of loaded and summarized replies", () => {
  assert.equal(inlineReplyCount(2, 5), 5);
  assert.equal(inlineReplyCount(4, 1), 4);
  assert.equal(inlineReplyCount(0, 0), 0);
  assert.equal(replyCountLabel(1), "1 reply");
  assert.equal(replyCountLabel(2), "2 replies");
});
