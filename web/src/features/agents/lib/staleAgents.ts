import type { AgentRegistryEntry } from "./agentRegistry";
import type { DesktopCatalog } from "./desktopCatalog";

/**
 * Stale-registration detection — pure, so the cleanup list is testable
 * without a relay. Two independent reasons a registration is stale:
 *
 * 1. **Older duplicate name** (catalog-free, deterministic): two entries
 *    share a normalized name from an old key re-mint. The group's newest
 *    `updatedAt` wins (ties keep the highest pubkey, so the result never
 *    depends on input order); the rest are older duplicates of the keeper.
 * 2. **Not reported by any desktop**: with at least one kind-30180 catalog
 *    published, an agent pubkey no catalog claims is a registration whose
 *    desktop is gone. Flagged ONLY when the union of claims is non-empty —
 *    a lone catalog with an empty `agents` list is a machine claiming
 *    nothing (offline desktops must not nuke the whole registry), and with
 *    zero catalogs there is nothing to compare against at all.
 *
 * An entry that is both gets the duplicate reason (more specific), one row
 * per pubkey.
 */

export interface StaleAgent {
  pubkey: string;
  name: string;
  reason: string;
}

/** "Night Shift" and "night shift " are the same agent name. */
function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

/**
 * Group entries by normalized name and pick each group's keeper: newest
 * `updatedAt`, ties broken by highest pubkey for input-order independence.
 */
function keeperByNormalizedName(
  entries: AgentRegistryEntry[],
): Map<string, { keeper: AgentRegistryEntry; group: AgentRegistryEntry[] }> {
  const groups = new Map<string, AgentRegistryEntry[]>();
  for (const entry of entries) {
    const key = normalizeName(entry.name);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const keepers = new Map<
    string,
    { keeper: AgentRegistryEntry; group: AgentRegistryEntry[] }
  >();
  for (const [key, group] of groups) {
    if (group.length < 2) {
      continue;
    }
    const keeper = group.reduce((best, entry) => {
      if (entry.updatedAt > best.updatedAt) {
        return entry;
      }
      if (entry.updatedAt === best.updatedAt && entry.pubkey > best.pubkey) {
        return entry;
      }
      return best;
    });
    keepers.set(key, { keeper, group });
  }
  return keepers;
}

export function findStaleAgents(
  entries: AgentRegistryEntry[],
  catalogs: DesktopCatalog[],
): StaleAgent[] {
  const stale = new Map<string, StaleAgent>();

  // 1. Older duplicates by normalized name.
  for (const { keeper, group } of keeperByNormalizedName(entries).values()) {
    for (const entry of group) {
      if (entry.pubkey !== keeper.pubkey) {
        stale.set(entry.pubkey, {
          pubkey: entry.pubkey,
          name: entry.name,
          reason: `older duplicate of ${keeper.name}`,
        });
      }
    }
  }

  // 2. Unclaimed: only once catalogs exist AND at least one claim was made.
  const claimed = new Set(catalogs.flatMap((catalog) => catalog.agents));
  if (claimed.size > 0) {
    for (const entry of entries) {
      if (!claimed.has(entry.pubkey) && !stale.has(entry.pubkey)) {
        stale.set(entry.pubkey, {
          pubkey: entry.pubkey,
          name: entry.name,
          reason: "not reported by any desktop",
        });
      }
    }
  }

  return Array.from(stale.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * Pubkeys that are the non-newest member of a duplicate-name group — used to
 * badge rows in the main list so the duplicate state is legible before any
 * cleanup.
 */
export function duplicatePubkeys(entries: AgentRegistryEntry[]): Set<string> {
  const dupes = new Set<string>();
  for (const { keeper, group } of keeperByNormalizedName(entries).values()) {
    for (const entry of group) {
      if (entry.pubkey !== keeper.pubkey) {
        dupes.add(entry.pubkey);
      }
    }
  }
  return dupes;
}
