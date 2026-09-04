/**
 * Preview-feature gates — the web mirror of the desktop's feature manifest.
 *
 * The desktop's rule, from `SettingsView.tsx`: *"Manifest is preview-only — if
 * the gate id is in the manifest, it's preview and needs an opt-in; if it's
 * not, it's stable and renders unconditionally (fail-open)."* That fail-open
 * default matters more than it looks: an unknown id must render, so a gate
 * that is renamed or removed never silently hides a shipped feature.
 *
 * Only genuinely preview things belong here. A gate whose feature is finished
 * is worse than no gate, because it hides working code behind a switch nobody
 * finds.
 *
 * Import-free so `node --test` can load it.
 */

export interface FeatureDefinition {
  id: string;
  name: string;
  description: string;
  /** Whether a fresh browser sees it on. */
  defaultEnabled: boolean;
}

/**
 * `channel-templates` mirrors the desktop, where the settings section carries
 * `featureGate: "channel-templates"` (`SettingsPanels.tsx:189`). Keeping the
 * same id means a user who knows the desktop finds the same switch here.
 */
export const WEB_FEATURES: FeatureDefinition[] = [
  {
    id: "channel-templates",
    name: "Channel templates",
    description:
      "Reusable shapes for new channels — type, visibility, topic, and an agent roster. Matches the desktop's preview flag of the same name.",
    defaultEnabled: false,
  },
];

export type FeatureState = Record<string, boolean>;

export function featureById(id: string): FeatureDefinition | null {
  return WEB_FEATURES.find((feature) => feature.id === id) ?? null;
}

/**
 * Whether `id` should render.
 *
 * Fail-open on an unknown id: anything not in the manifest is stable and
 * renders unconditionally. An explicit stored choice always wins over the
 * definition's default.
 */
export function resolveEnabled(id: string, state: FeatureState): boolean {
  const definition = featureById(id);
  if (!definition) return true;
  const stored = state[id];
  return typeof stored === "boolean" ? stored : definition.defaultEnabled;
}

/** Parse persisted state, dropping anything that is not a known boolean. */
export function parseFeatureState(raw: unknown): FeatureState {
  if (typeof raw !== "object" || raw === null) return {};
  const out: FeatureState = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "boolean" && featureById(key)) {
      out[key] = value;
    }
  }
  return out;
}

export function withFeature(
  state: FeatureState,
  id: string,
  enabled: boolean,
): FeatureState {
  return { ...state, [id]: enabled };
}
