import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/**
 * Kind-30180 desktop-catalog reader — the per-machine projection each Buzz
 * Desktop publishes (d tag = hostname, owner-signed, parameterized
 * replaceable). Mirrors the desktop builder
 * `desktop/src/features/agents/desktopCatalogContent.ts`; pure parse + merge,
 * import-free of React so the node runner can load this file.
 */

export const DESKTOP_CATALOG_KIND = 30180;

export type DesktopCatalogSource = "builtin" | "preset" | "custom";
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

export interface DesktopCatalog {
  /** Machine id (hostname, e.g. "crichton.local") — the event's d tag. */
  machine: string;
  harnesses: DesktopCatalogHarness[];
  /** 64-hex pubkeys of agents runnable on that machine. */
  agents: string[];
  /** Event created_at — the merge key for replaceable updates. */
  updatedAt: number;
}

const SOURCES: DesktopCatalogSource[] = ["builtin", "preset", "custom"];
const AVAILABILITIES: DesktopCatalogAvailability[] = [
  "available",
  "not-installed",
  "adapter-missing",
];
const PUBKEY_RE = /^[0-9a-f]{64}$/;

function parseHarness(value: unknown): DesktopCatalogHarness | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    entry.id.trim().length === 0 ||
    typeof entry.label !== "string" ||
    !SOURCES.includes(entry.source as DesktopCatalogSource) ||
    !AVAILABILITIES.includes(entry.availability as DesktopCatalogAvailability)
  ) {
    return null;
  }
  return {
    id: entry.id,
    label: entry.label || entry.id,
    source: entry.source as DesktopCatalogSource,
    availability: entry.availability as DesktopCatalogAvailability,
  };
}

/**
 * Narrow parse of one 30180 catalog; null for wrong-shape events (wrong kind,
 * wrong format/version, missing or mismatched machine id, bad updated_at).
 * Malformed harness entries and non-hex agents are dropped individually.
 */
export function desktopCatalogFromEvent(
  event: SignedNostrEvent,
): DesktopCatalog | null {
  if (event.kind !== DESKTOP_CATALOG_KIND) {
    return null;
  }
  const dTag = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (typeof dTag !== "string" || dTag.trim().length === 0) {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(event.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.format !== "buzz-desktop-catalog" || parsed.version !== 1) {
    return null;
  }
  const machine =
    typeof parsed.machine === "string"
      ? parsed.machine.trim().toLowerCase()
      : "";
  // The content's machine must agree with the d tag — a mismatched event is
  // not a catalog anyone can address commands by.
  if (!machine || machine !== dTag.trim().toLowerCase()) {
    return null;
  }
  if (
    typeof parsed.updated_at !== "number" ||
    !Number.isFinite(parsed.updated_at)
  ) {
    return null;
  }
  const harnesses = Array.isArray(parsed.harnesses)
    ? parsed.harnesses
        .map(parseHarness)
        .filter((entry): entry is DesktopCatalogHarness => entry !== null)
    : [];
  const agents = Array.isArray(parsed.agents)
    ? parsed.agents
        .filter(
          (pk): pk is string => typeof pk === "string" && PUBKEY_RE.test(pk),
        )
        .map((pk) => pk.toLowerCase())
    : [];
  return {
    machine,
    harnesses,
    agents: Array.from(new Set(agents)),
    updatedAt: parsed.updated_at,
  };
}

/** Newest-wins merge into a catalog map (replaceable coordinate = machine). */
export function mergeDesktopCatalog(
  catalogs: Map<string, DesktopCatalog>,
  catalog: DesktopCatalog,
): Map<string, DesktopCatalog> {
  const existing = catalogs.get(catalog.machine);
  if (existing && existing.updatedAt >= catalog.updatedAt) {
    return catalogs;
  }
  const next = new Map(catalogs);
  next.set(catalog.machine, catalog);
  return next;
}
