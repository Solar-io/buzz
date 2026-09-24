import assert from "node:assert/strict";
import { test } from "node:test";
import { isReservedEnvKey } from "./envRows.ts";
import {
  apiKeyFieldVisible,
  apiKeyPatch,
  providerSecretEnvVar,
} from "./providerApiKey.ts";

test("the four provider mappings mirror the desktop table", () => {
  assert.deepEqual(providerSecretEnvVar("anthropic"), {
    envVar: "ANTHROPIC_API_KEY",
    label: "Anthropic API Key",
  });
  assert.deepEqual(providerSecretEnvVar("openai"), {
    envVar: "OPENAI_COMPAT_API_KEY",
    label: "OpenAI Runtime API Key",
  });
  assert.deepEqual(providerSecretEnvVar("openai-compat"), {
    envVar: "OPENAI_COMPAT_API_KEY",
    label: "OpenAI-compatible Runtime API Key",
  });
  assert.deepEqual(providerSecretEnvVar(" OpenRouter "), {
    envVar: "OPENROUTER_API_KEY",
    label: "OpenRouter API Key",
  });
});

test("databricks, unknown, and prototype keys have no secret var", () => {
  assert.equal(providerSecretEnvVar("databricks"), null);
  assert.equal(providerSecretEnvVar("databricks_v2"), null);
  assert.equal(providerSecretEnvVar("zai"), null);
  assert.equal(providerSecretEnvVar("toString"), null);
});

test("visibility: provider runtimes and unknown runtime only", () => {
  assert.equal(apiKeyFieldVisible("openrouter", "goose"), true);
  assert.equal(apiKeyFieldVisible("openrouter", "buzz-agent"), true);
  assert.equal(apiKeyFieldVisible("openrouter", null), true);
  assert.equal(apiKeyFieldVisible("openrouter", "claude-code"), false);
  assert.equal(apiKeyFieldVisible("openrouter", "codex"), false);
  assert.equal(apiKeyFieldVisible("databricks", "goose"), false);
});

test("patch shapes: keep, set (trimmed), clear, empty set is an error", () => {
  assert.equal(apiKeyPatch("OPENROUTER_API_KEY", { kind: "keep" }), undefined);
  assert.deepEqual(
    apiKeyPatch("OPENROUTER_API_KEY", { kind: "set", value: " sk-1 " }),
    { OPENROUTER_API_KEY: "sk-1" },
  );
  assert.deepEqual(apiKeyPatch("OPENROUTER_API_KEY", { kind: "clear" }), {
    OPENROUTER_API_KEY: null,
  });
  assert.deepEqual(
    apiKeyPatch("OPENROUTER_API_KEY", { kind: "set", value: "  " }),
    { error: "Paste a key, or choose Remove." },
  );
});

test("none of the secret env vars is reserved", () => {
  for (const envVar of [
    "ANTHROPIC_API_KEY",
    "OPENAI_COMPAT_API_KEY",
    "OPENROUTER_API_KEY",
  ]) {
    assert.equal(isReservedEnvKey(envVar), false, envVar);
  }
});
