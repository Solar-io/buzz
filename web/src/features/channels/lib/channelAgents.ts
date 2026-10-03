import type { AgentRegistryEntry } from "../../agents/lib/agentRegistry";
import type { DesktopCatalog } from "../../agents/lib/desktopCatalog";
import {
  authoritativeCatalogs,
  selectAvailableCandidates,
} from "../../agents/lib/availableAgents.ts";
import { findStaleAgents } from "../../agents/lib/staleAgents.ts";
import { agentDesktopReady } from "../../agents/settings/agent-screen/agentScreenModel.ts";
import { addAgentChannel } from "../../agents/settings/agent-screen/agentChannelActions.ts";

/** Registry identities and bot roles both identify agents, including retired keys. */
export function partitionChannelMembers<
  T extends { pubkey: string; role?: string },
>(
  members: readonly T[],
  registry: readonly AgentRegistryEntry[],
  known: ReadonlySet<string> = new Set(),
) {
  const keys = new Set([...known, ...registry.map((entry) => entry.pubkey)]);
  const isAgent = (member: T) =>
    member.role === "bot" || keys.has(member.pubkey);
  return {
    agents: members.filter(isAgent),
    people: members.filter((m) => !isAgent(m)),
  };
}

/** Apply the shared availability safety rules before excluding current members. */
export function channelAgentCandidates(
  registry: readonly AgentRegistryEntry[],
  members: readonly { pubkey: string }[],
  catalogs: readonly DesktopCatalog[],
  now?: number,
) {
  const present = new Set(members.map((member) => member.pubkey));
  return selectAvailableCandidates({
    agents: registry,
    catalogs,
    now,
  }).agents.filter((agent) => !present.has(agent.pubkey));
}

/** No destructive cleanup from missing, stale, empty or partial desktop claims. */
export function unregisteredChannelAgents(
  members: readonly { pubkey: string }[],
  registry: readonly AgentRegistryEntry[],
  catalogs: readonly DesktopCatalog[],
  now?: number,
) {
  const authoritative = authoritativeCatalogs(catalogs, now);
  if (!authoritative) return [];
  const entries = members.map(
    ({ pubkey }) =>
      registry.find((entry) => entry.pubkey === pubkey) ??
      ({
        pubkey,
        name: pubkey,
        updatedAt: 0,
      } as AgentRegistryEntry),
  );
  const claimed = new Set(authoritative.flatMap((catalog) => catalog.agents));
  return findStaleAgents(entries, authoritative).filter(
    (entry) => !claimed.has(entry.pubkey),
  );
}

/** An unambiguous recently reporting desktop is required; never broadcast a write. */
export function channelAgentTarget(
  pubkey: string,
  catalogs: readonly DesktopCatalog[],
  now = Math.floor(Date.now() / 1000),
): string | null {
  const machines = catalogs
    .filter((catalog) => catalog.agents.includes(pubkey))
    .map((catalog) => catalog.machine);
  return agentDesktopReady(catalogs, machines, now) ? machines[0] : null;
}

/** The shared accepted-add-then-start path also preserves membership on start failure. */
export const startAfterAttach = addAgentChannel;

/** Lifecycle batches wait for each apply verdict and never exceed three in flight. */
export async function runChannelAgentBatch<T>(
  entries: readonly T[],
  apply: (entry: T) => Promise<void>,
): Promise<{ entry: T; error: string | null }[]> {
  const results: { entry: T; error: string | null }[] = new Array(
    entries.length,
  );
  let cursor = 0;
  async function worker() {
    while (cursor < entries.length) {
      const index = cursor++;
      const entry = entries[index];
      try {
        await apply(entry);
        results[index] = { entry, error: null };
      } catch (issue) {
        results[index] = {
          entry,
          error: issue instanceof Error ? issue.message : String(issue),
        };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(3, entries.length) }, worker),
  );
  return results;
}
