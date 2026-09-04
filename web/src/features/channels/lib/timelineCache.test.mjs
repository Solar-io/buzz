import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CACHE_CAP,
  INITIAL_PAGE,
  DELTA_CAP,
  applyOverlayToCache,
  cacheKey,
  healCachedEntry,
  initialSyncFilters,
  mergeCachedMessage,
  dropCachedReaction,
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
  assert.equal(
    filters[0].since,
    1_700_000_000,
    "delta refetches inclusively (dedupe by id)",
  );
  assert.equal(filters[0].limit, DELTA_CAP);
  assert.ok(
    filters[1].kinds.includes(EDIT_KIND) && filters[1].kinds.length === 2,
  );
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

// --- dropCachedReaction ------------------------------------------------------
// mergeCachedReaction only ever adds. Without a remover, un-reacting clears the
// live chip but IndexedDB keeps it, so the next reload repaints it from disk.

function entryWith(reactions) {
  return { messages: [], reactions, cursor: 0, historyExhausted: false };
}

test("dropCachedReaction removes only the named author", () => {
  const entry = entryWith(
    new Map([["m1", new Map([["👍", ["alice", "bob"]]])]]),
  );
  const next = dropCachedReaction(
    entry,
    { targetId: "m1", emoji: "👍" },
    "bob",
  );
  assert.deepEqual(next.reactions.get("m1").get("👍"), ["alice"]);
});

test("dropCachedReaction deletes an emoji whose last reactor leaves", () => {
  const entry = entryWith(new Map([["m1", new Map([["👍", ["bob"]]])]]));
  const next = dropCachedReaction(
    entry,
    { targetId: "m1", emoji: "👍" },
    "bob",
  );
  assert.equal(next.reactions.get("m1"), undefined);
});

test("dropCachedReaction keeps other emoji on the same message", () => {
  const entry = entryWith(
    new Map([
      [
        "m1",
        new Map([
          ["👍", ["bob"]],
          ["🔥", ["alice"]],
        ]),
      ],
    ]),
  );
  const next = dropCachedReaction(
    entry,
    { targetId: "m1", emoji: "👍" },
    "bob",
  );
  assert.equal(next.reactions.get("m1").has("👍"), false);
  assert.deepEqual(next.reactions.get("m1").get("🔥"), ["alice"]);
});

test("dropCachedReaction is a no-op for an author who never reacted", () => {
  const entry = entryWith(new Map([["m1", new Map([["👍", ["alice"]]])]]));
  const next = dropCachedReaction(
    entry,
    { targetId: "m1", emoji: "👍" },
    "bob",
  );
  assert.equal(next, entry, "an unrelated author must not clone the entry");
});

test("a merged reaction survives a drop by a different author", () => {
  // Round-trip against the adder, so the two cannot drift into disagreement.
  let entry = entryWith(new Map());
  entry = mergeCachedReaction(entry, { targetId: "m1", emoji: "👍" }, "alice");
  entry = mergeCachedReaction(entry, { targetId: "m1", emoji: "👍" }, "bob");
  entry = dropCachedReaction(entry, { targetId: "m1", emoji: "👍" }, "bob");
  assert.deepEqual(entry.reactions.get("m1").get("👍"), ["alice"]);
});

/**
 * Regression: a message stored before `linkPreviews` existed.
 *
 * `TimelineMessage` is persisted whole, so a build that adds a required field
 * reads back entries without it — TypeScript cannot see the gap, and the
 * renderer threw on `previews.length`, which the error boundary turned into a
 * blank app for every returning user. Observed live against the dev relay on
 * 2026-09-04: 34 of 34 cached messages lacked the field.
 */
const LEGACY_MESSAGE = {
  id: "m-legacy",
  pubkey: "abc",
  content: "written before linkPreviews existed",
  createdAt: 10,
  kind: 40002,
  rootId: null,
  replyToId: null,
  edited: false,
  deleted: false,
  // No linkPreviews, no mentionPubkeys, no imetaByUrl — exactly as an older
  // build wrote it.
};

test("healCachedEntry fills collection fields an older build never wrote", () => {
  const healed = healCachedEntry({
    messages: [LEGACY_MESSAGE],
    reactions: new Map(),
    cursor: 10,
    historyExhausted: false,
  });
  const message = healed.messages[0];
  assert.deepEqual(message.linkPreviews, []);
  assert.deepEqual(message.mentionPubkeys, []);
  assert.ok(message.imetaByUrl instanceof Map);
  assert.equal(message.imetaByUrl.size, 0);
  // Everything the older build DID write survives untouched.
  assert.equal(message.content, "written before linkPreviews existed");
  assert.equal(message.createdAt, 10);
  assert.equal(healed.cursor, 10);
});

test("healCachedEntry leaves a complete entry byte-for-byte alone", () => {
  const previews = [{ url: "https://example.test", title: "t" }];
  const imeta = new Map([["u", { m: "image/png" }]]);
  const message = {
    ...LEGACY_MESSAGE,
    linkPreviews: previews,
    mentionPubkeys: ["deadbeef"],
    imetaByUrl: imeta,
  };
  const entry = {
    messages: [message],
    reactions: new Map(),
    cursor: 10,
    historyExhausted: false,
  };
  const healed = healCachedEntry(entry);
  // Identity, not deep equality: repairing an intact entry would hand the
  // timeline a new array of new objects on every load and defeat memoization.
  assert.equal(healed, entry);
  assert.equal(healed.messages[0], message);
  assert.equal(healed.messages[0].linkPreviews, previews);
  assert.equal(healed.messages[0].imetaByUrl, imeta);
});

test("healCachedEntry does not invent scalar fields", () => {
  const healed = healCachedEntry({
    messages: [LEGACY_MESSAGE],
    reactions: new Map(),
    cursor: 10,
    historyExhausted: false,
  });
  // A missing `content` would mean this is not a message at all; defaulting it
  // would hide that behind a plausible empty row.
  assert.ok(!Object.hasOwn(healed.messages[0], "someFutureScalar"));
  assert.equal(healed.messages[0].deleted, false);
});

test("the cache key carries a version, so a shape change can discard old entries", () => {
  // Pinned to a literal: an expectation written as `timeline:${CACHE_VERSION}`
  // would follow a bump instead of recording that one happened.
  assert.equal(cacheKey("chan-1"), "timeline:v2:chan-1");
});
