import type { AgentRegistryEntry } from "./agentRegistry";
import type { DesktopCatalog } from "./desktopCatalog";

/**
 * Stale-registration detection — pure, so the cleanup list is testable
 * without a relay. Two independent reasons a registration is stale:
 *
 * 1. **Non-keeper duplicate name** (catalog-aware, deterministic): two
 *    entries share a normalized name from an old key re-mint. The group's
 *    keeper is the member a desktop catalog CLAIMS — liveness outranks
 *    recency, because `updatedAt` moves on operational saves while a live
 *    seat keeps its original registration (the 9/2 rekey incident: five
 *    live 8/24-era keys were flagged "older duplicates" of newer re-mint
 *    twins and deleted). With no claim to break the tie, the newest
 *    `updatedAt` wins (ties keep the highest pubkey, so the result never
 *    depends on input order).
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

/** Newest `updatedAt`, ties broken by highest pubkey for input-order independence. */
function newestUpdated(entries: AgentRegistryEntry[]): AgentRegistryEntry {
  return entries.reduce((best, entry) => {
    if (entry.updatedAt > best.updatedAt) {
      return entry;
    }
    if (entry.updatedAt === best.updatedAt && entry.pubkey > best.pubkey) {
      return entry;
    }
    return best;
  });
}

/** Pubkeys claimed by at least one published desktop catalog. */
function claimedPubkeys(catalogs: DesktopCatalog[]): Set<string> {
  return new Set(catalogs.flatMap((catalog) => catalog.agents));
}

interface KeeperDecision {
  keeper: AgentRegistryEntry;
  /** True when the keeper was chosen for liveness (catalog claim), not recency. */
  keeperIsClaimed: boolean;
}

/**
 * Pick a duplicate group's keeper: liveness first, recency as fallback.
 *
 * - Exactly one catalog-claimed member → it is the keeper, however old its
 *   `updatedAt` is (a desktop still running it is the ground truth of life).
 * - Multiple claimed members → newest `updatedAt` among the claimed.
 * - None claimed → newest `updatedAt` in the whole group (legacy behavior).
 */
function keeperForGroup(
  group: AgentRegistryEntry[],
  claimed: Set<string>,
): KeeperDecision {
  const claimedMembers = group.filter((entry) => claimed.has(entry.pubkey));
  if (claimedMembers.length > 0) {
    return {
      keeper: newestUpdated(claimedMembers),
      keeperIsClaimed: true,
    };
  }
  return { keeper: newestUpdated(group), keeperIsClaimed: false };
}

function groupByNormalizedName(
  entries: AgentRegistryEntry[],
): Map<string, AgentRegistryEntry[]> {
  const groups = new Map<string, AgentRegistryEntry[]>();
  for (const entry of entries) {
    const key = normalizeName(entry.name);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return groups;
}

/** Duplicate-name groups with at least two members, with their keeper decided. */
function keeperByNormalizedName(
  entries: AgentRegistryEntry[],
  claimed: Set<string>,
): Map<
  string,
  {
    keeper: AgentRegistryEntry;
    group: AgentRegistryEntry[];
    keeperIsClaimed: boolean;
  }
> {
  const keepers = new Map<
    string,
    {
      keeper: AgentRegistryEntry;
      group: AgentRegistryEntry[];
      keeperIsClaimed: boolean;
    }
  >();
  for (const [key, group] of groupByNormalizedName(entries)) {
    if (group.length < 2) {
      continue;
    }
    const decision = keeperForGroup(group, claimed);
    keepers.set(key, { ...decision, group });
  }
  return keepers;
}

export function findStaleAgents(
  entries: AgentRegistryEntry[],
  catalogs: DesktopCatalog[],
): StaleAgent[] {
  const stale = new Map<string, StaleAgent>();
  const claimed = claimedPubkeys(catalogs);

  // 1. Non-keeper duplicates by normalized name.
  for (const { keeper, group, keeperIsClaimed } of keeperByNormalizedName(
    entries,
    claimed,
  ).values()) {
    for (const entry of group) {
      if (entry.pubkey === keeper.pubkey) {
        continue;
      }
      stale.set(entry.pubkey, {
        pubkey: entry.pubkey,
        name: entry.name,
        reason:
          keeperIsClaimed && entry.updatedAt > keeper.updatedAt
            ? `newer unclaimed duplicate of ${keeper.name}`
            : `older duplicate of ${keeper.name}`,
      });
    }
  }

  // 2. Unclaimed: only once catalogs exist AND at least one claim was made.
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
 * Pubkeys that lost the keeper pick in a duplicate-name group — used to
 * badge rows in the main list so the duplicate state is legible before any
 * cleanup. Catalog-aware for the same reason as `findStaleAgents`.
 */
export function duplicatePubkeys(
  entries: AgentRegistryEntry[],
  catalogs: DesktopCatalog[],
): Set<string> {
  const dupes = new Set<string>();
  for (const { keeper, group } of keeperByNormalizedName(
    entries,
    claimedPubkeys(catalogs),
  ).values()) {
    for (const entry of group) {
      if (entry.pubkey !== keeper.pubkey) {
        dupes.add(entry.pubkey);
      }
    }
  }
  return dupes;
}
