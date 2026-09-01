import type { AcpAvailabilityStatus } from "@/shared/api/types";

/**
 * Kind-30180 desktop-catalog content — pure builder, no Tauri imports, so it
 * is unit-testable from node. The wire contract (mirror in
 * `web/src/features/agents/lib/desktopCatalog.ts`):
 *
 * ```json
 * {
 *   "format": "buzz-desktop-catalog",
 *   "version": 1,
 *   "machine": "crichton.local",
 *   "harnesses": [
 *     {"id": "claude-code-glm", "label": "Claude Code GLM", "source": "custom",
 *      "availability": "available"}
 *   ],
 *   "agents": ["<64-hex agent pubkeys runnable on THIS machine>"],
 *   "updated_at": 1788300000
 * }
 * ```
 *
 * Security: same opt-IN discipline as `agent_events.rs`. The input type
 * physically cannot carry commands, args, env, or file paths — a harness entry
 * is `{id, label, source, availability}` and nothing else — so the builder
 * cannot leak the runnable config even by mistake. It MUST stay that way.
 */

export const DESKTOP_CATALOG_KIND = 30180;
export const DESKTOP_CATALOG_FORMAT = "buzz-desktop-catalog";
export const DESKTOP_CATALOG_VERSION = 1;

/** Wire `source` values — the desktop harness catalog's three tiers. */
export type DesktopCatalogSource = "builtin" | "preset" | "custom";

/**
 * Wire `availability` values. A projection of the desktop's
 * `AcpAvailabilityStatus` into the three states the web cares about: can run
 * now, not installed, or the ACP adapter itself is missing/outdated.
 */
export type DesktopCatalogAvailability =
  | "available"
  | "not-installed"
  | "adapter-missing";

export interface DesktopCatalogHarness {
  id: string;
  label: string;
  source: DesktopCatalogSource;
  availability: DesktopCatalogAvailability;
}

/** Map the desktop's full availability status onto the wire projection. */
export function catalogAvailability(
  status: AcpAvailabilityStatus,
): DesktopCatalogAvailability {
  switch (status) {
    case "available":
      return "available";
    case "adapter_missing":
    case "adapter_outdated":
      return "adapter-missing";
    case "not_installed":
    case "cli_missing":
      return "not-installed";
  }
}

/** Custom harnesses first (they are what the owner actually runs), then presets, then builtins; ties by label. */
const SOURCE_ORDER: Record<DesktopCatalogSource, number> = {
  custom: 0,
  preset: 1,
  builtin: 2,
};

const PUBKEY_RE = /^[0-9a-f]{64}$/;

/**
 * Build the kind-30180 content object. Deterministic: harness order follows
 * `SOURCE_ORDER` then label; agents are deduped and sorted, so identical input
 * always serializes to identical bytes (the publisher hash-compares them).
 */
export function buildDesktopCatalogContent(input: {
  machine: string;
  harnesses: DesktopCatalogHarness[];
  agentPubkeys: string[];
  updatedAt: number;
}): {
  format: typeof DESKTOP_CATALOG_FORMAT;
  version: typeof DESKTOP_CATALOG_VERSION;
  machine: string;
  harnesses: DesktopCatalogHarness[];
  agents: string[];
  updated_at: number;
} {
  const machine = input.machine.trim().toLowerCase();
  const harnesses = input.harnesses
    .filter((harness) => harness.id.trim().length > 0)
    .map((harness) => ({
      id: harness.id,
      label: harness.label || harness.id,
      source: harness.source,
      availability: harness.availability,
    }))
    .sort((a, b) => {
      const bySource = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
      return bySource !== 0 ? bySource : a.label.localeCompare(b.label);
    });
  const agents = Array.from(
    new Set(input.agentPubkeys.map((pk) => pk.trim().toLowerCase())),
  )
    .filter((pk) => PUBKEY_RE.test(pk))
    .sort();
  return {
    format: DESKTOP_CATALOG_FORMAT,
    version: DESKTOP_CATALOG_VERSION,
    machine,
    harnesses,
    agents,
    updated_at: input.updatedAt,
  };
}
