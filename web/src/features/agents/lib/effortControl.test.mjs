import assert from "node:assert/strict";
import { test } from "node:test";
import {
  THINKING_EFFORT_ENV_KEY,
  THINKING_EFFORT_VALUES,
  effortPatchFromSelection,
} from "./effortControl.ts";

test("the effort value list is pinned byte-for-byte against the harness enum", () => {
  // Mirror of desktop modelCapabilities.ts / crates/buzz-agent config.rs
  // parse_thinking_effort — order and spelling both matter (a bad value is
  // inert env on the other side, so it must never ship from here).
  assert.deepEqual(THINKING_EFFORT_VALUES, [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(THINKING_EFFORT_ENV_KEY, "BUZZ_AGENT_THINKING_EFFORT");
});

test("effortPatchFromSelection maps each selection onto its exact patch", () => {
  assert.deepEqual(effortPatchFromSelection("keep"), undefined);
  assert.deepEqual(effortPatchFromSelection("high"), {
    BUZZ_AGENT_THINKING_EFFORT: "high",
  });
  assert.deepEqual(effortPatchFromSelection("none"), {
    BUZZ_AGENT_THINKING_EFFORT: "none",
  });
  // "clear" deletes the agent-level key (null), not empty-string.
  assert.deepEqual(effortPatchFromSelection("clear"), {
    BUZZ_AGENT_THINKING_EFFORT: null,
  });
});
