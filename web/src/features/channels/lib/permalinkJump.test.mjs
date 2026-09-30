import assert from "node:assert/strict";
import { test } from "node:test";
import { permalinkJumpTarget } from "./permalinkJump.ts";

const buffer = [
  { id: "root", rootId: null, replyToId: null },
  { id: "reply", rootId: null, replyToId: "root" },
  { id: "deep", rootId: "root", replyToId: "reply" },
  { id: "orphan", rootId: "gone", replyToId: "gone" },
];

test("a reply's permalink lands on its root row; a top-level one on itself", () => {
  assert.deepEqual(permalinkJumpTarget(buffer, "deep"), {
    isReply: true,
    topLevelId: "root",
  });
  assert.deepEqual(permalinkJumpTarget(buffer, "reply"), {
    isReply: true,
    topLevelId: "root",
  });
  assert.deepEqual(permalinkJumpTarget(buffer, "root"), {
    isReply: false,
    topLevelId: "root",
  });
  // Its root fell out of the buffer: it renders top-level, so it jumps there.
  assert.deepEqual(permalinkJumpTarget(buffer, "orphan"), {
    isReply: false,
    topLevelId: "orphan",
  });
  assert.equal(permalinkJumpTarget(buffer, "missing"), null);
  assert.equal(permalinkJumpTarget(buffer, undefined), null);
});
