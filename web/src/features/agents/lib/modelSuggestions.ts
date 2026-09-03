/**
 * Model-suggestion mirror for the web create/edit datalists. The desktop
 * never keeps a static model table — it discovers models live per harness
 * (`buzz-acp models --json`, the OpenRouter /models API, Databricks endpoints;
 * desktop/src-tauri/src/commands/agent_models*.rs) — and the web has no
 * equivalent read path. This file is therefore a deliberate web-side mirror
 * in the same stance as PRESET_HARNESSES: a small, hand-maintained list of
 * model ids each provider commonly serves, UNIONED with the models observed
 * in the owner's own kind-30177 registry so real usage always wins. It is a
 * suggestion list, never validation — free text stays allowed.
 */

/**
 * Static per-provider mirror, keyed by lowercase provider id. Absent
 * provider (custom/unknown) → the union of every list. Updating a list is a
 * deliberate act (pinned by modelSuggestions.test.mjs).
 */
export const MODEL_SUGGESTIONS_BY_PROVIDER: Readonly<
  Record<string, readonly string[]>
> = {
  anthropic: ["claude-opus-4-6", "claude-opus-4-5"],
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
  zai: ["glm-5.3", "glm-5.3-flash"],
};

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function merged(models: readonly string[]): string[] {
  return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
}

/**
 * Datalist entries for a provider: the static mirror's entries for that
 * provider (or the union across providers when unknown/custom) merged with
 * the registry-observed models, deduped and sorted.
 */
export function modelSuggestions(
  provider: string,
  registryModels: readonly string[],
): string[] {
  const known = MODEL_SUGGESTIONS_BY_PROVIDER[normalizeProvider(provider)];
  const mirror =
    known ?? Object.values(MODEL_SUGGESTIONS_BY_PROVIDER).flat();
  return merged([...mirror, ...registryModels]);
}
