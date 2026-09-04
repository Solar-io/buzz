import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HUDDLE_ENDED_KIND,
  HUDDLE_STARTED_KIND,
  huddleEndedTarget,
  huddleLinkFromEvent,
  huddleRegistryFilters,
  MAX_CHANNELS_PER_REQ,
} from "./huddleRegistry.ts";

function event(overrides = {}) {
  return {
    kind: 48100,
    created_at: 1_787_800_000,
    tags: [["h", "parent-1"]],
    content: '{"ephemeral_channel_id":"eph-1"}',
    id: "e".repeat(64),
    pubkey: "a".repeat(64),
    sig: "b".repeat(128),
    ...overrides,
  };
}

test("48100 links parent to ephemeral channel", () => {
  const link = huddleLinkFromEvent(event());
  assert.equal(link.parentId, "parent-1");
  assert.equal(link.ephemeralId, "eph-1");
  assert.equal(link.createdBy, "a".repeat(64));
});

test("malformed 48100s yield no link", () => {
  assert.equal(huddleLinkFromEvent(event({ kind: 9 })), null);
  assert.equal(huddleLinkFromEvent(event({ tags: [] })), null);
  assert.equal(huddleLinkFromEvent(event({ content: "{oops" })), null);
  assert.equal(huddleLinkFromEvent(event({ content: '{"other":1}' })), null);
});

test("48103 names the ephemeral channel it ends", () => {
  const ended = huddleEndedTarget(
    event({ kind: 48103, content: '{"ephemeral_channel_id":"eph-2"}' }),
  );
  assert.equal(ended, "eph-2");
  assert.equal(huddleEndedTarget(event()), null, "48100 is not an end");
  assert.equal(
    huddleEndedTarget(event({ kind: 48103, content: "nope" })),
    null,
  );
});

test("48102 is a participant LEAVING, and does not end the huddle", () => {
  // This is the regression the kind fix exists for: 48102 is
  // KIND_HUDDLE_PARTICIPANT_LEFT. Treating it as the end retired the huddle
  // link the first time anyone left the call.
  assert.equal(
    huddleEndedTarget(
      event({ kind: 48102, content: '{"ephemeral_channel_id":"eph-2"}' }),
    ),
    null,
  );
});

test("the end kind matches buzz-core's KIND_HUDDLE_ENDED", () => {
  assert.equal(HUDDLE_ENDED_KIND, 48103);
});

test("every huddle filter carries #h, or the subscription never goes live", () => {
  // Scope is resolved per REQ, not per filter: one filter without #h makes the
  // whole subscription global, and a channel-carrying event is then never a
  // live fan-out candidate for it. The REQ would still return history, which
  // is why this failed silently.
  const filters = huddleRegistryFilters(["c1", "c2", "c3"]);
  assert.equal(filters.length, 1);
  for (const filter of filters) {
    assert.ok(Array.isArray(filter["#h"]), "every filter must carry #h");
    assert.ok(filter["#h"].length > 0, "#h must not be empty");
  }
});

test("the filters ask for both the start and the end kind", () => {
  const [filter] = huddleRegistryFilters(["c1"]);
  assert.deepEqual(filter.kinds, [HUDDLE_STARTED_KIND, HUDDLE_ENDED_KIND]);
});

test("channels are chunked at the relay's explicit-#h cap", () => {
  const ids = Array.from({ length: 300 }, (_, index) => `c${index}`);
  const filters = huddleRegistryFilters(ids);
  // Past the cap the relay answers CLOSED rather than truncating, so an
  // unchunked REQ loses every huddle rather than merely the excess.
  assert.equal(filters.length, 3);
  assert.equal(filters[0]["#h"].length, 128);
  assert.equal(filters[1]["#h"].length, 128);
  assert.equal(filters[2]["#h"].length, 44);
  for (const filter of filters) {
    assert.ok(filter["#h"].length <= MAX_CHANNELS_PER_REQ);
  }
});

test("every channel appears exactly once across the chunks", () => {
  const ids = Array.from({ length: 300 }, (_, index) => `c${index}`);
  const seen = huddleRegistryFilters(ids).flatMap((filter) => filter["#h"]);
  assert.deepEqual(seen, ids);
  assert.equal(new Set(seen).size, 300);
});

test("no channels means no REQ at all, rather than an unscoped one", () => {
  assert.deepEqual(huddleRegistryFilters([]), []);
});
