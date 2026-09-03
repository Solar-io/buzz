import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTROLS_CATALOG_VERSION,
  controlsEnabled,
  createControlsEnabled,
} from "./adminCommandCapabilities.ts";

const AGENT_A = "aa".repeat(32);

function catalog(machine, version) {
  return {
    machine,
    version,
    harnesses: [],
    agents: [AGENT_A],
    updatedAt: 1000,
  };
}

test("controlsEnabled truth table: all claiming machines must be v2", () => {
  const v1 = [catalog("crichton.local", 1)];
  const v2 = [catalog("crichton.local", 2)];
  const v3 = [catalog("crichton.local", 3)];
  // Zero claiming machines → hidden.
  assert.equal(controlsEnabled(v2, []), false);
  // One v1 machine → hidden.
  assert.equal(controlsEnabled(v1, ["crichton.local"]), false);
  // One v2 machine → shown.
  assert.equal(controlsEnabled(v2, ["crichton.local"]), true);
  // A future v3 counts as >= 2.
  assert.equal(controlsEnabled(v3, ["crichton.local"]), true);
  // Mixed fleet {A(v2), B(v1)} → hidden (all-v2, NOT exactly-one-v2: an
  // update broadcast would apply on A while silently no-oping on B).
  assert.equal(
    controlsEnabled(
      [catalog("a.local", 2), catalog("b.local", 1)],
      ["a.local", "b.local"],
    ),
    false,
  );
  // All-v2 two-machine fleet → shown.
  assert.equal(
    controlsEnabled(
      [catalog("a.local", 2), catalog("b.local", 2)],
      ["a.local", "b.local"],
    ),
    true,
  );
  // A claiming machine with NO parsed catalog counts as not-v2.
  assert.equal(
    controlsEnabled([catalog("a.local", 2)], ["a.local", "b.local"]),
    false,
  );
  // Machines with no claim on the agent are irrelevant.
  assert.equal(controlsEnabled([catalog("a.local", 2)], ["b.local"]), false);
  assert.equal(
    controlsEnabled(
      [catalog("a.local", 1), catalog("b.local", 2)],
      ["b.local"],
    ),
    true,
  );
});

test("createControlsEnabled: the effective target machine must be v2", () => {
  const catalogs = [catalog("crichton.local", 2), catalog("aeryn.local", 1)];
  assert.equal(createControlsEnabled(catalogs, "crichton.local"), true);
  assert.equal(createControlsEnabled(catalogs, "aeryn.local"), false);
  // No target at all (zero catalogs) → hidden.
  assert.equal(createControlsEnabled(catalogs, null), false);
  // A target with no parsed catalog → hidden.
  assert.equal(createControlsEnabled(catalogs, "ghost.local"), false);
});

test("CONTROLS_CATALOG_VERSION is pinned at 2", () => {
  assert.equal(CONTROLS_CATALOG_VERSION, 2);
});
