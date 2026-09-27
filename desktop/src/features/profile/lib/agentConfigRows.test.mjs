import assert from "node:assert/strict";
import test from "node:test";

import { agentConfigRows, runtimeLabel } from "./agentConfigRows.ts";

const EFFORT = {
  acp: "medium",
  textTurn: "low",
  voiceTurn: null,
  thinking: "high",
  claudeCode: null,
  maxContextTokens: 555000,
};

test("rows with effort, in the shared order", () => {
  const rows = agentConfigRows({
    agent: {
      model: "my-custom-model",
      provider: "acme",
      agentCommand: "claude-code",
      effort: EFFORT,
    },
    voice: "Pocket · Alba",
  });
  assert.deepEqual(
    rows.map((r) => [r.label, r.value]),
    [
      ["Model", "my-custom-model"],
      ["Provider", "acme"],
      ["Runtime", "Claude Code"],
      ["Effort", "medium"],
      ["Text-turn effort", "low"],
      ["Thinking effort", "high"],
      ["Max context", "555,000 tokens"],
      ["Voice", "Pocket · Alba"],
    ],
  );
});

test("rows without effort omit every effort row", () => {
  const rows = agentConfigRows({
    agent: {
      model: "",
      provider: null,
      agentCommand: "goose",
      effort: null,
    },
  });
  assert.deepEqual(
    rows.map((r) => r.key),
    ["runtime"],
  );
});

test("unmanaged agent falls back to the relay agent type", () => {
  assert.deepEqual(agentConfigRows({ agent: null, fallbackRuntime: "aider" }), [
    { key: "runtime", label: "Runtime", value: "Aider" },
  ]);
  assert.deepEqual(agentConfigRows({ agent: null }), []);
  assert.equal(runtimeLabel("custom-x"), "custom-x");
});
