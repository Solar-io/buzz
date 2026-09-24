import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import type { RelaySession } from "@/shared/api/relay-session";
import { ownPubkey, type SignedNostrEvent } from "@/shared/lib/nostr-signer";
import type { PersonaDefinition } from "../lib/personas";
import {
  buildTeamCreate,
  buildTeamUpdate,
  mergeMemberSelection,
} from "../lib/teamEdit";
import type { TeamView } from "../lib/teamEvents";
import { publishSigned } from "./publishSigned";

/**
 * Create or edit a kind-30176 team. Member toggles cover only the owner's
 * visible definitions; ids the web can't resolve (built-ins, team-local
 * ids) are preserved untouched. A membership-unknown team never gets member
 * editing — turning an unknown list into an explicit one is the Sietch
 * Tabr wipe. Every save goes from the newest base so rapid saves stay
 * monotonic.
 */
export function TeamEditor({
  team,
  personas,
  session,
  onDone,
}: {
  /** Absent = create. */
  team?: TeamView;
  personas: ReadonlyMap<string, PersonaDefinition>;
  session: RelaySession;
  onDone: (id: string) => void;
}) {
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [instructions, setInstructions] = useState(team?.instructions ?? "");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(team?.personaIds ?? []),
  );
  const [membersTouched, setMembersTouched] = useState(false);
  const [published, setPublished] = useState<SignedNostrEvent | null>(null);
  const [busy, setBusy] = useState(false);

  const definitions = [...personas.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const resolvedIds = new Set(definitions.map((p) => p.id));
  const unresolved = (team?.personaIds ?? []).filter(
    (id) => !resolvedIds.has(id),
  );
  const membersLocked = team?.membershipUnknown === true;

  const toggle = (id: string) => {
    setMembersTouched(true);
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const save = async () => {
    if (busy) {
      return;
    }
    const nowSecs = Math.floor(Date.now() / 1000);
    let built: ReturnType<typeof buildTeamCreate>;
    let id: string;
    if (team) {
      const base =
        published && published.created_at >= team.event.created_at
          ? published
          : team.event;
      if ((await ownPubkey()) !== base.pubkey) {
        toast.error("Only the team's owner can edit it.");
        return;
      }
      id = team.id;
      built = buildTeamUpdate(
        base,
        {
          name,
          description,
          instructions,
          personaIds:
            membersLocked || !membersTouched
              ? null
              : mergeMemberSelection(team.personaIds, resolvedIds, selected),
        },
        nowSecs,
      );
    } else {
      id = crypto.randomUUID();
      built = buildTeamCreate(
        { name, description, instructions, personaIds: [...selected] },
        id,
        nowSecs,
      );
    }
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    setBusy(true);
    const result = await publishSigned(
      session,
      built.template,
      "The relay rejected the team.",
    );
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setPublished(result.signed);
    if (team) {
      // Stay open: the local base keeps a quick second save monotonic.
      toast.success("Team saved");
    } else {
      toast.success(`Created ${name.trim()}`);
      onDone(id);
    }
  };

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      data-testid="web-team-editor"
    >
      <div className="block space-y-1">
        <span className="block text-sm text-muted-foreground">Team name</span>
        <Input
          aria-label="Team name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="block space-y-1">
        <span className="block text-sm text-muted-foreground">Description</span>
        <Input
          aria-label="Team description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">Team instructions</span>
        <textarea
          aria-label="Team instructions"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          rows={4}
          className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-sm"
        />
      </label>
      <fieldset className="space-y-1">
        <legend className="text-sm text-muted-foreground">Members</legend>
        {membersLocked ? (
          <p className="text-xs text-muted-foreground">
            Membership unknown — published by an older app version, so members
            can't be edited here. Edit them in the desktop app.
          </p>
        ) : definitions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No definitions to add yet.
          </p>
        ) : (
          definitions.map((persona) => (
            <label key={persona.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.has(persona.id)}
                onChange={() => toggle(persona.id)}
              />
              {persona.name}
            </label>
          ))
        )}
        {!membersLocked && unresolved.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {unresolved.length} member{unresolved.length === 1 ? "" : "s"} not
            visible on web (kept)
          </p>
        )}
      </fieldset>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : team ? "Save team" : "Create team"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onDone(team?.id ?? "")}
        >
          {team ? "Close" : "Cancel"}
        </Button>
      </div>
    </section>
  );
}
