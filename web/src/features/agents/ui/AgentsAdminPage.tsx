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
import { buildRosterGroups, teamNamesByPersonaId } from "../lib/rosterGroups";
import { observedModels } from "../lib/modelSuggestions";
import { useAdminCommands, PendingCommandsStrip } from "./AgentAdminPanel";
import { AgentRosterSidebar, AgentWorkingDot } from "./AgentRosterSidebar";
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

/**
 * Agent admin for the web — the desktop's two-pane Agents view. The roster
 * (kind 30177) is the source of truth; every mutation rides the owner
 * admin-command channel (kind 24201, NIP-44 sealed) and is applied by the
 * owner's Buzz Desktop, acking on kind 24202. Machine targeting comes from
 * the kind-30180 desktop catalogs.
 *
 * Responsive rule (same mobile-sheet discipline as AgentActivityPanel):
 * `mode` always drives the detail pane; below lg only ONE pane renders at a
 * time — the roster when mode is "roster", the detail pane otherwise, with a
 * back button. At lg+ the sidebar stays visible and mode switches the right
 * pane. Selecting a different agent while editing discards the edit (the
 * config panel is keyed by pubkey; a dirty-form guard is a Phase-2 gap).
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
  const admin = useAdminCommands(session, status);
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
      <div
        className={
          section === "library"
            ? "space-y-4"
            : "grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]"
        }
      >
        <div
          className={
            section === "library"
              ? "hidden"
              : mode.kind === "roster"
                ? ""
                : "hidden lg:block"
          }
        >
          <AgentRosterSidebar
            roster={roster}
            sections={rosterSections}
            teamNamesByPersona={teamBadges}
            selectedPubkey={selected?.pubkey ?? null}
            onSelect={(pubkey) => {
              if (embedded)
                void navigate({
                  to: "/repos/settings",
                  search: { group: "agents", agent: pubkey },
                });
              else selectMode({ kind: "agent", pubkey });
            }}
            registry={registry}
            catalogs={catalogs}
            admin={admin}
            session={session}
          />
        </div>
        <DetailPane
          library={section === "library"}
          tab={mode.kind}
          className={
            mode.kind === "roster"
              ? "hidden lg:block"
              : "space-y-4 rounded-lg border border-border bg-card p-4"
          }
        >
          {mode.kind === "create" && (
            <PaneShell
              title="New agent"
              onBack={() => selectMode({ kind: "roster" })}
            >
              <CreateAgentScreen
                admin={admin}
                catalogs={catalogs}
                registryModels={registryModels}
                onCreated={(pubkey) => {
                  setCreateDraft(false);
                  setCreateBusy(false);
                  setMode({ kind: "agent", pubkey });
                }}
                onCancel={() => selectMode({ kind: "roster" })}
                onDraftChange={onCreateDraft}
              />
            </PaneShell>
          )}
          {mode.kind === "agent" &&
            (selected ? (
              <PaneShell
                title={selected.name}
                onBack={() => setMode({ kind: "roster" })}
              >
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
              </PaneShell>
            ) : (
              <p className="text-sm text-muted-foreground">
                This agent is no longer in the registry.
              </p>
            ))}
          {mode.kind === "roster" && (
            <div className="space-y-3">
              <h2 className="font-medium">Select an agent</h2>
              <p className="text-sm text-muted-foreground">
                Pick an agent from the list to configure it, or create a new
                one.
              </p>
            </div>
          )}
          {mode.kind === "catalog" && (
            <PaneShell
              title="Agent catalog"
              hideBack={section === "library"}
              onBack={() => setMode({ kind: "roster" })}
            >
              <PersonaCatalogPanel admin={admin} catalogs={catalogs} />
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
