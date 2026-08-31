import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FORUM_COMMENT_KIND,
  FORUM_POST_KIND,
  forumPosts,
  forumThreadReplies,
  isForumThreadRoot,
} from "./forum.ts";
import { timelineMessageFromEvent } from "./messageBuffer.ts";

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

test("kind constants pin the desktop wire values", () => {
  assert.equal(FORUM_POST_KIND, 45001);
  assert.equal(FORUM_COMMENT_KIND, 45003);
});

test("each chat root kind qualifies; overlay and reaction kinds never do", () => {
  for (const kind of [9, 40002, 40008, 45001]) {
    assert.equal(
      isForumThreadRoot(message({ kind })),
      true,
      `kind ${kind} is a thread root`,
    );
  }
  for (const kind of [40003, 7, 5, 20002]) {
    assert.equal(
      isForumThreadRoot(message({ kind })),
      false,
      `kind ${kind} is never a thread root`,
    );
  }
});

test("marker messages are replies, not roots", () => {
  // A kind-45003 comment parsed from root+reply markers: rootId is set.
  const comment = timelineMessageFromEvent(
    event({
      kind: 45003,
      tags: [
        ["h", "chan-1"],
        ["e", "1".repeat(64), "", "root"],
        ["e", "2".repeat(64), "", "reply"],
      ],
    }),
  );
  assert.equal(comment.rootId, "1".repeat(64));
  assert.equal(isForumThreadRoot(comment), false);

  // The alerts-engine append shape: a bare single e tag becomes replyToId.
  const append = timelineMessageFromEvent(
    event({
      kind: 9,
      tags: [
        ["h", "chan-1"],
        ["e", "9".repeat(64), "", "reply"],
      ],
    }),
  );
  assert.equal(append.rootId, null);
  assert.equal(append.replyToId, "9".repeat(64));
  assert.equal(isForumThreadRoot(append), false);

  // A kind-45001 with markers would be a comment in post's clothing — also
  // not a root.
  assert.equal(
    isForumThreadRoot(message({ kind: 45001, replyToId: "9".repeat(64) })),
    false,
  );
});

test("forumPosts returns only roots, newest first", () => {
  const buffer = [
    message({ id: "old-root", kind: 9, createdAt: 100 }),
    message({ id: "reply", kind: 9, replyToId: "old-root", createdAt: 150 }),
    message({ id: "new-root", kind: 45001, createdAt: 300 }),
    message({ id: "mid-root", kind: 40002, createdAt: 200 }),
  ];
  assert.deepEqual(
    forumPosts(buffer).map((m) => m.id),
    ["new-root", "mid-root", "old-root"],
  );
});

test("forumPosts is pure — the input buffer order is untouched", () => {
  const buffer = [
    message({ id: "b", createdAt: 2 }),
    message({ id: "a", createdAt: 1 }),
  ];
  forumPosts(buffer);
  assert.deepEqual(
    buffer.map((m) => m.id),
    ["b", "a"],
  );
});

test("forumThreadReplies matches both marker shapes and sorts ascending", () => {
  const root = message({ id: "root", createdAt: 1 });
  const buffer = [
    // Insert deliberately out of order: a root+reply pair (45003 comment)…
    message({
      id: "comment",
      kind: 45003,
      rootId: "root",
      replyToId: "root",
      createdAt: 30,
    }),
    // …the bare-single-e kind-9 append…
    message({ id: "append", kind: 9, replyToId: "root", createdAt: 10 }),
    // …a nested reply to the append (root marker + reply marker)…
    message({
      id: "nested",
      kind: 9,
      rootId: "root",
      replyToId: "append",
      createdAt: 20,
    }),
    // …and traffic that belongs to other threads.
    message({ id: "elsewhere", replyToId: "zzz", createdAt: 40 }),
    root,
  ];
  assert.deepEqual(
    forumThreadReplies(buffer, "root").map((m) => m.id),
    ["append", "nested", "comment"],
  );
  assert.deepEqual(
    forumThreadReplies(buffer, "zzz").map((m) => m.id),
    ["elsewhere"],
  );
  assert.deepEqual(forumThreadReplies(buffer, "missing"), []);
});
