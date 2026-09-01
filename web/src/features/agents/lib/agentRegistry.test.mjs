import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFromEvent, mergeAgentEntry } from "./agentRegistry.ts";

const D = "aa".repeat(32);
const OTHER = "bb".repeat(32);

function event(overrides = {}) {
  return {
    id: "x".repeat(64),
    pubkey: "cc".repeat(32),
    kind: 30177,
    created_at: 1000,
    tags: [["d", D]],
    content: JSON.stringify({
      name: "Test Agent",
      system_prompt: "You test.",
      model: "glm-5.3",
      provider: "zai",
      respond_to: "allowlist",
      respond_to_allowlist: [OTHER],
    }),
    sig: "s".repeat(128),
    ...overrides,
  };
}

test("agentFromEvent parses the projection", () => {
  const entry = agentFromEvent(event());
  assert.equal(entry.pubkey, D);
  assert.equal(entry.name, "Test Agent");
  assert.equal(entry.model, "glm-5.3");
  assert.equal(entry.provider, "zai");
  assert.equal(entry.respondTo, "allowlist");
  assert.deepEqual(entry.respondToAllowlist, [OTHER]);
});

test("agentFromEvent rejects wrong kind, bad d tag, and bad JSON", () => {
  assert.equal(agentFromEvent(event({ kind: 1 })), null);
  assert.equal(agentFromEvent(event({ tags: [["d", "nope"]] })), null);
  assert.equal(agentFromEvent(event({ content: "{" })), null);
});

test("agentFromEvent defaults: no name falls back to pubkey prefix", () => {
  const entry = agentFromEvent(
    event({ content: JSON.stringify({ model: "m" }) }),
  );
  assert.equal(entry.name, D.slice(0, 8));
  assert.equal(entry.respondTo, "owner-only");
});

test("agentFromEvent surfaces persona_id (slimming marker) and parallelism", () => {
  const linked = agentFromEvent(
    event({
      content: JSON.stringify({
        name: "Linked",
        persona_id: "persona-1",
        parallelism: 4,
        respond_to: "owner-only",
      }),
    }),
  );
  assert.equal(linked.personaId, "persona-1");
  assert.equal(linked.parallelism, 4);
  assert.equal(linked.systemPrompt, "");

  const unlinked = agentFromEvent(
    event({
      content: JSON.stringify({ name: "Solo", parallelism: 0 }),
    }),
  );
  assert.equal(unlinked.personaId, null);
  assert.equal(unlinked.parallelism, null);
});

test("mergeAgentEntry is newest-wins and immutable", () => {
  const first = agentFromEvent(event());
  const newer = agentFromEvent(
    event({ created_at: 2000, content: JSON.stringify({ name: "Renamed" }) }),
  );
  const older = agentFromEvent(event({ created_at: 500 }));
  let registry = mergeAgentEntry(new Map(), first);
  registry = mergeAgentEntry(registry, newer);
  registry = mergeAgentEntry(registry, older);
  assert.equal(registry.get(D).name, "Renamed");
  assert.equal(registry.size, 1);
});

test("mergeAgentEntry keys distinct agents separately", () => {
  let registry = mergeAgentEntry(new Map(), agentFromEvent(event()));
  registry = mergeAgentEntry(
    registry,
    agentFromEvent(event({ tags: [["d", OTHER]] })),
  );
  assert.equal(registry.size, 2);
});
