import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CACHE_CAP,
  INITIAL_PAGE,
  DELTA_CAP,
  applyOverlayToCache,
  initialSyncFilters,
  mergeCachedMessage,
  mergeCachedReaction,
  olderPageFilter,
} from "./timelineCache.ts";
import { EDIT_KIND } from "./messageBuffer.ts";

function entry(overrides = {}) {
  return {
    messages: [],
    reactions: new Map(),
    cursor: 0,
    historyExhausted: false,
    ...overrides,
  };
}

function msg(id, createdAt, content = `m-${id}`) {
  return {
    id,
    channelId: "chan",
    authorPubkey: "aa",
    createdAt,
    content,
    kind: 9,
    rootId: null,
    replyToId: null,
    mentionPubkeys: [],
    edited: false,
    deleted: false,
  };
}

test("mergeCachedMessage inserts in order and advances the cursor", () => {
  let e = entry();
  e = mergeCachedMessage(e, msg("b", 200));
  e = mergeCachedMessage(e, msg("a", 100));
  assert.deepEqual(
    e.messages.map((m) => m.id),
    ["a", "b"],
  );
  assert.equal(e.cursor, 200);
  // An older-than-cursor straggler does not rewind the watermark.
  e = mergeCachedMessage(e, msg("z", 50));
  assert.equal(e.cursor, 200);
});

test("mergeCachedMessage dedupes by id and caps storage", () => {
  let e = entry();
  for (let i = 0; i < CACHE_CAP + 25; i++) {
    e = mergeCachedMessage(e, msg(`id-${i}`, 1000 + i));
  }
  assert.equal(e.messages.length, CACHE_CAP);
  assert.deepEqual(
    e.messages.slice(0, 2).map((m) => m.id),
    ["id-25", "id-26"],
    "cap drops the OLDEST rows",
  );
  const before = e.messages;
  e = mergeCachedMessage(e, { ...msg("id-30", 1030), content: "again" });
  assert.equal(e.messages.length, CACHE_CAP);
  assert.equal(e.messages.find((m) => m.id === "id-30")?.content, "again");
  assert.notEqual(e.messages, before, "replacement yields a new array");
});

test("applyOverlayToCache edits patch and deletes REMOVE (no resurrection)", () => {
  let e = entry({ messages: [msg("a", 100), msg("b", 200)] });
  e = applyOverlayToCache(e, EDIT_KIND, "a", "edited text");
  assert.equal(e.messages.find((m) => m.id === "a")?.content, "edited text");
  assert.equal(e.messages.find((m) => m.id === "a")?.edited, true);
  const deleted = applyOverlayToCache(e, 5, "b", null);
  assert.equal(
    deleted.messages.find((m) => m.id === "b"),
    undefined,
    "deleted rows leave the cache entirely",
  );
  assert.equal(deleted.messages.length, 1);
  // Unknown target and no-content edit are no-ops.
  assert.equal(applyOverlayToCache(e, EDIT_KIND, "nope", "x"), e);
  assert.equal(applyOverlayToCache(e, EDIT_KIND, "a", null), e);
});

test("mergeCachedReaction dedupes per author and emoji", () => {
  let e = entry();
  e = mergeCachedReaction(e, { targetId: "t1", emoji: "🔥" }, "aa");
  e = mergeCachedReaction(e, { targetId: "t1", emoji: "🔥" }, "aa");
  e = mergeCachedReaction(e, { targetId: "t1", emoji: "🔥" }, "bb");
  assert.deepEqual(
    e.reactions.get("t1")?.get("🔥"),
    ["aa", "bb"],
    "same-author duplicate is ignored, second author recorded",
  );
});

test("initialSyncFilters: cold start fetches one newest page", () => {
  const filters = initialSyncFilters("chan", null);
  assert.equal(filters.length, 1);
  assert.equal(filters[0].limit, INITIAL_PAGE);
  assert.equal(filters[0].since, undefined);
  assert.ok(filters[0].kinds.includes(9));
  assert.ok(filters[0].kinds.includes(7));
});

test("initialSyncFilters: warm start is a since-delta plus overlay backfill", () => {
  const filters = initialSyncFilters("chan", 1_700_000_000);
  assert.equal(filters.length, 2);
  assert.equal(filters[0].since, 1_700_000_000, "delta refetches inclusively (dedupe by id)");
  assert.equal(filters[0].limit, DELTA_CAP);
  assert.ok(filters[1].kinds.includes(EDIT_KIND) && filters[1].kinds.length === 2);
  assert.ok(
    (filters[1].since ?? 0) < 1_700_000_000,
    "overlay backfill reaches BELOW the watermark",
  );
  const coldZero = initialSyncFilters("chan", 0);
  assert.equal(coldZero.length, 1, "cursor 0 counts as cold");
});

test("olderPageFilter steps strictly below the oldest loaded row", () => {
  const f = olderPageFilter("chan", 1_700_000_500);
  assert.equal(f.until, 1_700_000_499);
  assert.equal(f.limit, 60);
  assert.equal(f["#h"][0], "chan");
  // Zero floor never goes negative.
  assert.equal(olderPageFilter("chan", 0).until, 0);
});
