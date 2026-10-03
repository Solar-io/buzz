import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/shared/ui/button";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { LoginPage } from "@/features/auth/ui/LoginPage";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { useAgentRegistry } from "@/features/agents/useAgentRegistry";
import { useDesktopCatalogs } from "@/features/agents/useDesktopCatalogs";
import { usePersonas } from "@/features/agents/usePersonas";
import { useTeams } from "@/features/agents/useTeams";
import { useProfiles } from "@/features/channels/hooks";
import { buildRoster, type RosterRow } from "../lib/roster";
import { teamNamesByPersonaId } from "../lib/rosterGroups";
import { observedModels } from "../lib/modelSuggestions";
import { useAdminCommands, PendingCommandsStrip } from "./AgentAdminPanel";
import { AgentWorkingDot } from "./AgentRosterSidebar";
import { RosterTable } from "../settings/roster/RosterTable";
import { AgentConfigPanel } from "./AgentConfigPanel";
import { CreateAgentScreen } from "../settings/CreateAgentScreen";
import { NewAgentMenu } from "../settings/NewAgentMenu";
import { LibraryTabs, type LibraryTab } from "../settings/LibraryTabs";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/shared/ui/dialog";
import { DefinitionsPanel } from "./DefinitionsPanel";
import { ImportSnapshotButton } from "./ImportSnapshotButton";
import { PersonaCatalogPanel } from "./PersonaCatalogPanel";
import { TeamsPanel } from "./TeamsPanel";
import { useDesktopPresence } from "../useDesktopPresence";
import { adminCommandLock } from "../lib/adminCommandLock";
import { DesktopConnectionFooter } from "./DesktopConnectionFooter";
import { DesktopControlBoundary } from "./DesktopControlBoundary";

/** Responsive agent roster and owner-controlled create/config/library panels.
 * Mutations use the existing desktop command channel and presence locks.
 */

type Mode =
  | { kind: "roster" }
  | { kind: "create" }
  | { kind: "agent"; pubkey: string }
  | { kind: "catalog" }
  | { kind: "definitions" }
  | { kind: "teams" }
  | { kind: "snapshots" };

export function AgentsAdminPage({
  embedded = false,
  section = "agents",
  tab,
}: {
  embedded?: boolean;
  section?: "agents" | "library";
  tab?: string;
}) {
  const { canSign } = useAuth();
  const navigate = useNavigate();
  const registry = useAgentRegistry();
  const catalogs = useDesktopCatalogs();
  const personasState = usePersonas();
  const personas = personasState.map;
  const teamsState = useTeams();
  const teams = teamsState.map;
  const { session, status } = useRelaySession();
  const presence = useDesktopPresence(catalogs);
  const admin = useAdminCommands(
    session,
    status,
    (command, options) =>
      adminCommandLock(command, options, catalogs, presence.byMachine).reason,
  );
  const [mode, setMode] = useState<Mode>(
    section === "library"
      ? {
          kind:
            tab === "teams"
              ? "teams"
              : tab === "catalog"
                ? "catalog"
                : tab === "snapshots"
                  ? "snapshots"
                  : "definitions",
        }
      : { kind: "roster" },
  );
  const [createDraft, setCreateDraft] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [leaving, setLeaving] = useState<Mode | null>(null);
  const selectMode = (next: Mode) => {
    if (mode.kind === "create" && (createDraft || createBusy)) setLeaving(next);
    else setMode(next);
  };
  const onCreateDraft = useMemo(
    () => (dirty: boolean, busy: boolean) => {
      setCreateDraft(dirty);
      setCreateBusy(busy);
    },
    [],
  );

  const roster = useMemo(
    () => buildRoster(registry, personas, catalogs),
    [registry, personas, catalogs],
  );
  const teamBadges = useMemo(
    () => teamNamesByPersonaId(personas.keys(), teams),
    [personas, teams],
  );
  const rosterPubkeys = useMemo(
    () => roster.map((row) => row.pubkey),
    [roster],
  );
  /**
   * Agents the viewer owns. `useAgentRegistry` subscribes with
   * `authors: [ownPubkey]`, so every kind-30177 in `registry` was signed by
   * the viewer — membership here means "the viewer published this agent's
   * managed-agent record", the web's counterpart to the desktop's local
   * `managed_agents` store.
   *
   * Used only to decide whether to render the read-only memory section. It is
   * a UX gate, not a security boundary: engrams are NIP-44 encrypted to the
   * owner and the relay refuses an engram REQ whose `#p` is not the
   * authenticated reader, so a non-owner learns nothing by defeating it.
   */
  const ownedAgentPubkeys = useMemo(
    () => new Set(registry.map((entry) => entry.pubkey)),
    [registry],
  );
  const profiles = useProfiles(rosterPubkeys);
  const registryModels = useMemo(
    () => observedModels(registry, personas),
    [registry, personas],
  );

  const selected: RosterRow | null =
    mode.kind === "agent"
      ? (roster.find((row) => row.pubkey === mode.pubkey) ?? null)
      : null;

  if (!canSign) {
    return <LoginPage />;
  }

  return (
    <div className={embedded ? "space-y-4" : "mx-auto max-w-5xl space-y-4 p-4"}>
      <div className="flex items-center justify-between gap-2">
        {!embedded ? <h1 className="text-lg font-semibold">Agents</h1> : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {section === "library" ? (
            <LibraryTabs
              value={mode.kind as LibraryTab}
              onChange={(next) => {
                setMode({ kind: next });
                void navigate({
                  to: "/repos/settings",
                  search: { group: "library", tab: next },
                });
              }}
            />
          ) : null}
          {section === "agents" ? (
            <NewAgentMenu
              catalogs={catalogs}
              onBlank={() => selectMode({ kind: "create" })}
            />
          ) : null}
          {!embedded ? (
            <Button asChild variant="ghost" size="sm">
              <Link to="/repos/settings">Back to settings</Link>
            </Button>
          ) : null}
        </div>
      </div>
      <PendingCommandsStrip pending={admin.pending} acks={admin.acks} />
      <div className="space-y-4">
        <DetailPane
          library={section === "library"}
          tab={mode.kind}
          className={
            mode.kind === "roster"
              ? ""
              : "space-y-4 rounded-lg border border-border bg-card p-4"
          }
        >
          {mode.kind === "create" && (
            <PaneShell
              title="New agent"
              onBack={() => selectMode({ kind: "roster" })}
            >
              <DesktopControlBoundary
                {...presence.lock(catalogs.map((catalog) => catalog.machine))}
              >
                <CreateAgentScreen
                  admin={admin}
                  catalogs={catalogs}
                  registryModels={registryModels}
                  onCreated={(pubkey) => {
                    setCreateDraft(false);
                    setCreateBusy(false);
                    if (embedded)
                      void navigate({
                        to: "/repos/settings",
                        search: { group: "agents", agent: pubkey },
                      });
                    else setMode({ kind: "agent", pubkey });
                  }}
                  onCancel={() => selectMode({ kind: "roster" })}
                  onDraftChange={onCreateDraft}
                />
              </DesktopControlBoundary>
            </PaneShell>
          )}
          {mode.kind === "agent" &&
            (selected ? (
              <PaneShell
                title={selected.name}
                onBack={() => setMode({ kind: "roster" })}
              >
                <DesktopControlBoundary {...presence.lock(selected.machines)}>
                  <AgentConfigPanel
                    key={selected.pubkey}
                    row={selected}
                    profile={profiles.get(selected.pubkey)}
                    admin={admin}
                    session={session}
                    catalogs={catalogs}
                    registryModels={registryModels}
                    roster={roster}
                    viewerIsOwner={ownedAgentPubkeys.has(selected.pubkey)}
                    onDeleted={() => setMode({ kind: "roster" })}
                  />
                </DesktopControlBoundary>
              </PaneShell>
            ) : (
              <p className="text-sm text-muted-foreground">
                This agent is no longer in the registry.
              </p>
            ))}
          {mode.kind === "roster" && (
            <RosterTable
              controlLock={presence.lock(
                catalogs.map((catalog) => catalog.machine),
              )}
              roster={roster}
              catalogs={catalogs}
              teamNames={teamBadges}
              profiles={profiles}
              admin={admin}
              session={session}
              onOpen={(pubkey) => {
                if (embedded)
                  void navigate({
                    to: "/repos/settings",
                    search: { group: "agents", agent: pubkey },
                  });
                else selectMode({ kind: "agent", pubkey });
              }}
            />
          )}
          {mode.kind === "catalog" && (
            <PaneShell
              title="Agent catalog"
              hideBack={section === "library"}
              onBack={() => setMode({ kind: "roster" })}
            >
              <DesktopControlBoundary
                {...presence.lock(catalogs.map((catalog) => catalog.machine))}
              >
                <PersonaCatalogPanel admin={admin} catalogs={catalogs} />
              </DesktopControlBoundary>
            </PaneShell>
          )}
          {mode.kind === "definitions" && (
            <PaneShell
              title="Agent definitions"
              hideBack={section === "library"}
              onBack={() => setMode({ kind: "roster" })}
            >
              <DefinitionsPanel
                personas={personas}
                forget={personasState.forget}
                teams={teams}
                roster={roster}
                session={session}
                catalogs={catalogs}
                admin={admin}
                registryModels={registryModels}
              />
            </PaneShell>
          )}
          {mode.kind === "teams" && (
            <PaneShell
              title="Agent teams"
              hideBack={section === "library"}
              onBack={() => setMode({ kind: "roster" })}
            >
              <TeamsPanel
                teams={teams}
                personas={personas}
                roster={roster}
                session={session}
                forget={teamsState.forget}
              />
            </PaneShell>
          )}
          {mode.kind === "snapshots" && (
            <PaneShell
              title="Agent snapshots"
              hideBack
              onBack={() => setMode({ kind: "roster" })}
            >
              <p className="text-sm text-muted-foreground">
                Import an agent snapshot to preview its instructions and
                settings before creating it. Export snapshots from an agent's
                settings.
              </p>
              <ImportSnapshotButton />
            </PaneShell>
          )}
        </DetailPane>
      </div>
      {!embedded ? (
        <DesktopConnectionFooter
          catalogs={catalogs}
          presence={presence.byMachine}
        />
      ) : null}
      <Dialog
        open={leaving !== null}
        onOpenChange={(open) => {
          if (!open) setLeaving(null);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {createBusy
              ? "Waiting for Buzz Desktop"
              : "Discard changes to the new agent?"}
          </DialogTitle>
          <DialogDescription>
            {createBusy
              ? "Wait for the desktop to answer before leaving."
              : "Your new agent has not been saved."}
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLeaving(null)}>
              Keep editing
            </Button>
            <Button
              disabled={createBusy}
              onClick={() => {
                if (leaving) setMode(leaving);
                setLeaving(null);
                setCreateDraft(false);
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Detail-pane wrapper: title row plus the below-lg back affordance. */
function DetailPane({
  library,
  tab,
  className,
  children,
}: {
  library: boolean;
  tab: string;
  className: string;
  children: ReactNode;
}) {
  return library ? (
    <section
      role="tabpanel"
      id="library-panel"
      aria-labelledby={`library-tab-${tab}`}
      className={className}
    >
      {children}
    </section>
  ) : (
    <div className={className}>{children}</div>
  );
}

function PaneShell({
  title,
  onBack,
  children,
  hideBack = false,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
  hideBack?: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {!hideBack ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-11"
            onClick={onBack}
            aria-label="Back to all agents"
          >
            <ArrowLeft aria-hidden className="h-4 w-4" />
            All agents
          </Button>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate font-medium">{title}</h2>
      </div>
      {children}
    </div>
  );
}

export { AgentWorkingDot };
