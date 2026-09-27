import assert from "node:assert/strict";
import { test } from "node:test";
import { agentConfigRows, shouldArmAgentHover } from "./agentConfigCard.ts";

const PK = "aa".repeat(32);

function entry(overrides = {}) {
  return {
    pubkey: PK,
    name: "Evie",
    systemPrompt: "",
    model: "own-model",
    provider: "own-provider",
    personaId: null,
    parallelism: null,
    respondTo: "owner-only",
    respondToAllowlist: [],
    updatedAt: 1000,
    effort: null,
    ...overrides,
  };
}

function persona(overrides = {}) {
  return {
    id: "evie",
    name: "Evie",
    systemPrompt: "",
    model: "claude-opus-5-5",
    provider: "anthropic",
    runtime: "claude-code",
    updatedAt: 900,
    event: {},
    ...overrides,
  };
}

const FULL_EFFORT = {
  acp: "high",
  textTurn: "low",
  voiceTurn: "minimal",
  thinking: "medium",
  claudeCode: "xhigh",
  maxContextTokens: 555000,
};

test("linked agent takes model/provider/runtime from the persona", () => {
  const rows = agentConfigRows({
    entry: entry({ personaId: "evie", model: "", provider: "" }),
    persona: persona(),
    voice: null,
  });
  assert.deepEqual(
    rows.map((r) => [r.label, r.value]),
    [
      ["Model", "claude-opus-5-5"],
      ["Provider", "anthropic"],
      ["Runtime", "claude-code"],
    ],
  );
});

test("standalone agent takes model/provider from its own entry", () => {
  const rows = agentConfigRows({ entry: entry(), persona: null, voice: null });
  assert.deepEqual(
    rows.map((r) => [r.key, r.value]),
    [
      ["model", "own-model"],
      ["provider", "own-provider"],
    ],
  );
});

test("empty values are omitted", () => {
  const rows = agentConfigRows({
    entry: entry({ model: "", provider: "  " }),
    persona: null,
    voice: "",
  });
  assert.deepEqual(rows, []);
  assert.deepEqual(
    agentConfigRows({ entry: null, persona: null, voice: null }),
    [],
  );
});

test("full order: model, provider, runtime, efforts, context, voice", () => {
  const rows = agentConfigRows({
    entry: entry({ personaId: "evie", effort: FULL_EFFORT }),
    persona: persona(),
    voice: "Pocket · Alba",
  });
  assert.deepEqual(
    rows.map((r) => [r.label, r.value]),
    [
      ["Model", "claude-opus-5-5"],
      ["Provider", "anthropic"],
      ["Runtime", "claude-code"],
      ["Effort", "high"],
      ["Text-turn effort", "low"],
      ["Voice-turn effort", "minimal"],
      ["Thinking effort", "medium"],
      ["Claude Code effort", "xhigh"],
      ["Max context", "555,000 tokens"],
      ["Voice", "Pocket · Alba"],
    ],
  );
});

test("shouldArmAgentHover truth table", () => {
  assert.equal(shouldArmAgentHover("mouse", true), true);
  assert.equal(shouldArmAgentHover("pen", true), true);
  assert.equal(shouldArmAgentHover("touch", true), false);
  assert.equal(shouldArmAgentHover("mouse", false), false);
  assert.equal(shouldArmAgentHover("touch", false), false);
});
