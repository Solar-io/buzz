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
import { buildRoster } from "../lib/roster";
import { buildRosterGroups, teamNamesByPersonaId } from "../lib/rosterGroups";
import { observedModels } from "../lib/modelSuggestions";
import { useAdminCommands, PendingCommandsStrip } from "../ui/useAdminCommands";
import { AgentRosterList, AgentWorkingDot } from "../ui/AgentRosterList";
import { CreateAgentScreen } from "./CreateAgentScreen";
import { NewAgentMenu } from "./NewAgentMenu";
import { LibraryTabs, type LibraryTab } from "./LibraryTabs";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/shared/ui/dialog";
import { DefinitionsPanel } from "../ui/DefinitionsPanel";
import { ImportSnapshotButton } from "../ui/ImportSnapshotButton";
import { PersonaCatalogPanel } from "../ui/PersonaCatalogPanel";
import { TeamsPanel } from "../ui/TeamsPanel";
import { useDesktopPresence } from "../useDesktopPresence";
import { adminCommandLock } from "../lib/adminCommandLock";
import { DesktopConnectionFooter } from "../ui/DesktopConnectionFooter";
import { DesktopControlBoundary } from "../ui/DesktopControlBoundary";

/** Settings entry points for the existing roster, create flow and Library. */

type Mode =
  | { kind: "roster" }
  | { kind: "create" }
  | { kind: "catalog" }
  | { kind: "definitions" }
  | { kind: "teams" }
  | { kind: "snapshots" };

export function AgentManagementSection({
  embedded = false,
  section = "agents",
  tab,
  definition,
}: {
  embedded?: boolean;
  section?: "agents" | "library";
  tab?: string;
  definition?: string;
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
  const rosterSections = useMemo(
    () => buildRosterGroups(roster, personas),
    [roster, personas],
  );
  const teamBadges = useMemo(
    () => teamNamesByPersonaId(personas.keys(), teams),
    [personas, teams],
  );
  const registryModels = useMemo(
    () => observedModels(registry, personas),
    [registry, personas],
  );

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
      <div className={section === "library" ? "space-y-4" : "space-y-4"}>
        <div
          className={
            section === "library"
              ? "hidden"
              : mode.kind === "roster"
                ? ""
                : "hidden"
          }
        >
          <AgentRosterList
            controlLock={presence.lock(
              catalogs.map((catalog) => catalog.machine),
            )}
            roster={roster}
            sections={rosterSections}
            teamNamesByPersona={teamBadges}
            selectedPubkey={null}
            onSelect={(pubkey) => {
              void navigate({
                to: "/repos/settings",
                search: { group: "agents", agent: pubkey },
              });
            }}
            registry={registry}
            catalogs={catalogs}
            admin={admin}
            session={session}
          />
          {!embedded ? (
            <DesktopConnectionFooter
              catalogs={catalogs}
              presence={presence.byMachine}
            />
          ) : null}
        </div>
        <DetailPane
          library={section === "library"}
          tab={mode.kind}
          className={
            mode.kind === "roster"
              ? "hidden"
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
                    else
                      void navigate({
                        to: "/repos/settings",
                        search: { group: "agents", agent: pubkey },
                      });
                  }}
                  onCancel={() => selectMode({ kind: "roster" })}
                  onDraftChange={onCreateDraft}
                />
              </DesktopControlBoundary>
            </PaneShell>
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
                definition={definition}
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
            className="lg:hidden"
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
