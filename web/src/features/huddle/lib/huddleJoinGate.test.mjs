import assert from "node:assert/strict";
import { test } from "node:test";
import {
  huddleJoinGate,
  HUDDLE_ENDED_REASON,
  HUDDLE_RESOLVING_HINT,
  HUDDLE_UNLINKED_REASON,
} from "./huddleJoinGate.ts";

/*
 * VOICE_E2E_2026-09-17 V1b: the reload path locked live callers out with a
 * false reason ("needs a permanent channel") and offered a live Join on
 * rooms the relay had already ended. Each decision below is load-bearing;
 * inverting it reproduces a defect, and the matching test fails.
 */

test("a resolved parent joins", () => {
  const gate = huddleJoinGate({
    parentChannelId: "parent-1",
    huddleEnded: false,
    resolutionSettled: true,
  });
  assert.equal(gate.state, "joinable");
  assert.equal(gate.joinable, true);
  assert.equal(gate.reason, null);
});

test("an ended huddle never renders a live Join, even with a link in hand", () => {
  // Inverting this (ignoring huddleEnded because a parent exists) puts the
  // enabled Join back on a room the relay has archived.
  const gate = huddleJoinGate({
    parentChannelId: "parent-1",
    huddleEnded: true,
    resolutionSettled: true,
  });
  assert.equal(gate.state, "ended");
  assert.equal(gate.joinable, false);
  assert.equal(gate.reason, HUDDLE_ENDED_REASON);
});

test("resolution still in flight disables WITHOUT a failure reason", () => {
  // The defect reason — "Huddles need a permanent (non-TTL) channel" — was
  // shown while the replay had simply not landed yet. While the linkage
  // query is unsettled there is no verdict to show, and any reason string
  // here would be the false lockout again.
  const gate = huddleJoinGate({
    parentChannelId: null,
    huddleEnded: false,
    resolutionSettled: false,
  });
  assert.equal(gate.state, "resolving");
  assert.equal(gate.joinable, false);
  assert.equal(gate.reason, null);
  assert.equal(gate.hint, HUDDLE_RESOLVING_HINT);
});

test("settled resolution with no parent anywhere is the one disabled-with-reason case", () => {
  const gate = huddleJoinGate({
    parentChannelId: null,
    huddleEnded: false,
    resolutionSettled: true,
  });
  assert.equal(gate.state, "unlinked");
  assert.equal(gate.joinable, false);
  assert.equal(gate.reason, HUDDLE_UNLINKED_REASON);
});

test("ended outranks a resolved parent (archived refuses the join relay-side)", () => {
  const gate = huddleJoinGate({
    parentChannelId: "parent-1",
    huddleEnded: true,
    resolutionSettled: false,
  });
  assert.equal(gate.state, "ended");
  assert.equal(gate.joinable, false);
});

test("the unlinked reason is not the old ambient-context lie", () => {
  // Hardcoded: the reason must be about the missing LINK (an actual
  // resolution verdict), not about the channel kind — the old string was
  // shown for linked huddles on cold load.
  assert.equal(HUDDLE_UNLINKED_REASON.includes("permanent"), false);
  assert.ok(HUDDLE_UNLINKED_REASON.includes("parent channel link"));
});
