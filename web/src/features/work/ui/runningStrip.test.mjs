import assert from "node:assert/strict";
import test from "node:test";

import { runningNames, runningSummary, typingOthers } from "./RunningStrip.tsx";

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

test("typing names only who the running rows do not already name", () => {
  const nikon = "a1".repeat(32);
  const carol = "c3".repeat(32);
  const ghost = "e5".repeat(32);
  // An agent at work types for its whole turn: said once, as working.
  assert.deepEqual(typingOthers([nikon, carol], [row(nikon, "live")]), [carol]);
  // A quiet turn names its agent too — the strip already says it.
  assert.deepEqual(typingOthers([nikon], [row(nikon, "stalled")]), []);
  // Case never splits one key in two.
  assert.deepEqual(
    typingOthers([nikon.toUpperCase()], [row(nikon, "reacting")]),
    [],
  );
  // An agent typing with no lifecycle row is still said; so is a person.
  assert.deepEqual(typingOthers([ghost, carol], []), [ghost, carol]);
  assert.deepEqual(typingOthers([], [row(nikon, "live")]), []);
});

test("names list two, then count the rest", () => {
  assert.deepEqual(runningNames(["A"]), ["A"]);
  assert.deepEqual(runningNames(["A", "B"]), ["A", "B"]);
  assert.deepEqual(runningNames(["A", "B", "C", "D"]), ["A", "B", "2 more"]);
});
