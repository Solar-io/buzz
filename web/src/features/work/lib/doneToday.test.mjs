import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeDone, statusEnding } from "./doneToday.ts";
import { summarizeDone } from "./turnMetrics.ts";

const OWNED = "aa".repeat(32);
const OTHER = "bb".repeat(32);
const MIDNIGHT = 50_000;

function metric(turnId, at, channelId = "chan-1", stopReason = "end_turn") {
  return {
    locked: false,
    eventId: `m-${turnId}`,
    agentPubkey: OWNED,
    createdAt: at,
    channelId,
    turnId,
    at,
    stopReason,
  };
}

function ended(overrides) {
  return {
    agentPubkey: OWNED,
    channelId: "chan-1",
    turnId: "t",
    state: "done",
    started: MIDNIGHT,
    ended: MIDNIGHT + 10,
    beatAt: MIDNIGHT + 10,
    trigger: null,
    reason: null,
    title: null,
    progress: null,
    ...overrides,
  };
}

test("a turn both sources report is ONE row, titled from 30624", () => {
  const metrics = summarizeDone(
    [metric("t1", MIDNIGHT + 30), metric("t2", MIDNIGHT + 40)],
    MIDNIGHT,
  );
  const done = mergeDone(
    metrics,
    [
      ended({ turnId: "t1", ended: MIDNIGHT + 30, title: "Beat 01 captured" }),
      // Another member's agent: only 30624 can see it.
      ended({
        agentPubkey: OTHER,
        turnId: "o1",
        ended: MIDNIGHT + 50,
        title: "Merge-queue sweep",
      }),
    ],
    MIDNIGHT,
  );
  assert.equal(done.count, 3);
  assert.deepEqual(
    done.rows.map((row) => [row.key, row.title]),
    [
      [`${OTHER}:o1`, "Merge-queue sweep"],
      [`${OWNED}:t2`, null],
      [`${OWNED}:t1`, "Beat 01 captured"],
    ],
  );
  assert.equal(done.last.title, "Merge-queue sweep");
});

test("an abnormal ending is said; an ordinary one is not", () => {
  assert.equal(statusEnding({ state: "done", reason: null }), null);
  assert.equal(statusEnding({ state: "cancelled", reason: null }), "cancelled");
  assert.equal(
    statusEnding({ state: "error", reason: "harness-restart" }),
    "error · harness-restart",
  );
  const done = mergeDone(
    summarizeDone([metric("t1", MIDNIGHT + 5)], MIDNIGHT),
    [ended({ turnId: "t1", state: "error", reason: "harness-restart" })],
    MIDNIGHT,
  );
  // The metric said end_turn; the harness said the turn errored — the
  // abnormal word wins, because it is the one worth a second look.
  assert.equal(done.rows[0].stopReason, "error · harness-restart");
});

test("Done today starts at the floor and honours the channel scope", () => {
  const turns = [
    ended({ turnId: "yesterday", ended: MIDNIGHT - 1 }),
    ended({ turnId: "here", channelId: "chan-1", ended: MIDNIGHT + 1 }),
    ended({ turnId: "there", channelId: "chan-2", ended: MIDNIGHT + 2 }),
  ];
  assert.deepEqual(
    mergeDone(null, turns, MIDNIGHT).rows.map((row) => row.key),
    [`${OWNED}:there`, `${OWNED}:here`],
  );
  assert.deepEqual(
    mergeDone(null, turns, MIDNIGHT, "channel", "chan-1").rows.map(
      (row) => row.key,
    ),
    [`${OWNED}:here`],
  );
  assert.equal(mergeDone(null, [], MIDNIGHT).count, 0);
});
