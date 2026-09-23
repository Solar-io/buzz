import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CONTEXTS,
  MAX_INBOX_MARKERS_PER_DIRECTION,
  READ_STATE_D_TAG_PREFIX,
  READ_STATE_MAX_PLAINTEXT_BYTES,
  buildPublishPayload,
  buildReadStateEventTags,
  isValidReadStateDTag,
  keepNewestMarkers,
  mergeChannelMarkers,
  mergeInboxOverlay,
  mergePayloadBatch,
  nextPublishCreatedAt,
  parseWebReadStateBlob,
} from "./readStateSyncBlob.ts";

// --- channel marker merge -------------------------------------------------

test("mergeChannelMarkers: remote newer advances the local marker", () => {
  const merged = mergeChannelMarkers({ ch1: 100 }, { ch1: 200, ch2: 50 });
  assert.equal(merged.ch1, 200);
  assert.equal(merged.ch2, 50);
});

test("mergeChannelMarkers: remote older or equal is ignored (grow-only)", () => {
  const local = { ch1: 100 };
  const merged = mergeChannelMarkers(local, { ch1: 99 });
  assert.equal(merged, local, "no advancement returns the same reference");
  assert.equal(mergeChannelMarkers(local, { ch1: 100 }), local);
});

test("mergeChannelMarkers: empty local adopts every remote marker", () => {
  const merged = mergeChannelMarkers({}, { ch1: 10, ch2: 20 });
  assert.deepEqual(merged, { ch1: 10, ch2: 20 });
});

test("mergeChannelMarkers drops non-integer and out-of-range entries", () => {
  const merged = mergeChannelMarkers(
    {},
    {
      good: 5,
      float: 1.5,
      negative: -1,
      huge: 4_294_967_296,
    },
  );
  assert.deepEqual(merged, { good: 5 });
});

// --- inbox overlay merge --------------------------------------------------

test("mergeInboxOverlay unions both directions with per-msgId max", () => {
  const local = { read: { a: 100 }, unread: { b: 100 } };
  const remote = { read: { a: 150, c: 50 }, unread: { d: 70 } };
  const merged = mergeInboxOverlay(local, remote);
  assert.deepEqual(merged, {
    read: { a: 150, c: 50 },
    unread: { b: 100, d: 70 },
  });
});

test("mergeInboxOverlay is a same-reference no-op when remote adds nothing", () => {
  const local = { read: { a: 100 }, unread: { b: 50 } };
  assert.equal(
    mergeInboxOverlay(local, { read: { a: 90 }, unread: {} }),
    local,
  );
});

test("MUTATION GUARD: overlay conflict resolves UNREAD-wins (flipping the winner to read fails this)", () => {
  // Local explicitly read msg X; another browser explicitly unread it.
  // The unread flag must survive: a lost "come back to this" is the one
  // loss this merge must never commit.
  const local = { read: { X: 300 }, unread: {} };
  const remote = { read: {}, unread: { X: 200 } };
  const merged = mergeInboxOverlay(local, remote);
  assert.equal("X" in merged.unread, true, "X stays explicitly unread");
  assert.equal("X" in merged.read, false, "X is removed from the read side");
});

test("MUTATION GUARD: overlay conflict unread-wins also holds when the local side unread it", () => {
  // Mirror image: local unread wins over a remote read — union alone would
  // leave X in BOTH maps, so this catches a merge that skips resolution.
  const local = { read: {}, unread: { X: 100 } };
  const remote = { read: { X: 500 }, unread: {} };
  const merged = mergeInboxOverlay(local, remote);
  assert.equal("X" in merged.unread, true);
  assert.equal("X" in merged.read, false);
});

// --- created_at pin -------------------------------------------------------

test("MUTATION GUARD: created_at is pinned past the highest seen (removing the pin fails this)", () => {
  // A local clock 100s behind the newest relay event must still publish
  // newest+1 — returning `now` would publish a losing write.
  const now = 1_000_000;
  const highestSeen = 1_000_100;
  assert.equal(nextPublishCreatedAt(now, highestSeen), 1_000_101);
});

test("nextPublishCreatedAt passes the wall clock through when ahead", () => {
  assert.equal(nextPublishCreatedAt(2_000_000, 1_000_000), 2_000_000);
  assert.equal(
    nextPublishCreatedAt(2_000_500.9, 0),
    2_000_500,
    "floors fractional input",
  );
});

// --- d tag shape ----------------------------------------------------------

test("isValidReadStateDTag accepts exactly 32 lowercase hex after the prefix", () => {
  assert.equal(
    isValidReadStateDTag(
      `${READ_STATE_D_TAG_PREFIX}${"a3f8c2e1d4b7906f5e2a1c8d3b6e9f04"}`,
    ),
    true,
  );
  assert.equal(
    isValidReadStateDTag("read-state:00000000000000000000000000000000"),
    true,
  );
});

test("isValidReadStateDTag rejects wrong length, uppercase, non-hex, missing prefix", () => {
  assert.equal(isValidReadStateDTag("read-state:a3f8c2e1"), false, "too short");
  assert.equal(
    isValidReadStateDTag(`read-state:${"a".repeat(33)}`),
    false,
    "too long",
  );
  assert.equal(
    isValidReadStateDTag(`read-state:${"A".repeat(32)}`),
    false,
    "uppercase",
  );
  assert.equal(
    isValidReadStateDTag(`read-state:${"g".repeat(32)}`),
    false,
    "non-hex",
  );
  assert.equal(
    isValidReadStateDTag("shortcut-bar"),
    false,
    "foreign coordinate",
  );
  assert.equal(isValidReadStateDTag(undefined), false);
  assert.equal(isValidReadStateDTag("read-state:"), false, "empty slot");
});

test("buildReadStateEventTags emits exactly d + t and never an h tag", () => {
  assert.deepEqual(buildReadStateEventTags("a".repeat(32)), [
    ["d", `read-state:${"a".repeat(32)}`],
    ["t", "read-state"],
  ]);
});

// --- blob validation / tolerance ------------------------------------------

test("parseWebReadStateBlob roundtrips a published payload", () => {
  const built = buildPublishPayload({
    clientId: "client-aabbccdd",
    contexts: { ch1: 100 },
    inboxRead: { m1: 100 },
    inboxUnread: { m2: 200 },
  });
  assert.equal(built.ok, true);
  const parsed = parseWebReadStateBlob(built.payload.plaintext);
  assert.deepEqual(parsed, built.payload.blob);
});

test("desktop tolerance: extra top-level fields do not invalidate the blob", () => {
  // The desktop's isValidBlob checks v/client_id/contexts and ignores the
  // rest, so our inbox_* extensions (and any future field) stay readable
  // there — and our validator grants other clients the same courtesy.
  const parsed = parseWebReadStateBlob(
    JSON.stringify({
      v: 1,
      client_id: "desktop-v2-prod",
      contexts: { ctx: 1700000100 },
      future_field: { nested: true },
    }),
  );
  assert.notEqual(parsed, null);
  assert.equal(parsed.contexts.ctx, 1700000100);
});

test("parseWebReadStateBlob rejects bad v, bad client_id, bad contexts, bad JSON", () => {
  assert.equal(
    parseWebReadStateBlob(
      JSON.stringify({ v: 2, client_id: "x", contexts: {} }),
    ),
    null,
  );
  assert.equal(
    parseWebReadStateBlob(JSON.stringify({ v: 1, contexts: {} })),
    null,
  );
  assert.equal(
    parseWebReadStateBlob(
      JSON.stringify({ v: 1, client_id: "", contexts: {} }),
    ),
    null,
  );
  assert.equal(
    parseWebReadStateBlob(
      JSON.stringify({ v: 1, client_id: "x", contexts: [] }),
    ),
    null,
  );
  assert.equal(parseWebReadStateBlob("not json {{{"), null);
});

test("parseWebReadStateBlob sanitizes invalid entries without dropping the blob", () => {
  const parsed = parseWebReadStateBlob(
    JSON.stringify({
      v: 1,
      client_id: "x",
      contexts: { ok: 5, bad: "yesterday", neg: -3 },
    }),
  );
  assert.deepEqual(parsed.contexts, { ok: 5 });
});

// --- decrypt-failure skip semantics ----------------------------------------

test("a batch with one bad payload still yields the good ones", () => {
  const goodDesktop = JSON.stringify({
    v: 1,
    client_id: "desktop",
    contexts: { ch1: 100 },
  });
  const goodWeb = JSON.stringify({
    v: 1,
    client_id: "web",
    contexts: { ch2: 200 },
    inbox_unread: { m9: 50 },
  });
  // null = decrypt failed; bad JSON = decrypt succeeded but payload is junk.
  const merged = mergePayloadBatch([
    goodDesktop,
    null,
    goodWeb,
    "not json {{{",
  ]);
  assert.deepEqual(merged.contexts, { ch1: 100, ch2: 200 });
  assert.deepEqual(merged.inboxUnread, { m9: 50 });
});

test("mergePayloadBatch max-merges duplicate contexts across payloads", () => {
  const a = JSON.stringify({ v: 1, client_id: "a", contexts: { ch1: 100 } });
  const b = JSON.stringify({ v: 1, client_id: "b", contexts: { ch1: 300 } });
  assert.deepEqual(mergePayloadBatch([a, b]).contexts, { ch1: 300 });
});

test("mergePayloadBatch of all-failed payloads yields empty state", () => {
  assert.deepEqual(mergePayloadBatch([null, null]), {
    contexts: {},
    inboxRead: {},
    inboxUnread: {},
  });
});

// --- prune caps and byte ceiling -------------------------------------------

test("keepNewestMarkers keeps the newest max entries", () => {
  const markers = { a: 1, b: 5, c: 3 };
  assert.deepEqual(keepNewestMarkers(markers, 2), { b: 5, c: 3 });
  assert.equal(
    keepNewestMarkers(markers, 3),
    markers,
    "under cap: same reference",
  );
});

test("buildPublishPayload prunes each overlay direction to 500, keep-newest", () => {
  // Short keys so the PRUNED blob fits the 32 KiB ceiling — the entry caps
  // are what this test exercises; the byte ceiling has its own test below.
  // (The contexts 10k cap cannot be reached through the publish path at all:
  // 10k entries cannot fit in 32 KiB, so the byte ceiling always binds first.
  // It is the INCOMING validation limit, covered further up.)
  const inboxRead = {};
  const inboxUnread = {};
  for (let i = 0; i < MAX_INBOX_MARKERS_PER_DIRECTION + 100; i++) {
    inboxRead[`m${i}`] = i;
    inboxUnread[`m${i}`] = i;
  }
  const built = buildPublishPayload({
    clientId: "c",
    contexts: { ch1: 1 },
    inboxRead,
    inboxUnread,
  });
  assert.equal(built.ok, true);
  assert.equal(
    Object.keys(built.payload.blob.inbox_read).length,
    MAX_INBOX_MARKERS_PER_DIRECTION,
  );
  assert.equal(
    Object.keys(built.payload.blob.inbox_unread).length,
    MAX_INBOX_MARKERS_PER_DIRECTION,
  );
  // Keep-newest, not keep-first: the survivors are the HIGHEST timestamps.
  assert.equal(built.payload.blob.inbox_read.m0, undefined);
  assert.notEqual(
    built.payload.blob.inbox_read[`m${MAX_INBOX_MARKERS_PER_DIRECTION + 99}`],
    undefined,
  );
});

test("buildPublishPayload trims a real-sized inbox overlay to fit instead of refusing", () => {
  // Real inbox keys are 64-hex event ids: 500 read entries alone are ~39 KB,
  // past the 32 KiB ceiling. This used to be a permanent refusal, so a heavy
  // inbox never synced again (Sam's web slots, 2026-09-23).
  const hex = (i) => i.toString(16).padStart(64, "0");
  const inboxRead = {};
  for (let i = 0; i < MAX_INBOX_MARKERS_PER_DIRECTION; i++) {
    inboxRead[hex(i)] = 1_790_000_000 + i;
  }
  const inboxUnread = { [hex(9999)]: 1_790_000_999 };
  const contexts = {};
  for (let i = 0; i < 150; i++) {
    contexts[`00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`] =
      1_790_000_000 + i;
  }
  const built = buildPublishPayload({
    clientId: "c",
    contexts,
    inboxRead,
    inboxUnread,
  });
  assert.equal(built.ok, true);
  assert.ok(
    new TextEncoder().encode(built.payload.plaintext).length <=
      READ_STATE_MAX_PLAINTEXT_BYTES,
  );
  // Contexts are never trimmed.
  assert.equal(Object.keys(built.payload.blob.contexts).length, 150);
  // The overlay was cut, keep-newest, and as little as possible.
  const kept = Object.keys(built.payload.blob.inbox_read).length;
  assert.ok(kept < MAX_INBOX_MARKERS_PER_DIRECTION, `kept ${kept}`);
  assert.ok(kept > 300, `kept only ${kept}`);
  assert.equal(built.payload.blob.inbox_read[hex(0)], undefined);
  assert.equal(
    built.payload.blob.inbox_read[hex(MAX_INBOX_MARKERS_PER_DIRECTION - 1)],
    1_790_000_000 + MAX_INBOX_MARKERS_PER_DIRECTION - 1,
  );
  assert.equal(built.payload.blob.inbox_unread[hex(9999)], 1_790_000_999);
});

test("isValidWebReadStateBlob rejects incoming blobs over the 10k context limit", () => {
  const contexts = {};
  for (let i = 0; i <= MAX_CONTEXTS; i++) {
    contexts[`c${i}`] = i;
  }
  const parsed = parseWebReadStateBlob(
    JSON.stringify({ v: 1, client_id: "x", contexts }),
  );
  assert.equal(parsed, null);
});

test("buildPublishPayload omits empty overlay directions (desktop-shaped blob)", () => {
  const built = buildPublishPayload({ clientId: "c", contexts: { ch1: 1 } });
  assert.equal(built.ok, true);
  assert.equal("inbox_read" in built.payload.blob, false);
  assert.equal("inbox_unread" in built.payload.blob, false);
});

test("buildPublishPayload trims oldest channel contexts when contexts alone exceed 32 KiB", () => {
  // Sam's real web store, 2026-09-23: 652 channel markers, 50,047 bytes —
  // a permanent refusal before, so that client had never published.
  const contexts = {};
  for (let i = 0; i < 700; i++) {
    contexts[
      `${i.toString(16).padStart(8, "0")}-0000-4000-8000-${"x".repeat(40)}`
    ] = 1_790_000_000 + i;
  }
  assert.ok(
    new TextEncoder().encode(JSON.stringify(contexts)).length >
      READ_STATE_MAX_PLAINTEXT_BYTES,
    "fixture must exceed the ceiling on contexts alone",
  );
  const built = buildPublishPayload({
    clientId: "c",
    contexts,
    inboxRead: { ["a".repeat(64)]: 1_790_000_500 },
  });
  assert.equal(built.ok, true);
  assert.ok(
    new TextEncoder().encode(built.payload.plaintext).length <=
      READ_STATE_MAX_PLAINTEXT_BYTES,
  );
  const values = Object.values(built.payload.blob.contexts);
  assert.ok(
    values.length > 300 && values.length < 700,
    `kept ${values.length}`,
  );
  // Keep-newest: the highest marker survives, the lowest does not.
  assert.ok(values.includes(1_790_000_699));
  assert.ok(!values.includes(1_790_000_000));
  // The overlay goes first: with contexts alone over budget it is empty.
  assert.equal("inbox_read" in built.payload.blob, false);
});

test("buildPublishPayload still refuses a blob that cannot fit even empty", () => {
  const built = buildPublishPayload({
    clientId: "c".repeat(READ_STATE_MAX_PLAINTEXT_BYTES),
    contexts: { ch1: 1 },
  });
  assert.equal(built.ok, false);
  assert.match(built.reason, /32.?768|cap/);
});
