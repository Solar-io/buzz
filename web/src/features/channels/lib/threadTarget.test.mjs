import assert from "node:assert/strict";
import { test } from "node:test";
import {
  replyTargetMessage,
  resolveThreadReplyRef,
  threadRepliesOf,
} from "./threadTarget.ts";

const ROOT = "root-id";

function reply(id, createdAt, overrides = {}) {
  return {
    id,
    channelId: "chan-1",
    authorPubkey: "a".repeat(64),
    createdAt,
    content: id,
    kind: 9,
    rootId: ROOT,
    replyToId: ROOT,
    mentionPubkeys: [],
    imetaByUrl: new Map(),
    edited: false,
    deleted: false,
    ...overrides,
  };
}

// Three replies. "middle" is the case the old code could not express: the
// composer always targeted the newest, so replying to anything but the tail
// was impossible.
const FIRST = reply("first", 100);
const MIDDLE = reply("middle", 200);
const NEWEST = reply("newest", 300);
const REPLIES = [FIRST, MIDDLE, NEWEST];

test("no selection targets the thread ROOT, not the newest reply", () => {
  const ref = resolveThreadReplyRef(ROOT, REPLIES, null);
  assert.equal(ref.rootId, ROOT);
  assert.equal(
    ref.replyToId,
    ROOT,
    "the NIP-10 reply marker must name the root when nothing was selected",
  );
  assert.notEqual(
    ref.replyToId,
    "newest",
    "the reply marker must not default to the tail of the thread",
  );
});

test("selecting a MID-THREAD reply targets that reply", () => {
  const ref = resolveThreadReplyRef(ROOT, REPLIES, "middle");
  assert.equal(ref.rootId, ROOT);
  assert.equal(ref.replyToId, "middle");
});

test("selecting the first reply targets the first reply", () => {
  assert.equal(
    resolveThreadReplyRef(ROOT, REPLIES, "first").replyToId,
    "first",
  );
});

test("selecting the newest reply targets the newest reply", () => {
  assert.equal(
    resolveThreadReplyRef(ROOT, REPLIES, "newest").replyToId,
    "newest",
  );
});

test("selecting the root collapses to the root-only ref", () => {
  const ref = resolveThreadReplyRef(ROOT, REPLIES, ROOT);
  assert.equal(ref.rootId, ROOT);
  assert.equal(ref.replyToId, ROOT);
});

test("a selection from another thread never reaches the wire", () => {
  const ref = resolveThreadReplyRef(ROOT, REPLIES, "some-other-thread-reply");
  assert.equal(
    ref.replyToId,
    ROOT,
    "an id outside this thread must fall back to the root",
  );
});

test("an empty thread targets the root", () => {
  assert.equal(resolveThreadReplyRef(ROOT, [], null).replyToId, ROOT);
  assert.equal(resolveThreadReplyRef(ROOT, [], "middle").replyToId, ROOT);
});

test("the banner names a mid-thread target and stays quiet for the root", () => {
  assert.equal(replyTargetMessage(ROOT, REPLIES, "middle"), MIDDLE);
  assert.equal(replyTargetMessage(ROOT, REPLIES, null), null);
  assert.equal(replyTargetMessage(ROOT, REPLIES, ROOT), null);
  assert.equal(replyTargetMessage(ROOT, REPLIES, "not-here"), null);
});

test("threadRepliesOf collects both marker shapes, oldest first", () => {
  // Single-e-tag shape: rootId null, replyToId = the root.
  const singleTag = reply("single", 150, { rootId: null, replyToId: ROOT });
  const unrelated = reply("other", 400, { rootId: "other-root" });
  const found = threadRepliesOf(
    [NEWEST, unrelated, FIRST, singleTag, MIDDLE],
    ROOT,
  );
  assert.equal(found.length, 4, "unrelated threads must not leak in");
  assert.deepEqual(
    found.map((m) => m.id),
    ["first", "single", "middle", "newest"],
  );
});
