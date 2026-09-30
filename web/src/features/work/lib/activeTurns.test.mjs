import assert from "node:assert/strict";
import { test } from "node:test";
import { activeTurns, observedTriggers } from "./activeTurns.ts";

/**
 * The stalled rule (phase-1 §2.4). Budgets are HARDCODED here (25 s stalled,
 * 600 s lost) — never read from the module — so raising a constant fails a
 * test instead of moving its own expectation.
 */

const AGENT = "aa".repeat(32);
const OTHER = "bb".repeat(32);
const CHANNEL = "chan-1";

function frame(kind, createdAt, extra = {}) {
  return {
    id: `env-${kind}-${createdAt}`,
    createdAt,
    seq: createdAt,
    timestamp: new Date(createdAt * 1000).toISOString(),
    kind,
    agentIndex: 0,
    channelId: CHANNEL,
    sessionId: "s1",
    turnId: "t1",
    startedAt: null,
    payload: null,
    ...extra,
  };
}

test("a turn with only turn_liveness pings every 10 s is live at t+120 s", () => {
  // turn_started at 1000, then NOTHING but liveness every 10 s.
  const frames = [frame("turn_started", 1000)];
  for (let t = 1010; t <= 1120; t += 10) {
    frames.push(frame("turn_liveness", t));
  }
  assert.ok(frames.length > 0, "fixture has frames");
  assert.equal(frames.filter((f) => f.kind === "turn_liveness").length, 12);
  const rows = activeTurns(new Map([[AGENT, frames]]), 1120);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "live", "liveness pings are heartbeats");
  assert.equal(rows[0].lastBeatAt, 1120);
  assert.equal(rows[0].startedAt, 1000);
});

test("a turn silent for 26 s is stalled and still listed", () => {
  const frames = [frame("turn_started", 1000), frame("acp_read", 1004)];
  assert.ok(frames.length > 0, "fixture has frames");
  // 25 s of silence is still inside the budget…
  assert.equal(activeTurns(new Map([[AGENT, frames]]), 1029)[0].state, "live");
  // …26 s is past it: stalled, and STILL a row.
  const rows = activeTurns(new Map([[AGENT, frames]]), 1030);
  assert.equal(rows.length, 1, "a stalled turn is never hidden");
  assert.equal(rows[0].state, "stalled");
  // Ten minutes and one second silent: lost, still listed.
  const lost = activeTurns(new Map([[AGENT, frames]]), 1004 + 601);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].state, "lost");
  // A local dismiss (tombstone by turnId) is the only way it leaves.
  assert.deepEqual(
    activeTurns(new Map([[AGENT, frames]]), 1030, new Set(["t1"])),
    [],
  );
});

test("turn_completed/turn_error end one turn; agent_panic ends all of that agent's turns", () => {
  const frames = [
    frame("turn_started", 1000, { turnId: "t1" }),
    frame("turn_started", 1001, { turnId: "t2", channelId: "chan-2" }),
    frame("turn_started", 1002, { turnId: "t3", channelId: "chan-3" }),
    frame("turn_completed", 1010, { turnId: "t1" }),
    frame("turn_error", 1011, { turnId: "t2", channelId: "chan-2" }),
  ];
  assert.ok(frames.length > 0, "fixture has frames");
  const rows = activeTurns(new Map([[AGENT, frames]]), 1012);
  assert.deepEqual(
    rows.map((row) => row.turnId),
    ["t3"],
    "only the unterminated turn remains",
  );

  // A panic carries no turnId and ends every turn of THAT agent…
  const panicked = [
    frame("turn_started", 1000, { turnId: "t1" }),
    frame("turn_started", 1001, { turnId: "t2", channelId: "chan-2" }),
    frame("agent_panic", 1005, { turnId: null, channelId: null }),
  ];
  // …and leaves another agent's turn alone.
  const other = [frame("turn_started", 1003, { turnId: "o1" })];
  const after = activeTurns(
    new Map([
      [AGENT, panicked],
      [OTHER, other],
    ]),
    1006,
  );
  assert.deepEqual(
    after.map((row) => [row.agentPubkey, row.turnId]),
    [[OTHER, "o1"]],
  );
});

test("startedAt comes from frame.startedAt when turn_started is outside the window", () => {
  // Reload mid-turn: turn_started is gone, the harness stamp survives.
  const stamp = new Date(900 * 1000).toISOString();
  const frames = [
    frame("turn_liveness", 1000, { startedAt: stamp }),
    frame("acp_read", 1003, { startedAt: stamp }),
  ];
  assert.ok(frames.length > 0, "fixture has frames");
  const rows = activeTurns(new Map([[AGENT, frames]]), 1004);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].startedAt, 900, "the harness stamp, not first sight");
  // Without a stamp it falls back to the earliest frame seen.
  const bare = activeTurns(
    new Map([[AGENT, [frame("turn_liveness", 1000), frame("acp_read", 1003)]]]),
    1004,
  );
  assert.equal(bare[0].startedAt, 1000);
});

test("a newer turn in the same channel ends the older one there", () => {
  // The old turn's terminal frame never reached the buffer (evicted, or
  // outside the live lookback). One turn per channel per agent: the newer
  // turn in chan-1 means the older one is over — it must not read "stalled".
  const frames = [
    frame("turn_started", 1000, { turnId: "old" }),
    frame("turn_started", 1500, { turnId: "new" }),
    frame("turn_liveness", 1510, { turnId: "new" }),
    // Another channel's old turn is NOT superseded by chan-1's.
    frame("turn_started", 1005, { turnId: "elsewhere", channelId: "chan-2" }),
  ];
  assert.ok(frames.length > 0, "fixture has frames");
  const rows = activeTurns(new Map([[AGENT, frames]]), 1512);
  assert.deepEqual(
    rows.map((row) => [row.turnId, row.state]),
    [
      ["new", "live"],
      ["elsewhere", "stalled"],
    ],
  );
});

test("live rows sort before stalled ones and triggers are collected", () => {
  const frames = [
    frame("turn_started", 1000, {
      turnId: "old",
      payload: { triggeringEventIds: ["e1", "e2"] },
    }),
    frame("turn_started", 1090, { turnId: "new", channelId: "chan-2" }),
    frame("turn_liveness", 1095, { turnId: "new", channelId: "chan-2" }),
  ];
  const rows = activeTurns(new Map([[AGENT, frames]]), 1100);
  assert.deepEqual(
    rows.map((row) => [row.turnId, row.state]),
    [
      ["new", "live"],
      ["old", "stalled"],
    ],
  );
  assert.deepEqual(rows[1].triggeringEventIds, ["e1", "e2"]);
  assert.deepEqual(
    [...(observedTriggers(new Map([[AGENT, frames]])).get(AGENT) ?? [])],
    ["e1", "e2"],
  );
});
