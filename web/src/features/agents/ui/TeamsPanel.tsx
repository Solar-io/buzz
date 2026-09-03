import type { PersonaDefinition } from "../lib/personas.ts";
import type { TeamView } from "../lib/teamEvents.ts";

/**
 * Read-only teams view (Phase 3 §2.3 B13) — the owner's kind-30176 teams,
 * rendered from relay events only. There are deliberately NO actions here:
 * team create/edit/delete/deploy/share/import are desktop-only surfaces with
 * no protocol behind them (Phase 3 §3.4); a read-only view that hinted at
 * controls it cannot run would violate the honest-controls rule.
 *
 * Team instructions render as literal text in a <pre> (desktop AGENTS.md
 * rule 12: instructions are executable-adjacent shared text — never the chat
 * Markdown projection, which can conceal content).
 */
export function TeamsPanel({
  teams,
  personas,
}: {
  teams: ReadonlyMap<string, TeamView>;
  personas: ReadonlyMap<string, PersonaDefinition>;
}) {
  const list = [...teams.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  if (list.length === 0) {
    return (
      <div className="space-y-3" data-testid="web-teams-empty">
        <p className="text-sm text-muted-foreground">
          No teams yet. Teams you create in the Buzz desktop app appear here.
        </p>
        <p className="text-xs text-muted-foreground">
          Teams group agents you can add to a channel together. This view is
          read-only.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="web-teams-list">
      {list.map((team) => (
        <TeamCard key={team.id} team={team} personas={personas} />
      ))}
      <p className="text-xs text-muted-foreground">
        Teams are created and deployed in the Buzz desktop app.
      </p>
    </div>
  );
}

function TeamCard({
  team,
  personas,
}: {
  team: TeamView;
  personas: ReadonlyMap<string, PersonaDefinition>;
}) {
  const resolved = team.personaIds
    .map((id) => personas.get(id))
    .filter((persona): persona is PersonaDefinition => persona !== undefined);
  const missing = team.personaIds.length - resolved.length;

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid={`web-team-card-${team.id}`}
    >
      <div className="min-w-0">
        <h3 className="truncate text-base font-medium">{team.name}</h3>
        {team.description ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {team.description}
          </p>
        ) : null}
      </div>

      {team.instructions ? (
        <div>
          <p className="text-sm font-medium">Team instructions</p>
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted/60 p-3 text-xs whitespace-pre-wrap break-words">
            {team.instructions}
          </pre>
        </div>
      ) : null}

      <div className="space-y-1.5">
        {team.membershipUnknown ? (
          <p className="text-xs text-muted-foreground">
            Membership unknown — published by an older app version, so the
            member list cannot be shown.
          </p>
        ) : (
          <>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Members ({resolved.length})
            </p>
            {resolved.length > 0 ? (
              <ul className="flex flex-wrap gap-1">
                {resolved.map((persona) => (
                  <li
                    key={persona.id}
                    className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {persona.name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No members.</p>
            )}
            {missing > 0 ? (
              // Unresolved members surface as a COUNT, not an error — the ids
              // exist in the team but no 30175 definition arrived for them.
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {missing} member{missing === 1 ? "" : "s"} not in your agent
                definitions.
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
