import assert from "node:assert/strict";
import test from "node:test";

import { runningNames, runningSummary } from "./RunningStrip.tsx";

function row(agent, state) {
  return {
    key: `${agent}:${state}`,
    agentPubkey: agent,
    turnId: "t",
    channelId: "c",
    startedAt: 100,
    lastBeatAt: 110,
    state,
    source: state === "reacting" ? "reaction" : "observer",
  };
}

test("working turns are named; a silent turn is named only when nothing works", () => {
  const live = row("nikon", "live");
  const reacting = row("acid", "reacting");
  const stalled = row("crash", "stalled");

  assert.deepEqual(runningSummary([live]), {
    rows: [live],
    verb: "is working",
    quiet: false,
  });
  // A stalled turn beside a working one: the strip names the worker.
  assert.deepEqual(runningSummary([stalled, live, reacting]), {
    rows: [live, reacting],
    verb: "are working",
    quiet: false,
  });
  // Nothing working: the silent turn is said out loud, never hidden.
  assert.deepEqual(runningSummary([stalled]), {
    rows: [stalled],
    verb: "has gone quiet",
    quiet: true,
  });
  assert.equal(
    runningSummary([stalled, row("jared", "lost")]).verb,
    "have gone quiet",
  );
  // Nothing at all: no strip.
  assert.equal(runningSummary([]), null);
});

test("names list two, then count the rest", () => {
  assert.deepEqual(runningNames(["A"]), ["A"]);
  assert.deepEqual(runningNames(["A", "B"]), ["A", "B"]);
  assert.deepEqual(runningNames(["A", "B", "C", "D"]), ["A", "B", "2 more"]);
});
