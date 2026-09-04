import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/shared/ui/button";
import type { RelaySession } from "@/shared/api/relay-session";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { useProfiles } from "@/features/channels/hooks";
import type { Profile } from "@/features/channels/hooks";
import { AuthorAvatar } from "@/features/channels/ui/ChannelTimeline";
import { findStaleAgents } from "../lib/staleAgents";
import { publishOwnProfile } from "../lib/agentControl";
import type { RosterRow } from "../lib/roster";
import type { RosterGroupSection } from "../lib/rosterGroups";
import type { AdminCommand } from "../lib/adminCommands";
import { RESPOND_TO_OPTIONS } from "../lib/respondToField";
import { agentRecentlyActive } from "../lib/observerEvents";
import { useAgentFrames } from "../ObserverProvider";

/**
 * The left pane of the two-pane agents screen: the roster list, stale-
 * registration cleanup, and the owner's kind-0 profile editor (the latter
 * two MOVED from the old single-column AgentsAdminPage — Phase 1 file map
 * #14). AgentsAdminPage re-exports AgentWorkingDot for its existing
 * importers.
 */

type Admin = {
  send: (
    command: AdminCommand,
    summary: string,
    options?: { target?: string },
  ) => Promise<string | null>;
};

export function AgentWorkingDot({ pubkey }: { pubkey: string }) {
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

function accessLabel(respondTo: string): string {
  return (
    RESPOND_TO_OPTIONS.find((option) => option.value === respondTo)?.label ??
    respondTo
  );
}

export function AgentRosterSidebar({
  roster,
  sections,
  teamNamesByPersona,
  selectedPubkey,
  onSelect,
  onNewAgent,
  registry,
  catalogs,
  admin,
  session,
}: {
  roster: RosterRow[];
  /** Persona-grouped sections (lib/rosterGroups) — a view over `roster`. */
  sections: RosterGroupSection[];
  /** Persona id → team names, for row badges (unknown membership = none). */
  teamNamesByPersona: ReadonlyMap<string, string[]>;
  selectedPubkey: string | null;
  onSelect: (pubkey: string) => void;
  onNewAgent: () => void;
  registry: RosterRow["entry"][];
  catalogs: Parameters<typeof findStaleAgents>[1];
  admin: Admin;
  session: RelaySession;
}) {
  const pubkeys = useMemo(() => roster.map((row) => row.pubkey), [roster]);
  const profiles = useProfiles(pubkeys);

  return (
    <div className="space-y-4">
      <section className="space-y-2 rounded-lg border border-border bg-card p-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Your agents</h2>
          <Button size="sm" variant="outline" onClick={onNewAgent}>
            <Plus aria-hidden className="mr-1 h-4 w-4" />
            New agent
          </Button>
        </div>
        {roster.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agent registrations on the relay yet — agents appear here once
            your desktop publishes them.
          </p>
        ) : (
          <div className="space-y-3">
            {sections.map((section) => {
              // Persona headers always render (a definition with zero
              // instances is real state); the catch-all buckets stay hidden
              // while empty — the desktop library's behavior.
              if (section.rows.length === 0 && section.persona === null) {
                return null;
              }
              return (
                <div key={section.key} className="space-y-1">
                  <p className="px-1 text-badge font-semibold uppercase tracking-wide text-muted-foreground">
                    {section.title} ({section.rows.length})
                  </p>
                  <ul className="divide-y divide-border">
                    {section.rows.map((row) => (
                      <AgentRosterRow
                        key={row.pubkey}
                        row={row}
                        profile={profiles.get(row.pubkey)}
                        teamNames={
                          row.entry.personaId !== null
                            ? (teamNamesByPersona.get(row.entry.personaId) ??
                              [])
                            : []
                        }
                        selected={row.pubkey === selectedPubkey}
                        onSelect={() => onSelect(row.pubkey)}
                      />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Registry from the relay (kind 30177). Changes ride the sealed
          admin-command channel and are applied by your desktop.
        </p>
      </section>
      <StaleCleanupCard registry={registry} catalogs={catalogs} admin={admin} />
      <OwnerProfileCard session={session} />
    </div>
  );
}

function AgentRosterRow({
  row,
  profile,
  teamNames,
  selected,
  onSelect,
}: {
  row: RosterRow;
  profile?: Profile;
  teamNames: string[];
  selected: boolean;
  onSelect: () => void;
}) {
  const subtitle =
    [row.model, row.provider].filter(Boolean).join(" @ ") ||
    `registered ${new Date(row.entry.updatedAt * 1000).toLocaleDateString([], { month: "short", day: "numeric" })}`;
  return (
    <li>
      <button
        type="button"
        className={
          "flex w-full items-center gap-2.5 rounded-md px-1 py-2 text-left hover:bg-accent/50 " +
          (selected ? "bg-accent" : "")
        }
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
      >
        <AuthorAvatar
          pubkey={row.pubkey}
          label={profile?.displayName ?? row.name}
          picture={profile?.avatar}
          size="sm"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {profile?.displayName ?? row.name}
            {row.duplicate && (
              <span
                title="An older registration shares this name — see cleanup below"
                className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-badge font-normal uppercase tracking-wide text-amber-500"
              >
                duplicate
              </span>
            )}
            {row.personaLinked && (
              <span
                title="Definition-linked: its persona (kind 30175) supplies the definition"
                className="ml-2 rounded bg-accent px-1.5 py-0.5 text-badge font-normal uppercase tracking-wide text-muted-foreground"
              >
                linked
              </span>
            )}
            {teamNames.map((teamName) => (
              <span
                key={teamName}
                title={`Member of the team "${teamName}"`}
                className="ml-1.5 rounded bg-sky-500/15 px-1.5 py-0.5 text-badge font-normal text-sky-600 dark:text-sky-400"
              >
                {teamName}
              </span>
            ))}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="flex items-center gap-1.5">
            <span className="text-badge uppercase tracking-wide text-muted-foreground">
              {accessLabel(row.entry.respondTo)}
            </span>
            <AgentWorkingDot pubkey={row.pubkey} />
          </span>
          {row.machines.length > 0 && (
            <span
              title={`Runnable on ${row.machines.join(", ")}`}
              className="max-w-32 truncate text-badge text-muted-foreground/70"
            >
              {row.machines.join(", ")}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * Stale-registration cleanup: older duplicates from key re-mints and
 * registrations no published desktop reports. Every row is an UNREGISTER
 * command the owner confirms; nothing is removed automatically.
 *
 * Unregister, never delete. This card used to send
 * `delete` + `forceRemoteDelete`, which wipes the agent's key — unrecoverable,
 * and far more than "this registration is stale" warrants. Unregister
 * tombstones and archives the relay registration only: no process is stopped
 * and no key is destroyed.
 */
function StaleCleanupCard({
  registry,
  catalogs,
  admin,
}: {
  registry: RosterRow["entry"][];
  catalogs: Parameters<typeof findStaleAgents>[1];
  admin: Admin;
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
          action: "unregister",
          request: { pubkey: entry.pubkey },
        },
        `Unregister ${entry.name} (${entry.reason})`,
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
                  aria-label={`Unregister ${entry.name}`}
                />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{entry.name}</span>{" "}
                  <span className="text-muted-foreground">
                    — {entry.reason}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-badge text-muted-foreground/70">
                  {truncatePubkey(entry.pubkey)}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Each row sends an unregister command — tombstones and archives the
              relay registration only. No process is stopped, no key is deleted.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={selected.length === 0}
              onClick={runCleanup}
            >
              Unregister {selected.length} stale registration
              {selected.length === 1 ? "" : "s"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

/** Owner kind-0 profile publisher, as a disclosure. */
function OwnerProfileCard({ session }: { session: RelaySession }) {
  const [open, setOpen] = useState(false);
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
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Your profile</h2>
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Edit"}
        </Button>
      </div>
      {!open && (
        <p className="text-sm text-muted-foreground">
          Published as your kind-0 metadata — the name other members and agents
          see.
        </p>
      )}
      {open && (
        <>
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
        </>
      )}
    </section>
  );
}
