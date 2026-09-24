/**
 * Provider API-key control for agent INSTANCES — a blind set/clear riding the
 * existing admin `update` `envVarsPatch` (catalog >= v2). Mirror of the
 * desktop's `PROVIDER_CREDENTIAL_CONFIG` secret rows
 * (`desktop/src/features/agents/ui/agentConfigOptions.tsx`) and
 * `runtimeSupportsLlmProviderSelection`. The key is never readable back: the
 * admin ack carries no value, so the control's only states are keep / set /
 * clear. Pure, React-free.
 */

// A Map, not an object literal: a provider string like "toString" must not
// resolve through the prototype chain.
const PROVIDER_SECRETS: ReadonlyMap<string, { envVar: string; label: string }> =
  new Map([
    ["anthropic", { envVar: "ANTHROPIC_API_KEY", label: "Anthropic API Key" }],
    [
      "openai",
      { envVar: "OPENAI_COMPAT_API_KEY", label: "OpenAI Runtime API Key" },
    ],
    [
      "openai-compat",
      {
        envVar: "OPENAI_COMPAT_API_KEY",
        label: "OpenAI-compatible Runtime API Key",
      },
    ],
    [
      "openrouter",
      { envVar: "OPENROUTER_API_KEY", label: "OpenRouter API Key" },
    ],
  ]);

/** The provider's secret env var + label, or null (e.g. databricks). */
export function providerSecretEnvVar(
  provider: string,
): { envVar: string; label: string } | null {
  return PROVIDER_SECRETS.get(provider.trim().toLowerCase()) ?? null;
}

/** Runtimes whose LLM provider is selectable (desktop parity). */
const PROVIDER_RUNTIMES = new Set(["buzz-agent", "goose"]);

/**
 * Show the field when the provider has a secret var and the runtime is
 * unknown (null) or one that takes an LLM provider.
 */
export function apiKeyFieldVisible(
  provider: string,
  runtime: string | null,
): boolean {
  if (providerSecretEnvVar(provider) === null) {
    return false;
  }
  return runtime === null || PROVIDER_RUNTIMES.has(runtime.trim());
}

export type ApiKeySelection =
  | { kind: "keep" }
  | { kind: "set"; value: string }
  | { kind: "clear" };

/**
 * The envVarsPatch fragment for the selection: undefined for keep, the
 * trimmed key for set, null (delete) for clear. An empty set is an error —
 * desktop never sends an empty-string key from this field.
 */
export function apiKeyPatch(
  envVar: string,
  selection: ApiKeySelection,
): Record<string, string | null> | undefined | { error: string } {
  if (selection.kind === "keep") {
    return undefined;
  }
  if (selection.kind === "clear") {
    return { [envVar]: null };
  }
  const value = selection.value.trim();
  if (value === "") {
    return { error: "Paste a key, or choose Remove." };
  }
  return { [envVar]: value };
}
