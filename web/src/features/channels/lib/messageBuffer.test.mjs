import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyOverlay,
  editTargetFromEvent,
  replyCounts,
  threadReplies,
  timelineMessageFromEvent,
  upsertMessage,
  EDIT_KIND,
  DELETE_KIND,
} from "./messageBuffer.ts";

function event(overrides = {}) {
  return {
    kind: 9,
    created_at: 1_787_800_000,
    tags: [["h", "chan-1"]],
    content: "hello",
    id: "e".repeat(64),
    pubkey: "a".repeat(64),
    sig: "b".repeat(128),
    ...overrides,
  };
}

function message(overrides = {}) {
  return {
    id: "m1",
    channelId: "chan-1",
    authorPubkey: "a".repeat(64),
    createdAt: 1_787_800_000,
    content: "hi",
    kind: 9,
    rootId: null,
    replyToId: null,
    mentionPubkeys: [],
    edited: false,
    deleted: false,
    ...overrides,
  };
}

test("parses h tag, markers, and mentions", () => {
  const parsed = timelineMessageFromEvent(
    event({
      tags: [
        ["h", "chan-1"],
        ["e", "1".repeat(64), "", "root"],
        ["e", "2".repeat(64), "", "reply"],
        ["p", "c".repeat(64)],
        ["p", "d".repeat(64)],
      ],
    }),
  );
  assert.equal(parsed.rootId, "1".repeat(64));
  assert.equal(parsed.replyToId, "2".repeat(64));
  assert.deepEqual(parsed.mentionPubkeys, ["c".repeat(64), "d".repeat(64)]);
});

test("single unmarked e tag becomes the reply parent", () => {
  const parsed = timelineMessageFromEvent(
    event({
      tags: [
        ["h", "chan-1"],
        ["e", "9".repeat(64), "", ""],
      ],
    }),
  );
  assert.equal(parsed.rootId, null);
  assert.equal(parsed.replyToId, "9".repeat(64));
});

test("events without an h tag are rejected", () => {
  assert.equal(timelineMessageFromEvent(event({ tags: [] })), null);
});

test("upsert dedupes by id and keeps chronological order", () => {
  const early = message({ id: "early", createdAt: 100 });
  const late = message({ id: "late", createdAt: 200 });
  let buffer = upsertMessage([], late);
  buffer = upsertMessage(buffer, early);
  assert.deepEqual(
    buffer.map((m) => m.id),
    ["early", "late"],
  );
  buffer = upsertMessage(buffer, early);
  assert.equal(buffer.length, 2, "duplicate insert is a no-op");
});

test("upsert caps the buffer at the newest cap messages", () => {
  let buffer = [];
  for (let i = 0; i < 8; i++) {
    buffer = upsertMessage(buffer, message({ id: `m${i}`, createdAt: i }), 5);
  }
  assert.deepEqual(
    buffer.map((m) => m.id),
    ["m3", "m4", "m5", "m6", "m7"],
  );
});

test("threadReplies finds marker replies and legacy single-tag replies", () => {
  const root = message({ id: "root", createdAt: 1 });
  const nestedReply = message({
    id: "r1",
    rootId: "root",
    replyToId: "root",
    createdAt: 2,
  });
  const deepReply = message({
    id: "r2",
    rootId: "root",
    replyToId: "r1",
    createdAt: 3,
  });
  const legacyReply = message({ id: "r3", replyToId: "root", createdAt: 4 });
  const other = message({ id: "x", replyToId: "zzz", createdAt: 5 });
  const buffer = [root, nestedReply, deepReply, legacyReply, other];
  assert.deepEqual(
    threadReplies(buffer, "root").map((m) => m.id),
    ["r1", "r2", "r3"],
  );
});

test("replyCounts aggregates by effective root", () => {
  const buffer = [
    message({ id: "a", rootId: "t1", replyToId: "t1" }),
    message({ id: "b", replyToId: "t1" }),
    message({ id: "c", rootId: "t2", replyToId: "x" }),
  ];
  assert.equal(replyCounts(buffer).get("t1"), 2);
  assert.equal(replyCounts(buffer).get("t2"), 1);
});

test("editTargetFromEvent reads the e tag of edit/delete kinds only", () => {
  const target = "f".repeat(64);
  assert.equal(
    editTargetFromEvent(
      event({
        kind: EDIT_KIND,
        tags: [
          ["h", "chan-1"],
          ["e", target],
        ],
      }),
    ),
    target,
  );
  assert.equal(
    editTargetFromEvent(
      event({
        kind: DELETE_KIND,
        tags: [
          ["h", "chan-1"],
          ["e", target],
        ],
      }),
    ),
    target,
  );
  // Chat kinds and overlay events without an e tag have no target.
  assert.equal(editTargetFromEvent(event({ id: target })), null);
  assert.equal(
    editTargetFromEvent(event({ kind: EDIT_KIND, tags: [["h", "chan-1"]] })),
    null,
  );
});

test("applyOverlay edits content and flags the marker without mutating input", () => {
  const original = message({ id: "tgt", content: "before" });
  const next = applyOverlay([original], EDIT_KIND, "tgt", "after");
  assert.equal(next[0].content, "after");
  assert.equal(next[0].edited, true);
  assert.equal(original.content, "before", "input buffer is untouched");
  assert.equal(original.edited, false);
});

test("applyOverlay delete hides the row; unknown targets reuse the reference", () => {
  const buffer = [message({ id: "tgt" })];
  const deleted = applyOverlay(buffer, DELETE_KIND, "tgt", null);
  assert.equal(deleted[0].deleted, true);
  assert.equal(buffer[0].deleted, false, "input buffer is untouched");
  const same = applyOverlay(buffer, DELETE_KIND, "missing", null);
  assert.equal(same, buffer, "no match returns the same reference");
  // An edit without content is not an edit at all.
  const noContent = applyOverlay(buffer, EDIT_KIND, "tgt", null);
  assert.equal(noContent, buffer, "null content is a no-op");
});
