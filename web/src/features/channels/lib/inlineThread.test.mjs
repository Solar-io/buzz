import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("the chip counts the larger of loaded and summarized replies", () => {
  assert.equal(inlineReplyCount(2, 5), 5);
  assert.equal(inlineReplyCount(4, 1), 4);
  assert.equal(inlineReplyCount(0, 0), 0);
  assert.equal(replyCountLabel(1), "1 reply");
  assert.equal(replyCountLabel(2), "2 replies");
});
