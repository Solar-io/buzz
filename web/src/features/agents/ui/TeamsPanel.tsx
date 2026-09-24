import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import type { RelaySession } from "@/shared/api/relay-session";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import { buildCoordinateDelete } from "../lib/definitionManage.ts";
import type { PersonaDefinition } from "../lib/personas.ts";
import type { RosterRow } from "../lib/roster.ts";
import { teamDeleteBlockers } from "../lib/teamEdit.ts";
import type { TeamView } from "../lib/teamEvents.ts";
import { publishSigned } from "./publishSigned.ts";
import { TeamEditor } from "./TeamEditor.tsx";

/**
 * The owner's kind-30176 teams, with create / edit / delete. Teams sync to
 * the owner's desktops through 30176 (desktop's inbound team sync), exactly
 * like a team created on another of their machines; deploy and team
 * snapshots stay desktop-only. Delete publishes the desktop-identical a-tag
 * tombstone and is refused for built-in / directory-backed (non-UUID) teams,
 * membership-unknown teams, and teams whose members still back agents.
 *
 * Team instructions render as literal text in a <pre> (desktop AGENTS.md
 * rule 12: instructions are executable-adjacent shared text — never the chat
 * Markdown projection, which can conceal content).
 */
export function TeamsPanel({
  teams,
  personas,
  roster,
  session,
  forget,
}: {
  teams: ReadonlyMap<string, TeamView>;
  personas: ReadonlyMap<string, PersonaDefinition>;
  roster: readonly RosterRow[];
  session: RelaySession;
  forget: (id: string, tombstoneCreatedAt: number) => void;
}) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const list = [...teams.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  const remove = async (team: TeamView) => {
    const me = await ownPubkey();
    if (me !== team.event.pubkey) {
      toast.error("Only the team's owner can delete it.");
      return;
    }
    const built = buildCoordinateDelete(
      30176,
      me,
      team.id,
      team.event.created_at,
      Math.floor(Date.now() / 1000),
    );
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    const result = await publishSigned(
      session,
      built.template,
      "The relay rejected the deletion.",
    );
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    forget(team.id, built.template.created_at);
    toast.success(`Deleted ${team.name}`);
  };

  return (
    <div
      className="space-y-3"
      data-testid={list.length === 0 ? "web-teams-empty" : "web-teams-list"}
    >
      {editing === "new" ? (
        <TeamEditor
          personas={personas}
          session={session}
          onDone={() => setEditing(null)}
        />
      ) : (
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus aria-hidden className="mr-1 h-4 w-4" />
          New team
        </Button>
      )}
      {list.length === 0 && editing !== "new" ? (
        <p className="text-sm text-muted-foreground">
          No teams yet. Teams group agents you can add to a channel together.
        </p>
      ) : null}
      {list.map((team) =>
        editing === team.id ? (
          <TeamEditor
            key={team.id}
            team={team}
            personas={personas}
            session={session}
            onDone={() => setEditing(null)}
          />
        ) : (
          <TeamCard
            key={team.id}
            team={team}
            personas={personas}
            blocker={teamDeleteBlockers(team, roster)}
            onEdit={() => setEditing(team.id)}
            onDelete={() => remove(team)}
          />
        ),
      )}
      <p className="text-xs text-muted-foreground">
        Teams sync to your desktop app. Deploying a team and team snapshots stay
        in the desktop app.
      </p>
    </div>
  );
}

function TeamCard({
  team,
  personas,
  blocker,
  onEdit,
  onDelete,
}: {
  team: TeamView;
  personas: ReadonlyMap<string, PersonaDefinition>;
  blocker: string | null;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
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
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onEdit}>
          Edit
        </Button>
        {confirming ? (
          <>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onDelete().finally(() => {
                  setBusy(false);
                  setConfirming(false);
                });
              }}
            >
              Confirm delete
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={blocker !== null}
            onClick={() => setConfirming(true)}
          >
            Delete
          </Button>
        )}
      </div>
      {blocker ? (
        <p className="text-xs text-muted-foreground">{blocker}</p>
      ) : null}

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
