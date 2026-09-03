import type { DesktopCatalog } from "../lib/desktopCatalog";

/**
 * Harness dropdown — MOVED verbatim from AgentAdminPanel.tsx (Phase 1 file
 * map #12). Live catalog when at least one desktop published a kind-30180;
 * static preset mirror otherwise, with a hint about the live list.
 */

/** Static mirror of the desktop's runtime catalog (discovery.rs + presets.rs). */
export const PRESET_HARNESSES: { id: string; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "buzz-agent", label: "Buzz Agent" },
  { id: "devin", label: "Devin" },
  { id: "cursor", label: "Cursor" },
  { id: "omp", label: "Oh My Pi" },
  { id: "grok", label: "Grok Build" },
  { id: "opencode", label: "OpenCode" },
  { id: "kimi", label: "Kimi Code" },
  { id: "amp", label: "Amp" },
  { id: "hermes", label: "Hermes Agent" },
  { id: "openclaw", label: "OpenClaw" },
];

/** Availability suffix shown next to a harness label, when not "available". */
export function availabilitySuffix(availability: string): string {
  if (availability === "not-installed") {
    return " (not installed)";
  }
  if (availability === "adapter-missing") {
    return " (adapter missing)";
  }
  return "";
}

/**
 * Union of every published catalog's harnesses, custom-first then presets,
 * deduped by id (custom wins a conflict — it is what the owner actually
 * runs). Options stay selectable regardless of availability: the desktop is
 * the executor and its state may differ by the time the command lands.
 */
export function mergedCatalogHarnesses(
  catalogs: DesktopCatalog[],
): { id: string; label: string; availability: string }[] {
  const byId = new Map<
    string,
    { id: string; label: string; availability: string; rank: number }
  >();
  const rank = (source: string) => (source === "custom" ? 0 : 1);
  for (const catalog of catalogs) {
    for (const harness of catalog.harnesses) {
      const existing = byId.get(harness.id);
      if (!existing || rank(harness.source) < existing.rank) {
        byId.set(harness.id, {
          id: harness.id,
          label: harness.label,
          availability: harness.availability,
          rank: rank(harness.source),
        });
      }
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map(({ id, label, availability }) => ({ id, label, availability }));
}

/**
 * `includeKeep` (edit mode) prepends a no-change option so the current
 * harness survives unless the user picks one.
 */
export function HarnessSelect({
  value,
  onChange,
  catalogs,
  ariaLabel,
  includeKeep,
}: {
  value: string;
  onChange: (next: string) => void;
  catalogs: DesktopCatalog[];
  ariaLabel: string;
  includeKeep?: boolean;
}) {
  const live = mergedCatalogHarnesses(catalogs);
  return (
    <div className="block space-y-1">
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">Harness</span>
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          aria-label={ariaLabel}
        >
          {includeKeep && (
            <option value="__keep">Keep current (unchanged)</option>
          )}
          {live.length > 0
            ? live.map((harness) => (
                <option key={harness.id} value={harness.id}>
                  {harness.label}
                  {availabilitySuffix(harness.availability)}
                </option>
              ))
            : PRESET_HARNESSES.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
          <option value="__custom">Custom command…</option>
        </select>
      </label>
      {live.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Live harness list appears once your desktop publishes its catalog.
        </p>
      )}
    </div>
  );
}
