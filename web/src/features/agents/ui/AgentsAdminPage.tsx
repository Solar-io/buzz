import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { Button } from "@/shared/ui/button";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { LoginPage } from "@/features/auth/ui/LoginPage";
import type { RelaySession } from "@/shared/api/relay-session";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import {
  useObserverStore,
  useAgentFrames,
} from "@/features/agents/ObserverProvider";
import { useAgentRegistry } from "@/features/agents/useAgentRegistry";
import { useDesktopCatalogs } from "@/features/agents/useDesktopCatalogs";
import { usePersonas } from "@/features/agents/usePersonas";
import { agentRecentlyActive } from "@/features/agents/lib/observerEvents";
import type { PersonaDefinition } from "@/features/agents/lib/personas";
import {
  duplicatePubkeys,
  findStaleAgents,
} from "@/features/agents/lib/staleAgents";
import {
  AgentAdminPanel,
  AgentRowActions,
  EditAgentForm,
  useAdminCommands,
} from "@/features/agents/ui/AgentAdminPanel";
import { useProfiles } from "@/features/channels/hooks";
import { AuthorAvatar } from "@/features/channels/ui/ChannelTimeline";
import {
  publishOwnProfile,
  sendAgentControl,
  type AgentControlCommand,
} from "../lib/agentControl";

function newRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

/**
 * Agent admin for the web — feature-parity with the desktop's Agents view.
 * The registry (kind 30177) is the source of truth; every mutation rides the
 * owner admin-command channel (kind 24201, NIP-44 sealed) and is applied by
 * the owner's Buzz Desktop through its own save paths, acking on kind 24202.
 * The live harness list and machine targeting come from each desktop's
 * kind-30180 catalog; stale registrations (old re-mints, retired desktops)
 * are detected from registry + catalogs and cleaned with delete commands.
 */
export function AgentsAdminPage() {
  const { canSign } = useAuth();
  const observerStore = useObserverStore();
  const registry = useAgentRegistry();
  const catalogs = useDesktopCatalogs();
  const personas = usePersonas();
  const { session, status } = useRelaySession();
  const admin = useAdminCommands(session, status);

  if (!canSign) {
    return <LoginPage />;
  }
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Agents</h1>
        <Button asChild variant="ghost" size="sm">
          <Link to="/repos/settings">Back to settings</Link>
        </Button>
      </div>
      <AgentAdminPanel admin={admin} catalogs={catalogs} />
      <AgentRegistryList
        registry={registry}
        admin={admin}
        catalogs={catalogs}
        personas={personas}
      />
      <StaleCleanupSection
        registry={registry}
        catalogs={catalogs}
        admin={admin}
      />
      <AgentCommands
        observerStore={observerStore}
        session={session}
        registry={registry}
      />
      <ProfileEditor session={session} />
    </div>
  );
}

function AgentWorkingDot({ pubkey }: { pubkey: string }) {
  const frames = useAgentFrames(pubkey);
  const active = agentRecentlyActive(frames, Math.floor(Date.now() / 1000));
  return (
    <span
      title={active ? "Working" : "Idle"}
      className={
        active
          ? "inline-block h-2 w-2 rounded-full bg-emerald-500"
          : "inline-block h-2 w-2 rounded-full bg-muted-foreground/40"
      }
    />
  );
}

function AgentRegistryList({
  registry,
  admin,
  catalogs,
  personas,
}: {
  registry: ReturnType<typeof useAgentRegistry>;
  admin: ReturnType<typeof useAdminCommands>;
  catalogs: ReturnType<typeof useDesktopCatalogs>;
  personas: Map<string, PersonaDefinition>;
}) {
  const pubkeys = useMemo(
    () => registry.map((entry) => entry.pubkey),
    [registry],
  );
  const profiles = useProfiles(pubkeys);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const duplicates = useMemo(() => duplicatePubkeys(registry), [registry]);

  if (registry.length === 0) {
    return (
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="font-medium">Your agents</h2>
        <p className="text-sm text-muted-foreground">
          No agent registrations on the relay yet — agents appear here once your
          desktop publishes them.
        </p>
      </section>
    );
  }
  return (
    <section className="space-y-2 rounded-lg border border-border bg-card p-4">
      <h2 className="font-medium">Your agents</h2>
      <ul className="divide-y divide-border">
        {registry.map((entry) => {
          const profile = profiles.get(entry.pubkey);
          const isOpen = expanded === entry.pubkey;
          const isEditing = editing === entry.pubkey;
          const persona =
            entry.personaId !== null
              ? (personas.get(entry.personaId) ?? null)
              : null;
          return (
            <li key={entry.pubkey} className="py-2">
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-md px-1 py-1 text-left hover:bg-accent/50"
                onClick={() => setExpanded(isOpen ? null : entry.pubkey)}
                aria-expanded={isOpen}
              >
                <AuthorAvatar
                  pubkey={entry.pubkey}
                  label={profile?.displayName ?? entry.name}
                  picture={profile?.avatar}
                  size="sm"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {profile?.displayName ?? entry.name}
                    {duplicates.has(entry.pubkey) && (
                      <span
                        title="An older registration shares this name — see cleanup below"
                        className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-amber-500"
                      >
                        duplicate
                      </span>
                    )}
                    {entry.personaId !== null && (
                      <span
                        title="Definition-linked: its persona (kind 30175) supplies the definition"
                        className="ml-2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground"
                      >
                        linked
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[entry.model, entry.provider]
                      .filter(Boolean)
                      .join(" @ ") ||
                      `registered ${new Date(entry.updatedAt * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}`}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  {entry.respondTo}
                  <AgentWorkingDot pubkey={entry.pubkey} />
                </span>
              </button>
              {isOpen && (
                <div className="mt-2 space-y-2 rounded-md bg-accent/30 p-3">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      System prompt
                    </p>
                    <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap font-sans text-xs text-foreground/90">
                      {(entry.personaId !== null
                        ? (persona?.systemPrompt ?? "")
                        : entry.systemPrompt) || "(empty)"}
                    </pre>
                  </div>
                  {entry.respondToAllowlist.length > 0 && (
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Allowlist ({entry.respondToAllowlist.length})
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {entry.respondToAllowlist
                          .map((pk) => `${pk.slice(0, 8)}…`)
                          .join(", ")}
                      </p>
                    </div>
                  )}
                  <p className="font-mono text-[10px] text-muted-foreground/70">
                    {entry.pubkey}
                  </p>
                  <AgentRowActions
                    pubkey={entry.pubkey}
                    name={profile?.displayName ?? entry.name}
                    admin={admin}
                    onEdit={() => setEditing(isEditing ? null : entry.pubkey)}
                  />
                  {isEditing && (
                    <EditAgentForm
                      admin={admin}
                      entry={entry}
                      persona={persona}
                      catalogs={catalogs}
                      onClose={() => setEditing(null)}
                    />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        Registry from the relay (kind 30177). Create, edit, harness, and
        lifecycle changes ride the sealed admin-command channel and are applied
        by your desktop.
      </p>
    </section>
  );
}

/**
 * Stale-registration cleanup: older duplicates from key re-mints and
 * registrations no published desktop reports. Every row is a delete command
 * (forceRemoteDelete) the owner confirms; nothing is removed automatically.
 */
function StaleCleanupSection({
  registry,
  catalogs,
  admin,
}: {
  registry: ReturnType<typeof useAgentRegistry>;
  catalogs: ReturnType<typeof useDesktopCatalogs>;
  admin: ReturnType<typeof useAdminCommands>;
}) {
  const stale = useMemo(
    () => findStaleAgents(registry, catalogs),
    [registry, catalogs],
  );
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());

  if (stale.length === 0) {
    return null;
  }
  const selected = stale.filter((entry) => checked.has(entry.pubkey));
  const toggle = (pubkey: string) => {
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(pubkey)) {
        next.delete(pubkey);
      } else {
        next.add(pubkey);
      }
      return next;
    });
  };
  const runCleanup = () => {
    for (const entry of selected) {
      void admin.send(
        {
          action: "delete",
          request: { pubkey: entry.pubkey, forceRemoteDelete: true },
        },
        `Delete ${entry.name} (${entry.reason})`,
      );
    }
    setOpen(false);
    setChecked(new Set());
  };

  return (
    <section className="space-y-3 rounded-lg border border-amber-500/40 bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Clean up stale registrations</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setOpen(!open);
            if (!open) {
              // All pre-checked — one click confirms, unchecking spares rows.
              setChecked(new Set(stale.map((entry) => entry.pubkey)));
            }
          }}
        >
          {open ? "Close" : `Review ${stale.length}`}
        </Button>
      </div>
      {open && (
        <>
          <ul className="space-y-1">
            {stale.map((entry) => (
              <li
                key={entry.pubkey}
                className="flex items-center gap-2 rounded-md bg-accent/40 px-2 py-1.5 text-xs"
              >
                <input
                  type="checkbox"
                  checked={checked.has(entry.pubkey)}
                  onChange={() => toggle(entry.pubkey)}
                  aria-label={`Delete ${entry.name}`}
                />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{entry.name}</span>{" "}
                  <span className="text-muted-foreground">
                    — {entry.reason}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                  {truncatePubkey(entry.pubkey)}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Each row sends a delete command (tombstones the 30177 even if no
              desktop has a local record).
            </p>
            <Button
              size="sm"
              variant="destructive"
              disabled={selected.length === 0}
              onClick={runCleanup}
            >
              Delete {selected.length} stale registration
              {selected.length === 1 ? "" : "s"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function AgentCommands({
  observerStore,
  session,
  registry,
}: {
  observerStore: ReturnType<typeof useObserverStore>;
  session: RelaySession;
  registry: ReturnType<typeof useAgentRegistry>;
}) {
  // Union of registered (30177) and observed (frames this session) agents —
  // registered first so the list is stable across sessions.
  const agentPubkeys = useMemo(() => {
    const seen = Array.from(observerStore?.byAgent.keys() ?? []);
    const registered = registry.map((entry) => entry.pubkey);
    return Array.from(new Set([...registered, ...seen])).sort();
  }, [observerStore, registry]);
  const profiles = useProfiles(agentPubkeys);
  const [selected, setSelected] = useState("");
  const [modelId, setModelId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [busy, setBusy] = useState(false);

  const agent = selected || agentPubkeys[0] || "";
  const label = (pubkey: string) =>
    profiles.get(pubkey)?.displayName ?? truncatePubkey(pubkey);

  const run = async (command: AgentControlCommand) => {
    if (!agent) {
      toast.error("No agents known yet — they appear once they report in.");
      return;
    }
    setBusy(true);
    try {
      const result = await sendAgentControl(session, agent, command);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 className="font-medium">Live control</h2>
      {agentPubkeys.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No agents known yet — they appear once they register or report in.
        </p>
      ) : (
        <>
          <label className="block space-y-1">
            <span className="text-sm text-muted-foreground">Agent</span>
            <select
              value={agent}
              onChange={(event) => setSelected(event.target.value)}
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              aria-label="Agent"
            >
              {agentPubkeys.map((pubkey) => (
                <option key={pubkey} value={pubkey}>
                  {label(pubkey)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm text-muted-foreground">
              Channel id (the conversation the command applies to)
            </span>
            <input
              value={channelId}
              onChange={(event) => setChannelId(event.target.value)}
              placeholder="channel UUID — copy from the URL ?c=…"
              className="w-full rounded-md border border-input bg-card px-3 py-2 font-mono text-xs"
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !channelId.trim()}
            onClick={() =>
              void run({
                type: "cancel_turn",
                channelId: channelId.trim(),
                requestId: newRequestId(),
              })
            }
          >
            Cancel current turn
          </Button>
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 space-y-1">
              <span className="text-sm text-muted-foreground">Model id</span>
              <input
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                placeholder="e.g. glm-5.3"
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              />
            </label>
            <Button
              size="sm"
              disabled={busy || !modelId.trim() || !channelId.trim()}
              onClick={() =>
                void run({
                  type: "switch_model",
                  channelId: channelId.trim(),
                  modelId: modelId.trim(),
                  requestId: newRequestId(),
                })
              }
            >
              Switch model
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Commands ride the relay's owner→agent control channel — the same
            frames the desktop's model picker sends.
          </p>
        </>
      )}
    </section>
  );
}

function ProfileEditor({ session }: { session: RelaySession }) {
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [picture, setPicture] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      toast.error("A name is required.");
      return;
    }
    setBusy(true);
    try {
      const result = await publishOwnProfile(session, {
        name: name.trim(),
        about: about.trim(),
        picture: picture.trim(),
      });
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 className="font-medium">Your profile</h2>
      <p className="text-sm text-muted-foreground">
        Published as your kind-0 metadata — the name other members and agents
        see.
      </p>
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">Display name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">About</span>
        <textarea
          value={about}
          onChange={(event) => setAbout(event.target.value)}
          rows={3}
          className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-sm"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">Avatar URL</span>
        <input
          value={picture}
          onChange={(event) => setPicture(event.target.value)}
          placeholder="https://…"
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
        />
      </label>
      <Button size="sm" disabled={busy} onClick={() => void submit()}>
        {busy ? "Publishing…" : "Save profile"}
      </Button>
    </section>
  );
}
