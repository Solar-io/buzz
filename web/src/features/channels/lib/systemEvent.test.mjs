import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeSystemEvent,
  systemEventFromContent,
  tombstoneTargetId,
  SYSTEM_MESSAGE_KIND,
} from "./systemEvent.ts";
import { MESSAGE_SEARCH_KINDS, TIMELINE_KINDS } from "./messageBuffer.ts";
import {
  initialSyncFilters,
  olderPageFilter,
} from "./timelineCache.ts";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const MOD = "c".repeat(64);
const TARGET_EVENT = "d".repeat(64);

const labels = { [ALICE]: "Alice", [BOB]: "Bob", [MOD]: "Mod" };
const resolve = (pubkey) => (pubkey ? (labels[pubkey] ?? pubkey) : "Someone");

function describe(payload) {
  return describeSystemEvent(systemEventFromContent(JSON.stringify(payload)), resolve);
}

// --- kind wiring -----------------------------------------------------------
// 40099 is hardcoded on purpose: deriving it from the constant under test
// would make these assertions self-satisfying.

test("SYSTEM_MESSAGE_KIND is buzz-core's KIND_SYSTEM_MESSAGE", () => {
  assert.equal(SYSTEM_MESSAGE_KIND, 40099);
});

test("40099 renders a timeline row", () => {
  assert.ok(
    TIMELINE_KINDS.includes(40099),
    "system messages must be a timeline row kind",
  );
});

test("40099 is excluded from full-text search kinds (JSON body)", () => {
  assert.ok(!MESSAGE_SEARCH_KINDS.includes(40099));
  assert.ok(MESSAGE_SEARCH_KINDS.includes(9));
});

test("the channel subscription asks the relay for 40099", () => {
  const cold = initialSyncFilters("chan-1", null);
  assert.equal(cold.length, 1);
  assert.ok(
    cold[0].kinds.includes(40099),
    "cold-start sync must subscribe to system messages",
  );

  const warm = initialSyncFilters("chan-1", 1_700_000_000);
  assert.ok(
    warm[0].kinds.includes(40099),
    "warm-start delta must subscribe to system messages",
  );

  assert.ok(
    olderPageFilter("chan-1", 1_700_000_500).kinds.includes(40099),
    "scroll-up pages must include system messages",
  );
});

// --- payload parsing -------------------------------------------------------

test("non-JSON and non-object bodies parse to null", () => {
  assert.equal(systemEventFromContent("not json"), null);
  assert.equal(systemEventFromContent("[1,2,3]"), null);
  assert.equal(systemEventFromContent('"a string"'), null);
  assert.equal(systemEventFromContent("{}"), null, "a payload with no type");
});

test("parses the relay's tombstone shape", () => {
  const payload = systemEventFromContent(
    JSON.stringify({
      type: "message_deleted",
      actor: MOD,
      target_event_id: TARGET_EVENT,
      reason_code: "spam",
      public_reason: "Off-topic promotion.",
      action_id: "act-1",
    }),
  );
  assert.equal(payload.type, "message_deleted");
  assert.equal(payload.actor, MOD);
  assert.equal(payload.target_event_id, TARGET_EVENT);
  assert.equal(payload.reason_code, "spam");
  assert.equal(payload.public_reason, "Off-topic promotion.");
});

// --- moderation tombstones -------------------------------------------------

test("a moderator removal names the moderators, not the actor", () => {
  const description = describe({
    type: "message_deleted",
    actor: MOD,
    target_event_id: TARGET_EVENT,
    reason_code: "harassment",
    public_reason: "Violated the community code of conduct.",
  });
  assert.equal(description.title, "Removed by community moderators");
  assert.equal(description.action, "Violated the community code of conduct.");
  assert.equal(description.reasonCode, "harassment");
  assert.equal(description.moderated, true);
});

test("a self-delete tombstone carries no public reason and no moderation styling", () => {
  const description = describe({
    type: "message_deleted",
    actor: ALICE,
    target_event_id: TARGET_EVENT,
  });
  assert.equal(description.title, "Alice");
  assert.equal(description.action, "removed a message");
  assert.notEqual(description.moderated, true);
});

test("the tombstone names the event to hide; other types name nothing", () => {
  assert.equal(
    tombstoneTargetId(
      systemEventFromContent(
        JSON.stringify({
          type: "message_deleted",
          actor: MOD,
          target_event_id: TARGET_EVENT,
        }),
      ),
    ),
    TARGET_EVENT,
  );
  assert.equal(
    tombstoneTargetId(
      systemEventFromContent(
        JSON.stringify({ type: "member_joined", actor: ALICE, target: ALICE }),
      ),
    ),
    null,
  );
  assert.equal(tombstoneTargetId(null), null);
});

// --- membership ------------------------------------------------------------

test("a self-join is titled by the joiner", () => {
  const description = describe({
    type: "member_joined",
    actor: ALICE,
    target: ALICE,
  });
  assert.equal(description.title, "Alice");
  assert.equal(description.action, "joined the channel");
});

test("an add is titled by the person added and names the adder", () => {
  const description = describe({
    type: "member_joined",
    actor: ALICE,
    target: BOB,
  });
  assert.equal(description.title, "Bob");
  assert.equal(description.action, "added by Alice");
});

test("pubkey case never turns a self-join into an add", () => {
  const description = describe({
    type: "member_joined",
    actor: ALICE.toUpperCase(),
    target: ALICE,
  });
  assert.equal(description.action, "joined the channel");
});

test("a leave is titled by the actor", () => {
  const description = describe({ type: "member_left", actor: BOB });
  assert.equal(description.title, "Bob");
  assert.equal(description.action, "left the channel");
});

test("a removal names both parties", () => {
  const description = describe({
    type: "member_removed",
    actor: MOD,
    target: BOB,
  });
  assert.equal(description.title, "Mod");
  assert.equal(description.action, "removed Bob from the channel");
});

// --- rows that must not render --------------------------------------------

test("out-of-scope and malformed payloads describe to null (never raw JSON)", () => {
  assert.equal(describe({ type: "topic_changed", actor: ALICE, topic: "x" }), null);
  assert.equal(describe({ type: "channel_created", actor: ALICE }), null);
  assert.equal(describe({ type: "member_joined", actor: ALICE }), null);
  assert.equal(describe({ type: "member_left" }), null);
  assert.equal(describeSystemEvent(null, resolve), null);
});
