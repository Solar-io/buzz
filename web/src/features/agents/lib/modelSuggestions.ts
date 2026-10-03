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
  // Sam 2026-10-03: GPT-6 generation only (6.0 / 6.1).
  openai: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra"],
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
  const mirror = known ?? Object.values(MODEL_SUGGESTIONS_BY_PROVIDER).flat();
  return merged([...mirror, ...registryModels]);
}

/**
 * Models actually in use by the owner: the union of the kind-30177 registry
 * models (unlinked agents) and the kind-30175 definition models (linked
 * agents, whose slimmed 30177 omits the model). Deduped, sorted, no blanks.
 */
export function observedModels(
  registry: readonly { model: string }[],
  personas: ReadonlyMap<string, { model: string }>,
): string[] {
  const all = [
    ...registry.map((entry) => entry.model),
    ...Array.from(personas.values(), (persona) => persona.model),
  ]
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
  return merged(all);
}
