import assert from "node:assert/strict";
import { test } from "node:test";
import {
  branchSummary,
  buildThreadEntries,
  buildThreadIndex,
  parentIdOf,
  threadDescendants,
  threadIndentRem,
  THREAD_DEPTH_STEP_REM,
} from "./threadTree.ts";

/**
 * A minimal TimelineMessage. `rootId`/`replyToId` are what
 * `timelineMessageFromEvent` decodes out of the NIP-10 e tags.
 */
function message(id, options = {}) {
  return {
    id,
    channelId: "c",
    authorPubkey: options.author ?? "alice",
    createdAt: options.at ?? 100,
    content: options.content ?? id,
    kind: 9,
    rootId: options.rootId ?? null,
    replyToId: options.replyToId ?? null,
    mentionPubkeys: [],
    imetaByUrl: new Map(),
    linkPreviews: [],
    edited: false,
    deleted: options.deleted ?? false,
  };
}

/**
 * root
 *  ├── a1 (bob)          — has its own branch
 *  │    └── a2 (carol)
 *  │         └── a3 (dave)
 *  └── b1 (erin)         — leaf
 */
function sampleBuffer() {
  return [
    message("root", { at: 10, author: "alice" }),
    message("a1", { at: 20, author: "bob", replyToId: "root" }),
    message("a2", { at: 30, author: "carol", rootId: "root", replyToId: "a1" }),
    message("a3", { at: 40, author: "dave", rootId: "root", replyToId: "a2" }),
    message("b1", { at: 50, author: "erin", replyToId: "root" }),
  ];
}

test("parentIdOf prefers the reply marker over the root marker", () => {
  const nested = message("x", { rootId: "root", replyToId: "a1" });
  assert.equal(parentIdOf(nested), "a1");
});

test("parentIdOf falls back to the root marker when there is no reply marker", () => {
  // NIP-10's own direct-reply-to-root shape. The desktop reads this as
  // parentId null (a top-level message); here it stays inside its thread.
  const rootMarkerOnly = message("x", { rootId: "root", replyToId: null });
  assert.equal(parentIdOf(rootMarkerOnly), "root");
});

test("parentIdOf returns null for a thread root", () => {
  assert.equal(parentIdOf(message("root")), null);
});

test("direct children are keyed by their immediate parent, not the root", () => {
  const index = buildThreadIndex(sampleBuffer());
  assert.deepEqual(
    (index.childrenByParentId.get("root") ?? []).map((m) => m.id),
    ["a1", "b1"],
    "a2 and a3 are NOT children of the root",
  );
  assert.deepEqual(
    (index.childrenByParentId.get("a1") ?? []).map((m) => m.id),
    ["a2"],
  );
  assert.deepEqual(
    (index.childrenByParentId.get("a2") ?? []).map((m) => m.id),
    ["a3"],
  );
});

test("descendantCount counts the whole subtree and directReplyCount does not", () => {
  const index = buildThreadIndex(sampleBuffer());
  const root = index.statsById.get("root");
  assert.equal(root.descendantCount, 4, "a1, a2, a3, b1");
  assert.equal(root.directReplyCount, 2, "a1 and b1 only");
  const a1 = index.statsById.get("a1");
  assert.equal(a1.descendantCount, 2, "a2 and a3");
  assert.equal(a1.directReplyCount, 1, "a2 only");
  assert.equal(index.statsById.get("a3").descendantCount, 0);
});

test("lastReplyAt on an ancestor is the newest descendant, not the newest child", () => {
  const index = buildThreadIndex(sampleBuffer());
  // a1's only child a2 is at 30, but a3 (at 40) is under a2. A per-child
  // rollup would report 30 here.
  assert.equal(index.statsById.get("a1").lastReplyAt, 40);
  assert.equal(index.statsById.get("root").lastReplyAt, 50);
});

test("branch participants are the most recent distinct authors, capped at 3", () => {
  const index = buildThreadIndex(sampleBuffer());
  assert.deepEqual(index.statsById.get("root").participantsNewestFirst, [
    "erin",
    "dave",
    "carol",
  ]);
  // The facepile order reverses it: newest replier ends up rightmost.
  assert.deepEqual(branchSummary(index, "root").participants, [
    "carol",
    "dave",
    "erin",
  ]);
});

test("a deleted reply is not counted", () => {
  const buffer = sampleBuffer();
  buffer[3] = message("a3", {
    at: 40,
    author: "dave",
    rootId: "root",
    replyToId: "a2",
    deleted: true,
  });
  const index = buildThreadIndex(buffer);
  assert.equal(index.statsById.get("root").descendantCount, 3);
  assert.equal(index.statsById.get("a1").descendantCount, 1);
  assert.equal(
    index.statsById.get("root").lastReplyAt,
    50,
    "b1 at 50 still wins",
  );
});

test("branchSummary is null for a leaf", () => {
  const index = buildThreadIndex(sampleBuffer());
  assert.equal(branchSummary(index, "a3"), null);
  assert.equal(branchSummary(index, "b1"), null);
});

test("collapsed: only direct replies render, and a branch shows a summary", () => {
  const index = buildThreadIndex(sampleBuffer());
  const entries = buildThreadEntries(index, "root");
  assert.deepEqual(
    entries.map((entry) => [entry.message.id, entry.depth]),
    [
      ["a1", 1],
      ["b1", 1],
    ],
  );
  assert.equal(entries[0].summary.replyCount, 2, "a1's branch is collapsed");
  assert.equal(entries[1].summary, null, "b1 is a leaf");
});

test("expanding a branch renders it one depth deeper and drops its chip", () => {
  const index = buildThreadIndex(sampleBuffer());
  const entries = buildThreadEntries(index, "root", new Set(["a1"]));
  assert.deepEqual(
    entries.map((entry) => [entry.message.id, entry.depth]),
    [
      ["a1", 1],
      ["a2", 2],
      ["b1", 1],
    ],
  );
  assert.equal(entries[0].summary, null, "an expanded branch has no chip");
  assert.equal(entries[1].summary.replyCount, 1, "a2 still hides a3");
});

test("expanding the whole chain reaches depth 3", () => {
  const index = buildThreadIndex(sampleBuffer());
  const entries = buildThreadEntries(index, "root", new Set(["a1", "a2"]));
  assert.deepEqual(
    entries.map((entry) => [entry.message.id, entry.depth]),
    [
      ["a1", 1],
      ["a2", 2],
      ["a3", 3],
      ["b1", 1],
    ],
  );
});

test("a deleted reply is skipped and its children are promoted to its depth", () => {
  const buffer = sampleBuffer();
  buffer[1] = message("a1", {
    at: 20,
    author: "bob",
    replyToId: "root",
    deleted: true,
  });
  const index = buildThreadIndex(buffer);
  const entries = buildThreadEntries(index, "root");
  assert.deepEqual(
    entries.map((entry) => [entry.message.id, entry.depth]),
    [
      ["a2", 1],
      ["b1", 1],
    ],
    "a2 must not vanish with its deleted parent, and must not indent under nothing",
  );
});

test("a parent cycle terminates instead of hanging", () => {
  const index = buildThreadIndex([
    message("x", { at: 10, replyToId: "y" }),
    message("y", { at: 20, replyToId: "x" }),
  ]);
  assert.ok(index.statsById.get("x").descendantCount >= 1);
  assert.deepEqual(
    buildThreadEntries(index, "x", new Set(["y", "x"])).map(
      (entry) => entry.message.id,
    ),
    ["y"],
    "each message renders at most once",
  );
});

test("threadIndentRem: a direct reply is flush, each level adds one step", () => {
  assert.equal(threadIndentRem(0), 0);
  assert.equal(threadIndentRem(1), 0);
  assert.equal(threadIndentRem(2), THREAD_DEPTH_STEP_REM);
  assert.equal(threadIndentRem(3), 2 * THREAD_DEPTH_STEP_REM);
});

test("threadIndentRem clamps past the deepest visible level", () => {
  // Hardcoded, not derived from the constant: depth 7 is the last distinct
  // step (visible depth 6), and everything deeper shares it.
  assert.equal(threadIndentRem(7), 13.5);
  assert.equal(threadIndentRem(8), 13.5);
  assert.equal(threadIndentRem(40), 13.5);
});

test("threadDescendants returns the whole subtree oldest-first", () => {
  const index = buildThreadIndex(sampleBuffer());
  assert.deepEqual(
    threadDescendants(index, "root").map((m) => m.id),
    ["a1", "a2", "a3", "b1"],
  );
  assert.deepEqual(
    threadDescendants(index, "a1").map((m) => m.id),
    ["a2", "a3"],
  );
});
