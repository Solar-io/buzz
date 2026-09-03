import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRoster, targetForAgent } from "./roster.ts";

const PK_A = "aa".repeat(32);
const PK_B = "bb".repeat(32);

function entry(overrides = {}) {
  return {
    pubkey: PK_A,
    name: "Night Shift",
    systemPrompt: "You work nights.",
    model: "",
    provider: "",
    personaId: null,
    parallelism: null,
    respondTo: "owner-only",
    respondToAllowlist: [],
    updatedAt: 1000,
    ...overrides,
  };
}

function persona(overrides = {}) {
  return {
    id: "persona-1",
    name: "Night Shift (definition)",
    systemPrompt: "From the definition.",
    model: "glm-5.3",
    provider: "zai",
    runtime: "claude-code-glm",
    updatedAt: 900,
    ...overrides,
  };
}

function catalog(machine, agents, overrides = {}) {
  return { machine, harnesses: [], agents, updatedAt: 5000, ...overrides };
}

test("unlinked entries read the quad straight from the 30177", () => {
  const rows = buildRoster(
    [entry({ model: "glm-5.3", provider: "zai" })],
    new Map(),
    [],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "glm-5.3");
  assert.equal(rows[0].provider, "zai");
  assert.equal(rows[0].personaLinked, false);
  assert.equal(rows[0].persona, null);
});

test("linked entries resolve the quad from the persona (30175)", () => {
  const rows = buildRoster(
    [
      entry({
        personaId: "persona-1",
        name: "slimmed",
        systemPrompt: "",
      }),
    ],
    new Map([["persona-1", persona()]]),
    [],
  );
  assert.equal(rows[0].personaLinked, true);
  assert.equal(rows[0].name, "Night Shift (definition)");
  assert.equal(rows[0].systemPrompt, "From the definition.");
  assert.equal(rows[0].model, "glm-5.3");
  assert.equal(rows[0].provider, "zai");
});

test("linked entry with a missing persona: name falls back, quad reads unknown", () => {
  // The quad is definition-owned; with the 30175 unreadable the honest value
  // is unknown (""), matching prefillEditForm's established semantics —
  // never the 30177's stale copy.
  const rows = buildRoster(
    [entry({ personaId: "gone", name: "Fallback", model: "glm-5.3" })],
    new Map(),
    [],
  );
  assert.equal(rows[0].personaLinked, true);
  assert.equal(rows[0].name, "Fallback");
  assert.equal(rows[0].model, "");
  assert.equal(rows[0].provider, "");
  assert.equal(rows[0].systemPrompt, "");
});

test("machines lists every claiming catalog, sorted; unclaimed is empty", () => {
  const one = buildRoster([entry()], new Map(), [
    catalog("zephyr.local", [PK_A]),
    catalog("crichton.local", []),
  ]);
  assert.deepEqual(one[0].machines, ["zephyr.local"]);

  const both = buildRoster([entry()], new Map(), [
    catalog("zephyr.local", [PK_A]),
    catalog("crichton.local", [PK_A]),
  ]);
  assert.deepEqual(both[0].machines, ["crichton.local", "zephyr.local"]);

  const none = buildRoster([entry()], new Map(), [
    catalog("crichton.local", [PK_B]),
  ]);
  assert.deepEqual(none[0].machines, []);
});

test("duplicate flags only the non-newest member of a same-name group", () => {
  const rows = buildRoster(
    [
      entry({ pubkey: PK_A, updatedAt: 2000 }),
      entry({ pubkey: PK_B, name: " night shift ", updatedAt: 1000 }),
    ],
    new Map(),
    [],
  );
  const byPubkey = new Map(rows.map((row) => [row.pubkey, row]));
  assert.equal(byPubkey.get(PK_A).duplicate, false);
  assert.equal(byPubkey.get(PK_B).duplicate, true);
});

test("rows sort by effective name", () => {
  const rows = buildRoster(
    [
      entry({ pubkey: PK_A, name: "Zeta" }),
      entry({ pubkey: PK_B, name: "Alpha" }),
    ],
    new Map(),
    [],
  );
  assert.deepEqual(
    rows.map((row) => row.name),
    ["Alpha", "Zeta"],
  );
});

test("targetForAgent: one machine targets it; zero or several broadcast", () => {
  assert.deepEqual(targetForAgent(["a.local"]), { target: "a.local" });
  assert.deepEqual(targetForAgent([]), {});
  assert.deepEqual(targetForAgent(["a.local", "b.local"]), {});
});
