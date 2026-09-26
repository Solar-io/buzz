import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findCleanupCandidates,
  unavailableAgentPubkeys,
} from "./availableAgents.ts";
import {
  LIVE_MANAGED_PUBKEYS_2026_09_26,
  LIVE_REGISTRY_2026_09_26,
} from "./liveAgentSnapshot.fixture.mjs";

// Replays the real 2026-09-26 data: the v4 desktop claims every keyed managed
// record; the v3 desktop claimed only the three records with a relay pin.
const NOW = 1_790_460_000;
const REGISTRY = LIVE_REGISTRY_2026_09_26.map((e) => ({
  ...e,
  systemPrompt: "",
  model: "",
  provider: "",
  personaId: null,
  parallelism: null,
  respondTo: "owner-only",
  respondToAllowlist: [],
}));
const V4 = {
  machine: "crichton.local",
  version: 4,
  harnesses: [],
  agents: LIVE_MANAGED_PUBKEYS_2026_09_26,
  updatedAt: NOW - 600,
};
const V3 = {
  ...V4,
  version: 3,
  agents: [
    "2bdc3e824cfcc4be26bd0cdfe8883c57770f4e2a6800337b96b9d8ccabdaeaa9",
    "7dc9ab6079847c3479f39fc93eeec2a0791191c63789b23476ee7df9e4660d2d",
    "939df87fc3ef4645f5020eba3a60ebd8d3fdfff49627af0546af01b913d623e3",
  ],
};

// Hardcoded from the investigation — NOT derived from the selector.
const EXPECTED_DEAD = [
  "12196b33c885 Gilfoyle",
  "42838eb80b17 Pollen",
  "63b861c2c6ec Acid Burn",
  "6862ab417fa4 Acid Burn",
  "6e7f6cbafb1f Lord Nikon",
  "8a4a13d03aef Test-agent",
  "01604c3f1880 Evie",
  "93c761aefb33 Gilfoyle",
  "993228822082 Lord Nikon",
  "9af726d02158 Evie",
  "bb6df4469338 Dinesh",
  "c325e7b27882 Fizz",
  "cabdf9b78db0 Cereal Killer",
  "d04a5f8ad9b5 Cereal Killer",
  "d9534c51e8da Dinesh",
  "d96e11ee85f0 Aeryn Local",
  "e563934f247a Honey",
].sort();

function label(pubkeys) {
  const names = new Map(REGISTRY.map((e) => [e.pubkey, e.name]));
  return [...pubkeys].map((pk) => `${pk.slice(0, 12)} ${names.get(pk)}`).sort();
}

test("fixture is the full snapshot (33 registry, 18 managed)", () => {
  assert.equal(REGISTRY.length, 33);
  assert.equal(LIVE_MANAGED_PUBKEYS_2026_09_26.length, 18);
});

test("v4 catalog hides exactly the 17 dead registry entries", () => {
  assert.deepEqual(
    label(unavailableAgentPubkeys(REGISTRY, [V4], NOW)),
    EXPECTED_DEAD,
  );
});

test("v4 catalog hides no managed (live) agent", () => {
  const hidden = unavailableAgentPubkeys(REGISTRY, [V4], NOW);
  for (const pk of LIVE_MANAGED_PUBKEYS_2026_09_26) {
    assert.equal(hidden.has(pk), false, `live ${pk} hidden`);
  }
  assert.equal(REGISTRY.length - hidden.size, 16);
});

test("admin cleanup offers exactly the dead entries under v4", () => {
  const offered = findCleanupCandidates(REGISTRY, [V4], NOW).map(
    (s) => s.pubkey,
  );
  assert.deepEqual(label(offered), EXPECTED_DEAD);
});

test("admin cleanup offers nothing from the real v3 catalog", () => {
  assert.deepEqual(findCleanupCandidates(REGISTRY, [V3], NOW), []);
});

test("admin cleanup offers nothing once the v4 catalog is >24h old", () => {
  const stale = { ...V4, updatedAt: NOW - 25 * 3600 };
  assert.deepEqual(findCleanupCandidates(REGISTRY, [stale], NOW), []);
});

test("a fresh pre-v4 desktop alongside v4 disables cleanup", () => {
  const aeryn = { ...V3, machine: "aeryn.local", agents: [] };
  assert.deepEqual(findCleanupCandidates(REGISTRY, [V4, aeryn], NOW), []);
});

test("real v3 catalog: pickers hide only the claim-decided twins", () => {
  assert.deepEqual(label(unavailableAgentPubkeys(REGISTRY, [V3], NOW)), [
    "42838eb80b17 Pollen",
    "c325e7b27882 Fizz",
    "e563934f247a Honey",
  ]);
});
