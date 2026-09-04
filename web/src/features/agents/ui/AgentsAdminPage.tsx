import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, BookOpen, Plus, Users } from "lucide-react";
import { Link } from "@tanstack/react-router";
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
import { useAdminCommands, PendingCommandsStrip } from "./AgentAdminPanel";
import { AgentRosterSidebar, AgentWorkingDot } from "./AgentRosterSidebar";
import { AgentConfigPanel } from "./AgentConfigPanel";
import { AgentCreateForm } from "./AgentCreateForm";
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
  | { kind: "teams" };

export function AgentsAdminPage() {
  const { canSign } = useAuth();
  const registry = useAgentRegistry();
  const catalogs = useDesktopCatalogs();
  const personas = usePersonas();
  const teams = useTeams();
  const { session, status } = useRelaySession();
  const admin = useAdminCommands(session, status);
  const [mode, setMode] = useState<Mode>({ kind: "roster" });

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
    () =>
      Array.from(
        new Set(registry.map((entry) => entry.model).filter(Boolean)),
      ).sort(),
    [registry],
  );

  const selected: RosterRow | null =
    mode.kind === "agent"
      ? (roster.find((row) => row.pubkey === mode.pubkey) ?? null)
      : null;

  if (!canSign) {
    return <LoginPage />;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Agents</h1>
        {/* flex-wrap (the app's standard action-row pattern, e.g.
            RepoDetailPage/HuddleBar): the four buttons are ~446px side by
            side, which overflows a 375px viewport — wrapped rows keep the
            page from scrolling horizontally. */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMode({ kind: "catalog" })}
          >
            <BookOpen aria-hidden className="mr-1 h-4 w-4" />
            Catalog
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMode({ kind: "teams" })}
          >
            <Users aria-hidden className="mr-1 h-4 w-4" />
            Teams
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMode({ kind: "create" })}
          >
            <Plus aria-hidden className="mr-1 h-4 w-4" />
            New agent
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/repos/settings">Back to settings</Link>
          </Button>
        </div>
      </div>
      <PendingCommandsStrip pending={admin.pending} acks={admin.acks} />
      <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className={mode.kind === "roster" ? "" : "hidden lg:block"}>
          <AgentRosterSidebar
            roster={roster}
            sections={rosterSections}
            teamNamesByPersona={teamBadges}
            selectedPubkey={selected?.pubkey ?? null}
            onSelect={(pubkey) => setMode({ kind: "agent", pubkey })}
            onNewAgent={() => setMode({ kind: "create" })}
            registry={registry}
            catalogs={catalogs}
            admin={admin}
            session={session}
          />
        </div>
        <div
          className={
            mode.kind === "roster"
              ? "hidden lg:block"
              : "space-y-4 rounded-lg border border-border bg-card p-4"
          }
        >
          {mode.kind === "create" && (
            <PaneShell
              title="New agent"
              onBack={() => setMode({ kind: "roster" })}
            >
              <AgentCreateForm
                admin={admin}
                catalogs={catalogs}
                registryModels={registryModels}
                onCreated={(pubkey) => setMode({ kind: "agent", pubkey })}
                onCancel={() => setMode({ kind: "roster" })}
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
              onBack={() => setMode({ kind: "roster" })}
            >
              <PersonaCatalogPanel admin={admin} catalogs={catalogs} />
            </PaneShell>
          )}
          {mode.kind === "teams" && (
            <PaneShell
              title="Agent teams"
              onBack={() => setMode({ kind: "roster" })}
            >
              <TeamsPanel teams={teams} personas={personas} />
            </PaneShell>
          )}
        </div>
      </div>
    </div>
  );
}

/** Detail-pane wrapper: title row plus the below-lg back affordance. */
function PaneShell({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
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
        <h2 className="min-w-0 flex-1 truncate font-medium">{title}</h2>
      </div>
      {children}
    </div>
  );
}

export { AgentWorkingDot };
