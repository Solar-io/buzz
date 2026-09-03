import assert from "node:assert/strict";
import { test } from "node:test";
import { duplicatePubkeys, findStaleAgents } from "./staleAgents.ts";

// FIXED pubkeys — expectations are hardcoded against these, never derived
// from the module under test.
const NEW_PK = "11".repeat(32); // newest "Night Shift"
const OLD_PK = "22".repeat(32); // older duplicate "night shift "
const TIE_LOW_PK = "33".repeat(32); // same updatedAt as TIE_HIGH
const TIE_HIGH_PK = "44".repeat(32); // same updatedAt, higher pubkey → keeper
const SOLO_PK = "55".repeat(32); // unique name, claimed
const GONE_PK = "66".repeat(32); // unique name, unclaimed
// 9/2 rekey incident shape: the LIVE key is an older registration a desktop
// catalog still claims; a newer unclaimed re-mint twin shares its name.
const LIVE_OLD_PK = "77".repeat(32); // OLDER updatedAt, catalog-claimed (live seat)
const LIVE_TWIN_PK = "88".repeat(32); // NEWER updatedAt, unclaimed re-mint twin

function entry(pubkey, name, updatedAt) {
  return {
    pubkey,
    name,
    systemPrompt: "",
    model: "",
    provider: "",
    personaId: null,
    parallelism: null,
    respondTo: "owner-only",
    respondToAllowlist: [],
    updatedAt,
  };
}

function catalog(machine, agents) {
  return { machine, harnesses: [], agents, updatedAt: 1 };
}

const REGISTRY = [
  entry(NEW_PK, "Night Shift", 2000),
  entry(OLD_PK, "night shift ", 1000),
  entry(TIE_LOW_PK, "Tie Agent", 1500),
  entry(TIE_HIGH_PK, "TIE AGENT", 1500),
  entry(SOLO_PK, "Solo", 900),
  entry(GONE_PK, "Retired Desktop Agent", 800),
];

test("duplicate-name groups keep the newest; ties keep the highest pubkey", () => {
  const stale = findStaleAgents(REGISTRY, []);
  const reasons = new Map(stale.map((row) => [row.pubkey, row.reason]));
  // "night shift " is an older duplicate of the newest "Night Shift".
  assert.equal(reasons.get(OLD_PK), "older duplicate of Night Shift");
  assert.equal(reasons.get(NEW_PK), undefined);
  // Equal updatedAt → highest pubkey (44…4) wins; 33…3 is the duplicate.
  assert.equal(reasons.get(TIE_LOW_PK), "older duplicate of TIE AGENT");
  assert.equal(reasons.get(TIE_HIGH_PK), undefined);
  // Unique names are never duplicates.
  assert.equal(reasons.get(SOLO_PK), undefined);
  assert.equal(reasons.get(GONE_PK), undefined);
});

test("input order does not change the keepers", () => {
  const forward = findStaleAgents(REGISTRY, []);
  const reversed = findStaleAgents([...REGISTRY].reverse(), []);
  assert.deepEqual(
    forward.map((row) => row.pubkey).sort(),
    reversed.map((row) => row.pubkey).sort(),
  );
  assert.equal(
    reversed.find((row) => row.pubkey === TIE_LOW_PK).reason,
    "older duplicate of TIE AGENT",
  );
});

test("no catalogs → no unclaimed flags at all", () => {
  const stale = findStaleAgents(REGISTRY, []);
  assert.equal(
    stale.some((row) => row.reason === "not reported by any desktop"),
    false,
  );
});

test("a catalog claiming nothing flags nothing (empty agents list)", () => {
  // One machine claiming zero agents must not nuke the registry.
  const stale = findStaleAgents(REGISTRY, [catalog("crichton.local", [])]);
  assert.equal(
    stale.some((row) => row.reason === "not reported by any desktop"),
    false,
  );
  // Duplicates are still detected — they never depend on catalogs.
  assert.equal(stale.length, 2);
});

test("unclaimed flags appear once a catalog claims at least one agent", () => {
  const stale = findStaleAgents(REGISTRY, [
    catalog("crichton.local", [NEW_PK, TIE_HIGH_PK, SOLO_PK]),
  ]);
  const reasons = new Map(stale.map((row) => [row.pubkey, row.reason]));
  assert.equal(reasons.get(GONE_PK), "not reported by any desktop");
  assert.equal(reasons.get(SOLO_PK), undefined);
  // Entries that are BOTH an older duplicate and unclaimed get the duplicate
  // reason (one row per pubkey, most specific reason wins).
  assert.equal(reasons.get(OLD_PK), "older duplicate of Night Shift");
  assert.equal(reasons.get(TIE_LOW_PK), "older duplicate of TIE AGENT");
});

test("claims union across machines", () => {
  const stale = findStaleAgents(REGISTRY, [
    catalog("crichton.local", [NEW_PK]),
    catalog("aeryn.local", [GONE_PK]),
  ]);
  const reasons = new Map(stale.map((row) => [row.pubkey, row.reason]));
  assert.equal(reasons.get(GONE_PK), undefined);
  assert.equal(reasons.get(SOLO_PK), "not reported by any desktop");
});

test("duplicatePubkeys badges only the non-keepers", () => {
  const dupes = duplicatePubkeys(REGISTRY, []);
  assert.equal(dupes.has(OLD_PK), true);
  assert.equal(dupes.has(TIE_LOW_PK), true);
  assert.equal(dupes.has(NEW_PK), false);
  assert.equal(dupes.has(TIE_HIGH_PK), false);
  assert.equal(dupes.has(SOLO_PK), false);
  assert.equal(dupes.has(GONE_PK), false);
});

// The 9/2 incident, as a test: liveness outranks recency. A catalog-claimed
// member of a duplicate group is the keeper EVEN WHEN a twin carries a newer
// updatedAt — the old keeper rule (newest-updatedAt-wins) flagged exactly
// these live keys as "older duplicates" and the cleanup deleted them.
test("catalog-claimed member wins keeper despite older updatedAt", () => {
  const reg = [
    entry(LIVE_TWIN_PK, "Night Shift", 3000), // newer, no desktop claims it
    entry(LIVE_OLD_PK, "night shift", 1000), // older, crichton still runs it
  ];
  const stale = findStaleAgents(reg, [
    catalog("crichton.local", [LIVE_OLD_PK]),
  ]);
  const reasons = new Map(stale.map((row) => [row.pubkey, row.reason]));
  assert.equal(reasons.get(LIVE_OLD_PK), undefined);
  assert.equal(
    reasons.get(LIVE_TWIN_PK),
    "newer unclaimed duplicate of night shift",
  );
});

test("duplicatePubkeys badges the unclaimed twin, not the claimed live key", () => {
  const reg = [
    entry(LIVE_TWIN_PK, "Night Shift", 3000),
    entry(LIVE_OLD_PK, "night shift", 1000),
  ];
  const dupes = duplicatePubkeys(reg, [
    catalog("crichton.local", [LIVE_OLD_PK]),
  ]);
  assert.equal(dupes.has(LIVE_OLD_PK), false);
  assert.equal(dupes.has(LIVE_TWIN_PK), true);
});

test("two claimed members: newest updatedAt among the claimed wins", () => {
  const reg = [
    entry(LIVE_TWIN_PK, "Night Shift", 3000), // claimed AND newer
    entry(LIVE_OLD_PK, "night shift", 1000), // claimed, older
  ];
  const stale = findStaleAgents(reg, [
    catalog("crichton.local", [LIVE_OLD_PK, LIVE_TWIN_PK]),
  ]);
  const reasons = new Map(stale.map((row) => [row.pubkey, row.reason]));
  // Both live — flagged only by the duplicate rule, older one out.
  assert.equal(reasons.get(LIVE_TWIN_PK), undefined);
  assert.equal(reasons.get(LIVE_OLD_PK), "older duplicate of Night Shift");
});
