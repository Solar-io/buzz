import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { LockKeyhole, ChevronRight } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { usePhoneLayout } from "@/shared/layout/AppShell";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { useProfiles } from "@/features/channels/hooks";
import { openDm } from "@/features/dms/hooks";
import { MemorySection } from "@/features/agent-memory/ui/MemorySection";
import { useWorkContext } from "@/features/work/workContext";
import { reactionWork } from "@/features/work/lib/queuedReactions";
import { useAgentRegistry } from "../../useAgentRegistry";
import { useDesktopCatalogs } from "../../useDesktopCatalogs";
import { useDesktopPresence } from "../../useDesktopPresence";
import { adminCommandLock } from "../../lib/adminCommandLock";
import { usePersonas } from "../../usePersonas";
import { useTeams } from "../../useTeams";
import { useAgentChannels } from "../../useAgentChannels";
import {
  useAgentFrames,
  useAgentObserverHistory,
  useObserverStore,
} from "../../ObserverProvider";
import { buildRoster, targetForAgent } from "../../lib/roster";
import { teamNamesByPersonaId } from "../../lib/rosterGroups";
import { observedModels } from "../../lib/modelSuggestions";
import { controlsEnabled } from "../../lib/adminCommandCapabilities";
import { useAdminCommands } from "../../ui/AgentAdminPanel";
import { AgentConfigPanel } from "../../ui/AgentConfigPanel";
import { AgentActivityPanel } from "../../ui/AgentActivityPanel";
import { SnapshotExportDialog } from "../../ui/SnapshotExportDialog";
import { formatElapsed, useTick } from "../../ui/WorkingBadge";
import { AgentHeader } from "./AgentHeader";
import { AgentTabs } from "./AgentTabs";
import { AgentChannelsCard } from "./AgentChannelsCard";
import { AgentChannelsTab } from "./AgentChannelsTab";
import { RightNowCard } from "./RightNowCard";
import {
  agentDesktopReady,
  agentNow,
  logsLockCopy,
  type AgentTab,
} from "./agentScreenModel";

/** Owner-only agent screen. The URL owns selection, including phone sub-pages. */
export function AgentScreen({
  agentPubkey,
  tab: requestedTab,
  onBack,
  onSelect,
  onTab,
}: {
  agentPubkey: string;
  tab?: string;
  onBack: () => void;
  onSelect: (pubkey: string) => void;
  onTab: (tab: AgentTab) => void;
}) {
  const registry = useAgentRegistry();
  const catalogs = useDesktopCatalogs();
  const { map: personas } = usePersonas();
  const { map: teams } = useTeams();
  const { session, status } = useRelaySession();
  const presence = useDesktopPresence(catalogs);
  const admin = useAdminCommands(
    session,
    status,
    (command, options) =>
      adminCommandLock(command, options, catalogs, presence.byMachine).reason,
  );
  const navigate = useNavigate();
  const phone = usePhoneLayout();
  const roster = useMemo(
    () => buildRoster(registry, personas, catalogs),
    [registry, personas, catalogs],
  );
  const pubkeys = useMemo(() => roster.map((entry) => entry.pubkey), [roster]);
  const profiles = useProfiles(pubkeys);
  const row = roster.find((entry) => entry.pubkey === agentPubkey);
  const frames = useAgentFrames(agentPubkey);
  useAgentObserverHistory(agentPubkey);
  const observer = useObserverStore();
  const work = useWorkContext();
  useTick(frames.length > 0 || admin.pending.length > 0);
  const nowS = Math.floor(Date.now() / 1000);
  const live = agentNow(agentPubkey, frames, nowS);
  const models = useMemo(
    () => observedModels(registry, personas),
    [registry, personas],
  );
  const channels = useAgentChannels(agentPubkey);
  const badges = useMemo(
    () => teamNamesByPersonaId(personas.keys(), teams),
    [personas, teams],
  );
  const [exporting, setExporting] = useState(false);
  const [confirmUnregister, setConfirmUnregister] = useState(false);
  const [sending, setSending] = useState(false);
  const tab: AgentTab = ["channels", "logs", "memory", "activity"].includes(
    requestedTab ?? "",
  )
    ? (requestedTab as AgentTab)
    : "settings";

  if (!row)
    return (
      <section
        className="space-y-3 rounded-xl border border-border bg-card p-5"
        data-testid="agent-screen"
      >
        <Button variant="ghost" className="min-h-11" onClick={onBack}>
          ← Agents
        </Button>
        <p className="text-sm text-muted-foreground">
          This agent is not in your registered agents. Choose an agent from the
          list.
        </p>
      </section>
    );

  const enabled =
    status === "open" &&
    agentDesktopReady(catalogs, row.machines, nowS) &&
    !presence.lock(row.machines).locked;
  const pending = admin.pending.filter((entry) =>
    entry.summary.endsWith(row.name),
  );
  const busy =
    sending ||
    pending.some(
      (entry) =>
        !admin.acks.has(entry.requestId) && Date.now() - entry.sentAt < 30_000,
    );
  const active = live.turns[0];
  const channelName = channels.member.find(
    (channel) => channel.id === active?.channelId,
  )?.name;
  const statusLine = active
    ? `Working${channelName ? ` in ${channelName}` : ""} · ${formatElapsed(active.startedAt, nowS)}${active.state !== "live" ? " · No recent heartbeat" : ""}`
    : row.machines.length
      ? `Claimed by ${row.machines.map((machine) => machine.replace(/\.local$/, "")).join(", ")}`
      : "Not on any desktop";
  const lifecycle = async (action: "start" | "stop" | "restart") => {
    if (!enabled || busy) return;
    setSending(true);
    try {
      await admin.send(
        { action, request: { pubkey: row.pubkey } },
        `${action[0].toUpperCase()}${action.slice(1)} ${row.name}`,
        targetForAgent(row.machines),
      );
    } finally {
      setSending(false);
    }
  };
  const message = async () => {
    setSending(true);
    try {
      const result = await openDm(session, [row.pubkey]);
      if (result.ok && result.channelId)
        void navigate({ to: "/repos", search: { c: result.channelId } });
      else toast.error(result.message || "Could not open the conversation.");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not open the conversation.",
      );
    } finally {
      setSending(false);
    }
  };
  const unregister = async () => {
    if (!enabled || busy) return;
    setSending(true);
    try {
      await admin.send(
        { action: "unregister", request: { pubkey: row.pubkey } },
        `Unregister ${row.name}`,
        targetForAgent(row.machines),
      );
      setConfirmUnregister(false);
    } finally {
      setSending(false);
    }
  };
  const queued = work
    ? reactionWork(
        work?.reactions ?? [],
        nowS,
        new Map([
          [
            row.pubkey,
            new Set(live.turns.flatMap((turn) => turn.triggeringEventIds)),
          ],
        ]),
      ).queued.filter((entry) => entry.agentPubkey === row.pubkey).length
    : null;
  const channelProps = {
    row,
    channels,
    session,
    admin,
    enabled: enabled && !busy,
  };
  const exportPersona = row.persona ?? {
    id: row.pubkey,
    name: row.name,
    systemPrompt: row.systemPrompt,
    model: row.model,
    provider: row.provider,
    runtime: "",
    updatedAt: row.entry.updatedAt,
    event: {
      id: "",
      pubkey: "",
      kind: 30175,
      created_at: row.entry.updatedAt,
      sig: "",
      tags: [],
      content: JSON.stringify({
        display_name: row.name,
        system_prompt: row.systemPrompt,
        model: row.model,
        provider: row.provider,
        parallelism: row.entry.parallelism,
        respond_to: row.entry.respondTo,
        respond_to_allowlist: row.entry.respondToAllowlist,
        avatar_url: profiles.get(row.pubkey)?.avatar ?? "",
      }),
    },
  };
  const sideCards = (
    <>
      <RightNowCard
        row={row}
        {...live}
        queued={queued}
        channels={channels.member}
        session={session}
        enabled={status === "open"}
        models={models}
        frames={frames}
      />
      <AgentChannelsCard {...channelProps} onSeeAll={() => onTab("channels")} />
    </>
  );
  return (
    <div className="space-y-5" data-testid="agent-screen">
      <AgentHeader
        row={row}
        profile={profiles.get(row.pubkey)}
        roster={roster}
        teams={
          row.entry.personaId ? (badges.get(row.entry.personaId) ?? []) : []
        }
        statusLine={statusLine}
        working={live.turns.length > 0}
        enabled={enabled}
        restartEnabled={controlsEnabled(catalogs, row.machines)}
        busy={busy}
        onBack={onBack}
        onSelect={onSelect}
        onMessage={() => void message()}
        onLifecycle={(action) => void lifecycle(action)}
        onExport={() => setExporting(true)}
        onUnregister={() => setConfirmUnregister(true)}
      />
      {!enabled ? (
        <p className="rounded-lg border border-border bg-muted p-3 text-sm text-muted-foreground">
          {status !== "open"
            ? "Connect to the relay to change this agent."
            : "Needs a current report from one Buzz Desktop. Saved values remain visible."}
        </p>
      ) : null}
      {pending.length ? (
        <ul className="space-y-1" aria-live="polite">
          {pending.map((entry) => {
            const ack = admin.acks.get(entry.requestId);
            return (
              <li
                key={entry.requestId}
                className={`rounded-md bg-muted px-3 py-2 text-xs ${ack && !ack.ok ? "text-coral-ink" : "text-muted-foreground"}`}
              >
                {entry.summary} ·{" "}
                {ack
                  ? ack.ok
                    ? `Saved on ${row.machines[0]?.replace(/\.local$/, "") ?? "Buzz Desktop"}`
                    : (ack.error ?? "Buzz Desktop refused the command.")
                  : Date.now() - entry.sentAt >= 30_000
                    ? "No answer from Buzz Desktop — it may still apply. Check status after reload."
                    : "Sending to Buzz Desktop…"}
              </li>
            );
          })}
        </ul>
      ) : null}
      {confirmUnregister ? (
        <section
          role="alertdialog"
          aria-label={`Unregister ${row.name}`}
          className="space-y-3 rounded-xl border border-coral-line bg-card p-4"
        >
          <p className="text-sm">
            Unregister {row.name}? Keeps the key and removes the registration.
            This does not stop a running process.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirmUnregister(false)}
            >
              Keep agent
            </Button>
            <Button
              className="min-h-11"
              disabled={busy || !enabled}
              onClick={() => void unregister()}
            >
              Unregister
            </Button>
          </div>
        </section>
      ) : null}
      <AgentTabs
        tab={tab}
        channelCount={channels.member.length}
        onSelect={onTab}
      />
      <div className="md:hidden">
        {tab === "memory" || tab === "activity" ? (
          <Button
            variant="ghost"
            className="min-h-11"
            onClick={() => onTab("settings")}
          >
            ← Agent settings
          </Button>
        ) : null}
      </div>
      {tab === "settings" ? (
        <div
          className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]"
          data-testid="agent-settings-layout"
        >
          {!phone && (
            <aside
              className="grid min-w-0 gap-4 md:grid-cols-2 xl:order-2 xl:sticky xl:top-4 xl:grid-cols-1"
              data-testid="agent-side-cards"
            >
              {sideCards}
            </aside>
          )}
          <div className="min-w-0 space-y-4 xl:order-1">
            <section className="rounded-xl border border-border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">
                Model &amp; thinking
              </h2>
              <dl className="divide-y divide-border text-sm">
                {[
                  ["Model", row.model],
                  ["Effort", row.entry.effort?.acp],
                  ["Runtime", row.persona?.runtime],
                ]
                  .filter(([, value]) => value)
                  .map(([label, value]) => (
                    <div
                      key={label}
                      className="flex flex-wrap justify-between gap-2 py-3"
                    >
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="max-w-full break-words">{value}</dd>
                    </div>
                  ))}
              </dl>
              <p className="mt-2 text-xs text-muted-foreground">
                Last published settings. Change settings below.
              </p>
            </section>
            {phone ? (
              <AgentChannelsCard
                {...channelProps}
                onSeeAll={() => onTab("channels")}
              />
            ) : null}
            <details className="rounded-xl border border-border bg-card p-4">
              <summary className="min-h-11 cursor-pointer text-sm font-semibold md:min-h-8">
                Agent settings
              </summary>
              <div className="pt-4">
                <fieldset disabled={!enabled}>
                  <AgentConfigPanel
                    settingsOnly
                    row={row}
                    profile={profiles.get(row.pubkey)}
                    admin={admin}
                    session={session}
                    catalogs={catalogs}
                    registryModels={models}
                    roster={roster}
                    viewerIsOwner
                    onDeleted={onBack}
                  />
                </fieldset>
              </div>
            </details>
            {phone ? (
              <details className="rounded-xl border border-border bg-card p-4">
                <summary className="min-h-11 cursor-pointer text-sm font-semibold">
                  Right now
                </summary>
                <RightNowCard
                  row={row}
                  {...live}
                  queued={queued}
                  channels={channels.member}
                  session={session}
                  enabled={status === "open"}
                  models={models}
                  frames={frames}
                />
              </details>
            ) : null}
            <section className="rounded-xl border border-border bg-card p-4 md:hidden">
              <h2 className="mb-2 text-xs font-semibold text-muted-foreground">
                More settings
              </h2>
              {(["memory", "activity"] as const).map((section) => (
                <button
                  key={section}
                  type="button"
                  className="flex min-h-11 w-full items-center justify-between border-t border-border text-sm"
                  onClick={() => onTab(section)}
                >
                  {section === "memory" ? "Memory" : "Activity"}
                  <ChevronRight aria-hidden className="h-4 w-4" />
                </button>
              ))}
            </section>
          </div>
        </div>
      ) : null}
      {tab === "channels" ? <AgentChannelsTab {...channelProps} /> : null}
      {tab === "logs" ? (
        <section
          className="space-y-2 rounded-xl border border-border bg-card p-5"
          data-testid="agent-logs-locked"
        >
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <LockKeyhole aria-hidden className="h-4 w-4" />
            Logs
          </h2>
          <p className="text-sm text-muted-foreground">
            {logsLockCopy(row.machines[0])}
          </p>
        </section>
      ) : null}
      {tab === "memory" ? (
        <MemorySection agentPubkey={row.pubkey} viewerIsOwner />
      ) : null}
      {tab === "activity" ? (
        <AgentActivityPanel
          presentation="inline"
          agentPubkey={row.pubkey}
          agentName={row.name}
          profile={profiles.get(row.pubkey)}
          frames={frames}
          lockedCount={observer?.lockedCount ?? 0}
          connected={observer?.connected ?? false}
          working={{ working: !!active, startedAt: active?.startedAt ?? null }}
          mobileOpen={false}
          onCloseMobile={() => onTab("settings")}
        />
      ) : null}
      {exporting ? (
        <SnapshotExportDialog
          persona={exportPersona}
          linkedRows={[row]}
          onClose={() => setExporting(false)}
        />
      ) : null}
    </div>
  );
}
