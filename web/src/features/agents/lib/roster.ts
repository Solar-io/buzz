import type { AgentRegistryEntry } from "./agentRegistry";
import type { PersonaDefinition } from "./personas";
import type { DesktopCatalog } from "./desktopCatalog";
import { duplicatePubkeys } from "./staleAgents.ts";

/**
 * Roster projection: the kind-30177 registry enriched with everything the
 * agents screen needs per row — the effective definition quad (persona
 * 30175 when definition-linked, since slimmed 30177s omit it), the machines
 * whose kind-30180 catalogs claim the agent, and duplicate-name flagging
 * (shared with the stale-cleanup detector). Pure, so the sidebar and the
 * config panel agree by construction.
 */

/** One roster row — everything the sidebar row and config panel render. */
export interface RosterRow {
  pubkey: string;
  entry: AgentRegistryEntry;
  persona: PersonaDefinition | null;
  /** Effective quad: persona values when linked, else the 30177's own. */
  name: string;
  systemPrompt: string;
  model: string;
  provider: string;
  personaLinked: boolean;
  /** Machines whose 30180 catalog claims this pubkey, sorted. */
  machines: string[];
  /** True for the non-newest member of a same-name group. */
  duplicate: boolean;
}

/**
 * Build the roster. Row order: effective name (the registry hook already
 * sorts by registered name; the effective name can differ for linked
 * entries, so sort here for a stable, readable list).
 */
export function buildRoster(
  registry: readonly AgentRegistryEntry[],
  personas: ReadonlyMap<string, PersonaDefinition>,
  catalogs: readonly DesktopCatalog[],
): RosterRow[] {
  const duplicates = duplicatePubkeys([...registry]);
  return registry
    .map((entry) => {
      const persona =
        entry.personaId !== null
          ? (personas.get(entry.personaId) ?? null)
          : null;
      const linked = entry.personaId !== null;
      return {
        pubkey: entry.pubkey,
        entry,
        persona,
        name: linked && persona ? persona.name : entry.name,
        systemPrompt: linked
          ? (persona?.systemPrompt ?? "")
          : entry.systemPrompt,
        model: linked ? (persona?.model ?? "") : entry.model,
        provider: linked ? (persona?.provider ?? "") : entry.provider,
        personaLinked: linked,
        machines: catalogs
          .filter((catalog) => catalog.agents.includes(entry.pubkey))
          .map((catalog) => catalog.machine)
          .sort((a, b) => a.localeCompare(b)),
        duplicate: duplicates.has(entry.pubkey),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Machine targeting for one agent's lifecycle/update commands: exactly one
 * claiming machine → a silent `{target}` (only that desktop applies + acks);
 * zero or several → `{}` = broadcast (unknown owner state, every desktop
 * sees it). An agent lives on one machine, so targeting removes the spurious
 * "record not found" error-ack a second desktop would otherwise emit.
 */
export function targetForAgent(machines: readonly string[]): {
  target?: string;
} {
  return machines.length === 1 ? { target: machines[0] } : {};
}
