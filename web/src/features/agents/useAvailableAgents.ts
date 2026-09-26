import { useMemo } from "react";
import type { AgentRegistryEntry } from "@/features/agents/lib/agentRegistry";
import { selectAvailableCandidates } from "@/features/agents/lib/availableAgents";
import { useAgentRegistry } from "@/features/agents/useAgentRegistry";
import { useDesktopCatalogs } from "@/features/agents/useDesktopCatalogs";

const NO_CONTACTS: readonly string[] = [];

/**
 * Picker source of truth: registry agents and contacts with deleted /
 * unavailable agents removed (see lib/availableAgents.ts for the rules).
 * Every agent picker uses this so they cannot disagree.
 */
export function useAvailableAgents(contacts: readonly string[] = NO_CONTACTS): {
  agents: AgentRegistryEntry[];
  contacts: string[];
} {
  const registry = useAgentRegistry();
  const catalogs = useDesktopCatalogs();
  const registryKey = registry
    .map((entry) => `${entry.pubkey}:${entry.name}:${entry.updatedAt}`)
    .join(",");
  const catalogKey = catalogs
    .map((c) => `${c.machine}:${c.updatedAt}:${c.version}`)
    .join(",");
  const contactsKey = contacts.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on content — useAgentRegistry/useDesktopCatalogs return fresh arrays every render
  return useMemo(
    () => selectAvailableCandidates({ agents: registry, contacts, catalogs }),
    [registryKey, catalogKey, contactsKey],
  );
}
