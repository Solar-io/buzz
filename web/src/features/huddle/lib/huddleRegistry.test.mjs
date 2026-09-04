import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HUDDLE_ENDED_KIND,
  huddleEndedTarget,
  huddleLinkFromEvent,
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
