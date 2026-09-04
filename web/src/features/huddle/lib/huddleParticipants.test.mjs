import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyHuddleLifecycle,
  huddleLifecycleFromEvent,
  HUDDLE_LIFECYCLE_KINDS,
  isHuddleStale,
  liveHuddlesFor,
} from "./huddleParticipants.ts";

/** A relay-signed huddle lifecycle event, in the shape handler.rs emits. */
function lifecycle({
  kind,
  pubkey = "alice",
  ephemeralId = "eph",
  parentId = "parent",
  revision,
  at = 100,
} = {}) {
  const content = { ephemeral_channel_id: ephemeralId };
  if (revision !== undefined) {
    content.roster_revision = revision;
  }
  return {
    id: `${kind}:${pubkey}:${at}`,
    pubkey: "relay",
    created_at: at,
    kind,
    tags: [
      ["h", parentId],
      ["p", pubkey],
    ],
    content: JSON.stringify(content),
    sig: "s",
  };
}

function fold(events) {
  let rooms = new Map();
  for (const event of events) {
    const parsed = huddleLifecycleFromEvent(event);
    if (parsed) {
      rooms = applyHuddleLifecycle(rooms, parsed);
    }
  }
  return rooms;
}

test("the three lifecycle kinds are 48101, 48102 and 48103", () => {
  assert.deepEqual([...HUDDLE_LIFECYCLE_KINDS], [48101, 48102, 48103]);
});

test("48101 decodes as a join naming the participant and the parent", () => {
  const parsed = huddleLifecycleFromEvent(lifecycle({ kind: 48101 }));
  assert.equal(parsed.type, "joined");
  assert.equal(parsed.pubkey, "alice");
  assert.equal(parsed.parentId, "parent");
  assert.equal(parsed.ephemeralId, "eph");
});

test("48103 is an end, not a departure", () => {
  assert.equal(
    huddleLifecycleFromEvent(lifecycle({ kind: 48103 })).type,
    "ended",
  );
  assert.equal(
    huddleLifecycleFromEvent(lifecycle({ kind: 48102 })).type,
    "left",
  );
});

test("an unrelated kind is not a lifecycle event", () => {
  assert.equal(huddleLifecycleFromEvent(lifecycle({ kind: 9 })), null);
});

test("content without an ephemeral channel id is unusable", () => {
  const event = lifecycle({ kind: 48101 });
  event.content = JSON.stringify({ roster_revision: 1 });
  assert.equal(huddleLifecycleFromEvent(event), null);
});

test("joins build the roster in admission order", () => {
  const rooms = fold([
    lifecycle({ kind: 48101, pubkey: "alice", revision: 1, at: 10 }),
    lifecycle({ kind: 48101, pubkey: "bob", revision: 2, at: 20 }),
  ]);
  assert.deepEqual(rooms.get("eph").participants, ["alice", "bob"]);
});

test("a leave removes only that participant", () => {
  const rooms = fold([
    lifecycle({ kind: 48101, pubkey: "alice", revision: 1, at: 10 }),
    lifecycle({ kind: 48101, pubkey: "bob", revision: 2, at: 20 }),
    lifecycle({ kind: 48102, pubkey: "alice", revision: 3, at: 30 }),
  ]);
  assert.deepEqual(rooms.get("eph").participants, ["bob"]);
  assert.equal(rooms.get("eph").ended, false, "one leaver is not an end");
});

test("48103 empties the room and marks it ended", () => {
  const rooms = fold([
    lifecycle({ kind: 48101, pubkey: "alice", revision: 1, at: 10 }),
    lifecycle({ kind: 48103, pubkey: "alice", at: 30 }),
  ]);
  assert.deepEqual(rooms.get("eph").participants, []);
  assert.equal(rooms.get("eph").ended, true);
});

test("a stale roster revision cannot empty a live room", () => {
  // The failure this prevents: a re-delivered "left" (revision 2) arriving
  // after a newer "joined" (revision 3) would drop a present participant.
  const rooms = fold([
    lifecycle({ kind: 48101, pubkey: "alice", revision: 1, at: 10 }),
    lifecycle({ kind: 48102, pubkey: "alice", revision: 2, at: 20 }),
    lifecycle({ kind: 48101, pubkey: "alice", revision: 3, at: 30 }),
    lifecycle({ kind: 48102, pubkey: "alice", revision: 2, at: 40 }),
  ]);
  assert.deepEqual(rooms.get("eph").participants, ["alice"]);
});

test("without revisions, an out-of-order event is rejected on timestamp", () => {
  const rooms = fold([
    lifecycle({ kind: 48101, pubkey: "alice", at: 30 }),
    lifecycle({ kind: 48102, pubkey: "alice", at: 10 }),
  ]);
  assert.deepEqual(rooms.get("eph").participants, ["alice"]);
});

test("a duplicate join changes nothing, and returns the same map", () => {
  const first = huddleLifecycleFromEvent(
    lifecycle({ kind: 48101, pubkey: "alice", revision: 1, at: 10 }),
  );
  const again = huddleLifecycleFromEvent(
    lifecycle({ kind: 48101, pubkey: "alice", revision: 2, at: 20 }),
  );
  const once = applyHuddleLifecycle(new Map(), first);
  const twice = applyHuddleLifecycle(once, again);
  assert.equal(twice, once, "the same reference — no re-render");
});

test("a join after an end re-opens the room", () => {
  const rooms = fold([
    lifecycle({ kind: 48101, pubkey: "alice", revision: 1, at: 10 }),
    lifecycle({ kind: 48103, pubkey: "alice", at: 20 }),
    lifecycle({ kind: 48101, pubkey: "bob", revision: 5, at: 30 }),
  ]);
  assert.equal(rooms.get("eph").ended, false);
  assert.deepEqual(rooms.get("eph").participants, ["bob"]);
});

test("liveHuddlesFor returns only occupied, unended rooms of that parent", () => {
  const rooms = fold([
    lifecycle({
      kind: 48101,
      pubkey: "alice",
      ephemeralId: "eph-a",
      parentId: "p1",
      revision: 1,
      at: 10,
    }),
    lifecycle({
      kind: 48101,
      pubkey: "bob",
      ephemeralId: "eph-b",
      parentId: "p2",
      revision: 1,
      at: 20,
    }),
    lifecycle({
      kind: 48101,
      pubkey: "carol",
      ephemeralId: "eph-c",
      parentId: "p1",
      revision: 1,
      at: 30,
    }),
    lifecycle({
      kind: 48102,
      pubkey: "carol",
      ephemeralId: "eph-c",
      parentId: "p1",
      revision: 2,
      at: 40,
    }),
  ]);
  assert.deepEqual(
    liveHuddlesFor(rooms, "p1").map((room) => room.ephemeralId),
    ["eph-a"],
    "eph-b is another channel's; eph-c emptied out",
  );
});

test("a huddle is stale once past the relay's one-hour backing TTL", () => {
  // Hardcoded seconds, not HUDDLE_JOINABLE_WINDOW_SECONDS ± 1: the window
  // is a protocol fact (the relay grants ttl 3600), so a change to the
  // constant should fail here rather than move the goalposts with itself.
  assert.equal(isHuddleStale(1000, 1000 + 3599), false);
  assert.equal(isHuddleStale(1000, 1000 + 3601), true);
});
