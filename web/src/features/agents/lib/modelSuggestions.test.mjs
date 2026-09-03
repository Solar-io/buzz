import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MODEL_SUGGESTIONS_BY_PROVIDER,
  modelSuggestions,
} from "./modelSuggestions.ts";

test("the static mirror is pinned exactly (updating it is deliberate)", () => {
  assert.deepEqual(MODEL_SUGGESTIONS_BY_PROVIDER, {
    anthropic: ["claude-opus-4-6", "claude-opus-4-5"],
    openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
    zai: ["glm-5.3", "glm-5.3-flash"],
  });
});

test("known provider merges mirror entries with registry models, sorted + deduped", () => {
  assert.deepEqual(
    modelSuggestions("openai", ["glm-5.3"]),
    ["glm-5.3", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5"],
  );
  // Registry model that also sits in the mirror must not duplicate.
  assert.deepEqual(modelSuggestions("zai", ["glm-5.3"]), [
    "glm-5.3",
    "glm-5.3-flash",
  ]);
});

test("provider matching is trimmed + case-insensitive", () => {
  assert.deepEqual(modelSuggestions(" ZAI ", []), ["glm-5.3", "glm-5.3-flash"]);
});

test("unknown/custom provider falls back to the union including registry models", () => {
  assert.deepEqual(modelSuggestions("my-gateway", ["glm-5.3"]), [
    "claude-opus-4-5",
    "claude-opus-4-6",
    "glm-5.3",
    "glm-5.3-flash",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
  ]);
});

test("empty provider string is unknown, not a provider named ''", () => {
  assert.deepEqual(modelSuggestions("", ["solo-model"]), [
    "claude-opus-4-5",
    "claude-opus-4-6",
    "glm-5.3",
    "glm-5.3-flash",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "solo-model",
  ]);
});
