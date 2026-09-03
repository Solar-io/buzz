import type { RosterRow } from "./roster.ts";
import type { PersonaDefinition } from "./personas.ts";
import type { TeamView } from "./teamEvents.ts";

/**
 * Roster grouping — the web view-layer mirror of the desktop's
 * `unifiedAgentGroups.ts` `buildUnifiedGroups`: managed agents grouped under
 * their personas, plus the `ungrouped` (custom, definition-less) and
 * `unknown` (persona-linked but the definition is missing) buckets. This is
 * a VIEW over `buildRoster` rows — `buildRoster` itself is untouched
 * (Phase-1 QA'd surface; grouping never mutates row content).
 *
 * Differences from the desktop, both deliberate:
 * - The desktop drops archived identities from the standalone buckets via a
 *   relay archive snapshot the web does not hold; the web roster has no
 *   archive concept, so no row is dropped here.
 * - Groups sort by persona name for a stable list (the desktop renders in
 *   its local personas-store order, which the web does not have).
 *
 * Team badges: `teamNamesByPersonaId` maps each persona id to the names of
 * the teams that list it. A team with `membershipUnknown` contributes NO
 * badges — its membership is unknown, and a badge would assert a fact the
 * event did not carry.
 */

export interface RosterGroupSection {
  /** `persona:<id>`, `ungrouped`, or `unknown`. */
  key: string;
  /** Section heading the sidebar renders. */
  title: string;
  persona: PersonaDefinition | null;
  rows: RosterRow[];
}

/**
 * Group roster rows into persona sections, then the ungrouped and unknown
 * buckets, mirroring buildUnifiedGroups semantics.
 */
export function buildRosterGroups(
  roster: readonly RosterRow[],
  personas: ReadonlyMap<string, PersonaDefinition>,
): RosterGroupSection[] {
  const rowsByPersonaId = new Map<string, RosterRow[]>();
  const ungrouped: RosterRow[] = [];
  const unknown: RosterRow[] = [];

  for (const row of roster) {
    if (row.entry.personaId === null) {
      ungrouped.push(row);
      continue;
    }
    const persona = personas.get(row.entry.personaId);
    if (!persona) {
      // Linked, but no 30175 definition arrived (or it was deleted): the
      // desktop's unknown bucket — never silently folded into ungrouped.
      unknown.push(row);
      continue;
    }
    const list = rowsByPersonaId.get(persona.id) ?? [];
    list.push(row);
    rowsByPersonaId.set(persona.id, list);
  }

  const sections: RosterGroupSection[] = [];
  const personaSections = [...personas.values()]
    .map((persona) => ({
      persona,
      rows: rowsByPersonaId.get(persona.id) ?? [],
    }))
    .sort((left, right) => left.persona.name.localeCompare(right.persona.name));
  for (const { persona, rows } of personaSections) {
    sections.push({
      key: `persona:${persona.id}`,
      title: persona.name,
      persona,
      rows,
    });
  }
  // Bucket order mirrors the desktop library: unknown ("Unknown agents")
  // before ungrouped ("Custom agents").
  sections.push({
    key: "unknown",
    title: "Unknown agents",
    persona: null,
    rows: unknown,
  });
  sections.push({
    key: "ungrouped",
    title: "Custom agents",
    persona: null,
    rows: ungrouped,
  });
  return sections;
}

/**
 * Persona id → team names listing that persona, for roster row badges.
 * Unknown-membership teams contribute nothing (see file doc comment).
 */
export function teamNamesByPersonaId(
  personaIds: Iterable<string>,
  teams: ReadonlyMap<string, TeamView>,
): Map<string, string[]> {
  const byPersona = new Map<string, string[]>();
  for (const id of personaIds) {
    byPersona.set(id, []);
  }
  for (const team of teams.values()) {
    if (team.membershipUnknown) {
      continue;
    }
    for (const personaId of team.personaIds) {
      const names = byPersona.get(personaId);
      if (names) {
        names.push(team.name);
      }
    }
  }
  return byPersona;
}
