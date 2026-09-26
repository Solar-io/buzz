import type { AgentRegistryEntry } from "./agentRegistry";
import type { DesktopCatalog } from "./desktopCatalog";
import { findStaleAgents } from "./staleAgents.ts";

/**
 * The ONE "which agents can I pick" selector — the New-DM, add-to-channel and
 * add-to-huddle pickers all go through it so they agree. Deleted/unavailable
 * registrations are HIDDEN, not demoted: a dead key dead-letters every DM.
 *
 * What counts as evidence, and why (live data, 2026-09-26):
 *
 * - **Fresh catalogs only.** Desktops republish their kind-30180 catalog
 *   every 6h while running (`REPUBLISH_INTERVAL_MS`), so a catalog older than
 *   `CATALOG_FRESH_SECONDS` (four missed republishes) is a desktop that is not
 *   running; its claims describe a past roster. aeryn.local's catalog was a
 *   week old.
 * - **Claims are authoritative only from `AUTHORITATIVE_CATALOG_VERSION`.**
 *   Catalogs up to v3 claim only agents whose legacy stored `relay_url` pin
 *   equals the active relay — a pin the runtime deliberately ignores (#2122).
 *   crichton.local's v3 catalog claimed 3 of ~18 live agents (the only three
 *   records still pinned), so "unclaimed ⇒ gone" would hide nearly every live
 *   agent. A v3 claim is still positive evidence of LIFE, so it may pick a
 *   duplicate-name keeper; it can never condemn an unclaimed key.
 * - **Never hide on recency alone.** Without a claim, the newest duplicate is
 *   not the live one: live Acid Burn/Gilfoyle/Lord Nikon/Cereal Killer are
 *   the 09-02 17:12 keys, with newer 17:49 unclaimed twins.
 * - **Safety:** no fresh catalogs, or an empty claim union, hides nothing.
 */

export const AUTHORITATIVE_CATALOG_VERSION = 4;
export const CATALOG_FRESH_SECONDS = 24 * 60 * 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Catalogs whose desktop has republished recently enough to be running. */
export function freshCatalogs(
  catalogs: readonly DesktopCatalog[],
  now: number = nowSeconds(),
): DesktopCatalog[] {
  return catalogs.filter(
    (catalog) => now - catalog.updatedAt <= CATALOG_FRESH_SECONDS,
  );
}

/** Pubkeys of registry agents that must not be offered in a picker. */
export function unavailableAgentPubkeys(
  entries: readonly AgentRegistryEntry[],
  catalogs: readonly DesktopCatalog[],
  now: number = nowSeconds(),
): Set<string> {
  const fresh = freshCatalogs(catalogs, now);
  const authoritative = fresh.filter(
    (catalog) => catalog.version >= AUTHORITATIVE_CATALOG_VERSION,
  );
  const authoritativeClaims = new Set(
    authoritative.flatMap((catalog) => catalog.agents),
  );
  if (authoritativeClaims.size > 0) {
    // Complete claims: unclaimed and non-keeper duplicates are both gone.
    return new Set(
      findStaleAgents([...entries], authoritative).map((s) => s.pubkey),
    );
  }

  // Partial claims (pre-v4): only a duplicate group with a claimed member is
  // decidable — hide its unclaimed members. Everything else stays visible.
  const claimed = new Set(fresh.flatMap((catalog) => catalog.agents));
  const hidden = new Set<string>();
  if (claimed.size === 0) {
    return hidden;
  }
  const groups = new Map<string, AgentRegistryEntry[]>();
  for (const entry of entries) {
    const key = entry.name.trim().toLocaleLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const group of groups.values()) {
    if (group.length < 2 || !group.some((e) => claimed.has(e.pubkey))) {
      continue;
    }
    for (const entry of group) {
      if (!claimed.has(entry.pubkey)) {
        hidden.add(entry.pubkey);
      }
    }
  }
  return hidden;
}

/**
 * Picker candidates with unavailable agents removed — from the agent list AND
 * from contacts (an existing DM with a deleted agent must not resurrect it).
 */
export function selectAvailableCandidates({
  agents,
  contacts = [],
  catalogs,
  now = nowSeconds(),
}: {
  agents: readonly AgentRegistryEntry[];
  contacts?: readonly string[];
  catalogs: readonly DesktopCatalog[];
  now?: number;
}): { agents: AgentRegistryEntry[]; contacts: string[] } {
  const hidden = unavailableAgentPubkeys(agents, catalogs, now);
  return {
    agents: agents.filter((agent) => !hidden.has(agent.pubkey)),
    contacts: contacts.filter((pk) => !hidden.has(pk.toLowerCase())),
  };
}
