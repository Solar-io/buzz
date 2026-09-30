import assert from "node:assert/strict";
import { test } from "node:test";
import { reactionWork } from "./queuedReactions.ts";

const AGENT = "aa".repeat(32);
const STRANGER = "cc".repeat(32);
const NOW = 50_000;

function reaction(id, emoji, target, createdAt, author = AGENT) {
  return {
    id,
    kind: 7,
    pubkey: author,
    created_at: createdAt,
    tags: [["e", target]],
    content: emoji,
  };
}

function deletion(id, reactionId, createdAt, author = AGENT) {
  return {
    id,
    kind: 5,
    pubkey: author,
    created_at: createdAt,
    tags: [["e", reactionId]],
    content: "",
  };
}

test("👀 without 💬 is queued; a kind-5 or a 💬 removes it; older than 2 h drops", () => {
  const events = [
    reaction("r1", "👀", "msg-1", NOW - 60),
    reaction("r2", "👀", "msg-2", NOW - 50),
    reaction("r3", "👀", "msg-3", NOW - 40),
    reaction("r4", "👀", "msg-4", NOW - 7_201),
  ];
  assert.equal(events.length, 4, "fixture has events");
  assert.deepEqual(
    reactionWork(events, NOW).queued.map((entry) => entry.eventId),
    ["msg-1", "msg-2", "msg-3"],
    "oldest first, the two-hour-old 👀 dropped",
  );

  const after = reactionWork(
    [
      ...events,
      // The harness deletes r1 when its turn ends…
      deletion("d1", "r1", NOW - 10),
      // …starts prompting on msg-2…
      reaction("r5", "💬", "msg-2", NOW - 5),
      // …and a stranger's kind-5 deletes nothing of the agent's.
      deletion("d2", "r3", NOW - 5, STRANGER),
    ],
    NOW,
  );
  assert.deepEqual(
    after.queued.map((entry) => entry.eventId),
    ["msg-3"],
  );
  assert.deepEqual(
    after.reacting.map((entry) => entry.eventId),
    ["msg-2"],
  );
});

test("an event an observed turn was started by is no longer queued", () => {
  const events = [
    reaction("r1", "👀", "msg-1", NOW - 60),
    reaction("r2", "👀", "msg-2", NOW - 50),
  ];
  const triggers = new Map([[AGENT, new Set(["msg-1"])]]);
  assert.deepEqual(
    reactionWork(events, NOW, triggers).queued.map((entry) => entry.eventId),
    ["msg-2"],
  );
});
