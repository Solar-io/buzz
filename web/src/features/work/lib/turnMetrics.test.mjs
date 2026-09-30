import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTurnMetric, summarizeDone } from "./turnMetrics.ts";

const AGENT = "aa".repeat(32);
const MIDNIGHT = 10_000;

function done(eventId, turnId, createdAt, channelId = "chan-1") {
  return {
    locked: false,
    eventId,
    agentPubkey: AGENT,
    createdAt,
    channelId,
    turnId,
    at: createdAt,
    stopReason: "end_turn",
  };
}

test("counts distinct turnIds since local midnight; undecryptable is locked, not done", () => {
  const entries = [
    done("e1", "turn-a", MIDNIGHT + 10),
    // The same turn reported twice (a replay) is ONE turn.
    done("e2", "turn-a", MIDNIGHT + 11),
    done("e3", "turn-b", MIDNIGHT + 20),
    // No turnId: the event id stands in.
    done("e4", null, MIDNIGHT + 30),
    // Yesterday does not count.
    done("e5", "turn-old", MIDNIGHT - 1),
    { locked: true, eventId: "x1", createdAt: MIDNIGHT + 40 },
    { locked: true, eventId: "x2", createdAt: MIDNIGHT + 41 },
  ];
  assert.equal(entries.length, 7, "fixture has entries");
  const summary = summarizeDone(entries, MIDNIGHT);
  assert.equal(summary.count, 3, "turn-a, turn-b, e4");
  assert.equal(summary.locked, 2);
  assert.equal(summary.last?.at, MIDNIGHT + 30);
  // Channel scope keeps the open channel's turns only.
  const scoped = summarizeDone(
    [...entries, done("e6", "turn-c", MIDNIGHT + 50, "chan-2")],
    MIDNIGHT,
    "channel",
    "chan-2",
  );
  assert.equal(scoped.count, 1);
  assert.equal(scoped.last?.channelId, "chan-2");
});

test("parseTurnMetric reads NIP-AM and rejects what is not one", () => {
  assert.deepEqual(
    parseTurnMetric(
      JSON.stringify({
        harness: "goose",
        channelId: "c",
        turnId: "t",
        timestamp: "1970-01-01T00:16:40.000Z",
        stopReason: "end_turn",
      }),
    ),
    { channelId: "c", turnId: "t", at: 1000, stopReason: "end_turn" },
  );
  assert.equal(parseTurnMetric(JSON.stringify({ turnId: "t" })), null);
  assert.equal(parseTurnMetric("not json"), null);
});
