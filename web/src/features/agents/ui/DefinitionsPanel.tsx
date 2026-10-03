import { useState } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import { Button } from "@/shared/ui/button";
import type { RelaySession } from "@/shared/api/relay-session";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { isSharedEvent, webManageable } from "../lib/definitionManage";
import type { DesktopCatalog } from "../lib/desktopCatalog";
import { agentsSharingDefinition } from "../lib/personaEdit";
import type { PersonaDefinition } from "../lib/personas";
import type { RosterRow } from "../lib/roster";
import type { TeamView } from "../lib/teamEvents";
import type { useAdminCommands } from "./AgentAdminPanel";
import { DefinitionActions } from "./DefinitionActions";
import { DefinitionCreateForm } from "./DefinitionCreateForm";
import { DefinitionDuplicate } from "./DefinitionDuplicate";
import { DefinitionEditor, definitionBase } from "./DefinitionEditorSection";
import { ImportSnapshotButton } from "./ImportSnapshotButton";

/**
 * The owner's kind-30175 definitions — list, create, edit, share, delete,
 * export. Built-ins are never published so never listed; team-installed
 * (non-UUID) definitions render read-only with the desktop reason.
 * Desktop-originated deletes are not observed live (no kind-5
 * subscription), so those rows linger until a reload.
 */
export function DefinitionsPanel({
  personas,
  forget,
  teams,
  roster,
  session,
  catalogs,
  admin,
  registryModels,
}: {
  personas: ReadonlyMap<string, PersonaDefinition>;
  forget: (id: string, tombstoneCreatedAt: number) => void;
  teams: ReadonlyMap<string, TeamView>;
  roster: readonly RosterRow[];
  session: RelaySession;
  catalogs: DesktopCatalog[];
  admin: ReturnType<typeof useAdminCommands>;
  registryModels: string[];
}) {
  const [view, setView] = useState<
    { kind: "list" } | { kind: "create" } | { kind: "detail"; id: string }
  >({ kind: "list" });

  if (view.kind === "create") {
    return (
      <DefinitionCreateForm
        session={session}
        catalogs={catalogs}
        registryModels={registryModels}
        onCreated={(id) => setView({ kind: "detail", id })}
        onCancel={() => setView({ kind: "list" })}
      />
    );
  }

  if (view.kind === "detail") {
    const persona = personas.get(view.id);
    return (
      <div className="space-y-4">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setView({ kind: "list" })}
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
          All definitions
        </Button>
        {persona ? (
          <DefinitionDetail
            key={persona.id}
            persona={persona}
            forget={forget}
            teams={teams}
            roster={roster}
            session={session}
            catalogs={catalogs}
            admin={admin}
            registryModels={registryModels}
            onDeleted={() => setView({ kind: "list" })}
            onDuplicated={(id) => setView({ kind: "detail", id })}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Waiting for the relay to return this definition…
          </p>
        )}
      </div>
    );
  }

  const list = [...personas.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return (
    <div className="space-y-3" data-testid="web-definitions-list">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setView({ kind: "create" })}>
          <Plus aria-hidden className="mr-1 h-4 w-4" />
          New definition
        </Button>
        <ImportSnapshotButton />
      </div>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No definitions yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {list.map((persona) => {
            const used = agentsSharingDefinition(roster, persona.id).length;
            const quad = [persona.model, persona.provider]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={persona.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
                  onClick={() => setView({ kind: "detail", id: persona.id })}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {persona.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {quad || "Default model"}
                      {used > 0
                        ? ` · Used by ${used} agent${used === 1 ? "" : "s"}`
                        : ""}
                    </span>
                  </span>
                  {isSharedEvent(persona.event) && (
                    <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      Shared
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DefinitionDetail({
  persona,
  forget,
  teams,
  roster,
  session,
  catalogs,
  admin,
  registryModels,
  onDeleted,
  onDuplicated,
}: {
  persona: PersonaDefinition;
  forget: (id: string, tombstoneCreatedAt: number) => void;
  teams: ReadonlyMap<string, TeamView>;
  roster: readonly RosterRow[];
  session: RelaySession;
  catalogs: DesktopCatalog[];
  admin: ReturnType<typeof useAdminCommands>;
  registryModels: string[];
  onDeleted: () => void;
  onDuplicated: (id: string) => void;
}) {
  const [published, setPublished] = useState<SignedNostrEvent | null>(null);
  const manageable = webManageable(persona.id);
  if (!manageable.ok) {
    return (
      <div className="space-y-2">
        <h3 className="font-medium">{persona.name}</h3>
        <p className="rounded-md bg-accent/40 px-2 py-1 text-xs text-muted-foreground">
          {manageable.reason}
        </p>
      </div>
    );
  }
  const base = definitionBase(persona, published);
  return (
    <div className="space-y-6">
      <DefinitionEditor
        persona={persona}
        sharingRows={agentsSharingDefinition(roster, persona.id)}
        base={base}
        onPublished={setPublished}
        session={session}
        catalogs={catalogs}
        admin={admin}
        registryModels={registryModels}
      />
      <DefinitionActions
        persona={persona}
        base={base}
        onPublished={setPublished}
        roster={roster}
        teams={teams}
        session={session}
        onDeleted={(tombstoneCreatedAt) => {
          forget(persona.id, tombstoneCreatedAt);
          onDeleted();
        }}
      />
      <DefinitionDuplicate
        base={base}
        session={session}
        onDuplicated={onDuplicated}
      />
    </div>
  );
}
