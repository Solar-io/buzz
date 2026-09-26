import assert from "node:assert/strict";
import { test } from "node:test";
import {
  selectAvailableCandidates,
  unavailableAgentPubkeys,
} from "./availableAgents.ts";
import { buildDmSuggestions } from "../../dms/lib/dmPicker.ts";
import { excludeCurrentMembers } from "../../channels/lib/addChannelMembers.ts";
import { selectableHuddleAgents } from "../../huddle/lib/huddleAgents.ts";

// FIXED values — expectations are hardcoded, never derived from the module.
const NOW = 1_790_000_000;
const HOUR = 3600;
const LIVE_PK = "11".repeat(32); // "Opus", claimed
const GONE_PK = "22".repeat(32); // "Dinesh", deleted, nobody claims it
const KEEP_PK = "33".repeat(32); // "Acid Burn" live key, OLDER, claimed
const TWIN_PK = "44".repeat(32); // "Acid Burn" newer unclaimed re-mint twin
const HUMAN_PK = "55".repeat(32); // a human DM contact (not in registry)

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

function catalog(machine, version, agents, updatedAt) {
  return { machine, version, harnesses: [], agents, updatedAt };
}

const REGISTRY = [
  entry(LIVE_PK, "Opus", 100),
  entry(GONE_PK, "Dinesh", 100),
  entry(KEEP_PK, "Acid Burn", 100),
  entry(TWIN_PK, "Acid Burn", 200),
];
const COMPLETE = catalog("crichton.local", 4, [LIVE_PK, KEEP_PK], NOW - HOUR);

const sorted = (set) => [...set].sort();

test("authoritative fresh catalog: unclaimed and twin are hidden", () => {
  assert.deepEqual(sorted(unavailableAgentPubkeys(REGISTRY, [COMPLETE], NOW)), [
    GONE_PK,
    TWIN_PK,
  ]);
});

test("zero catalogs hide nothing", () => {
  assert.equal(unavailableAgentPubkeys(REGISTRY, [], NOW).size, 0);
});

test("empty claim union hides nothing", () => {
  const empty = catalog("aeryn.local", 4, [], NOW - HOUR);
  assert.equal(unavailableAgentPubkeys(REGISTRY, [empty], NOW).size, 0);
});

test("a catalog older than 24h is ignored (desktop not running)", () => {
  const old = catalog("aeryn.local", 4, [LIVE_PK, KEEP_PK], NOW - 25 * HOUR);
  assert.equal(unavailableAgentPubkeys(REGISTRY, [old], NOW).size, 0);
  const edge = catalog("aeryn.local", 4, [LIVE_PK, KEEP_PK], NOW - 23 * HOUR);
  assert.deepEqual(sorted(unavailableAgentPubkeys(REGISTRY, [edge], NOW)), [
    GONE_PK,
    TWIN_PK,
  ]);
});

test("pre-v4 partial claims never condemn an unclaimed key", () => {
  // Live shape 2026-09-26: v3 crichton catalog claimed only pinned records.
  // Claims KEEP_PK only: the Acid Burn twin is decidable; Opus and Dinesh
  // (unclaimed, no duplicate) must stay visible.
  const partial = catalog("crichton.local", 3, [KEEP_PK], NOW - HOUR);
  assert.deepEqual(sorted(unavailableAgentPubkeys(REGISTRY, [partial], NOW)), [
    TWIN_PK,
  ]);
});

test("never picks a duplicate keeper by recency alone", () => {
  const unrelated = catalog("crichton.local", 3, [LIVE_PK], NOW - HOUR);
  const hidden = unavailableAgentPubkeys(REGISTRY, [unrelated], NOW);
  assert.equal(hidden.has(KEEP_PK), false);
  assert.equal(hidden.has(TWIN_PK), false);
});

test("selector filters contacts too, case-insensitively", () => {
  const out = selectAvailableCandidates({
    agents: REGISTRY,
    contacts: [GONE_PK.toUpperCase(), HUMAN_PK],
    catalogs: [COMPLETE],
    now: NOW,
  });
  assert.deepEqual(out.agents.map((a) => a.pubkey).sort(), [LIVE_PK, KEEP_PK]);
  assert.deepEqual(out.contacts, [HUMAN_PK]);
});

// --- The pickers, fed through the selector exactly as their dialogs do. ---

function available(contacts = []) {
  return selectAvailableCandidates({
    agents: REGISTRY,
    contacts,
    catalogs: [COMPLETE],
    now: NOW,
  });
}

test("New-DM picker offers no deleted agent, even as a DM contact", () => {
  const { agents, contacts } = available([GONE_PK, HUMAN_PK]);
  const rows = buildDmSuggestions({
    agents,
    contacts,
    profiles: new Map(),
    selfPubkey: null,
    filter: "",
  });
  assert.deepEqual(rows.map((r) => r.pubkey).sort(), [
    LIVE_PK,
    KEEP_PK,
    HUMAN_PK,
  ]);
});

test("add-to-channel picker offers no deleted agent", () => {
  const { agents, contacts } = available([GONE_PK]);
  const eligible = excludeCurrentMembers({
    agents,
    contacts,
    memberPubkeys: [LIVE_PK],
  });
  assert.deepEqual(
    eligible.agents.map((a) => a.pubkey),
    [KEEP_PK],
  );
  assert.deepEqual(eligible.contacts, []);
});

test("add-to-huddle picker offers no deleted agent", () => {
  const rows = selectableHuddleAgents(
    available().agents.map((a) => ({ pubkey: a.pubkey, name: a.name })),
    [],
  );
  assert.deepEqual(
    rows.map((r) => r.pubkey),
    [KEEP_PK, LIVE_PK],
  );
});
