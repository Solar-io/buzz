import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Button } from "@/shared/ui/button";
import type { RelaySession } from "@/shared/api/relay-session";
import type { Profile } from "@/features/channels/hooks";
import { AuthorAvatar } from "@/features/channels/ui/ChannelTimeline";
import { uploadBlob } from "@/shared/api/blossom";
import { acceptAvatarDescriptor } from "../lib/avatarUpload";
import { modelSuggestions } from "../lib/modelSuggestions";
import {
  buildUpdateCommand,
  prefillEditForm,
  type EditAgentFormValue,
} from "../lib/editAgentRequest";
import { targetForAgent, type RosterRow } from "../lib/roster";
import { controlsEnabled } from "../lib/adminCommandCapabilities";
import {
  apiKeyFieldVisible,
  providerSecretEnvVar,
} from "../lib/providerApiKey";
import type { DesktopCatalog } from "../lib/desktopCatalog";
import type { useAdminCommands } from "./AgentAdminPanel";
import {
  AccessFields,
  EffortField,
  EnvFields,
  IdentityFields,
  ModelProviderFields,
  RuntimeFields,
  SectionHeading,
  StartOnLaunchField,
  TimeoutFields,
} from "./AgentFormSections";
import { AgentWorkingDot } from "./AgentRosterSidebar";
import { DefinitionEditorSection } from "./DefinitionEditorSection";
import { LiveControlSection } from "./LiveControlSection";
import { ProviderApiKeyField } from "./ProviderApiKeyField";
import {
  MemoryRefreshButton,
  MemorySection,
} from "@/features/agent-memory/ui/MemorySection";

/**
 * The right pane for a selected agent — desktop-parity config surface. Edit
 * state is per-selection: the page mounts this panel with key={pubkey}, so
 * switching agents discards the edit (a dirty-form guard is a known Phase-2
 * gap). Lifecycle and update commands target the one machine whose catalog
 * claims the agent (targetForAgent) so a second desktop never emits a
 * spurious error ack.
 */

const LINKED_QUAD_NOTE =
  "Prompt, model, and provider come from this agent's definition — edit them in the Definition section above.";

export function AgentConfigPanel({
  row,
  profile,
  admin,
  session,
  catalogs,
  registryModels,
  roster,
  viewerIsOwner,
  onDeleted,
  settingsOnly = false,
  remainingOnly = false,
}: {
  row: RosterRow;
  profile?: Profile;
  admin: ReturnType<typeof useAdminCommands>;
  session: RelaySession;
  catalogs: DesktopCatalog[];
  registryModels: string[];
  /** Full roster — the shared-definition count for the Definition editor. */
  roster: readonly RosterRow[];
  /**
   * Does the viewer own this agent? Drives the read-only NIP-AE memory
   * section only. See {@link MemorySectionBlock} — this is a UX gate, not a
   * security boundary.
   */
  viewerIsOwner: boolean;
  onDeleted: () => void;
  /** W9a's shell owns identity, live control, memory and lifecycle actions. */
  settingsOnly?: boolean;
  /** W9b1 owns model/runtime/access; W9b2 rebuilds the remaining fields. */
  remainingOnly?: boolean;
}) {
  const prefill = useMemo(
    // The kind-0 profile picture is the only avatar the web can see; it is
    // also exactly what an avatar edit republishes, so it is the keep/clear
    // baseline.
    () => prefillEditForm(row.entry, row.persona, profile?.avatar ?? null),
    [row.entry, row.persona, profile?.avatar],
  );
  const [value, setValue] = useState<EditAgentFormValue>(prefill);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);

  const set = <K extends keyof EditAgentFormValue>(
    key: K,
    next: EditAgentFormValue[K],
  ) => setValue((previous) => ({ ...previous, [key]: next }));

  const ack = requestId ? admin.acks.get(requestId) : undefined;
  useEffect(() => {
    if (!ack) {
      return;
    }
    if (ack.ok) {
      toast.success(`Updated ${row.name}`);
      setRequestId(null);
    } else {
      toast.error(ack.error || "The desktop rejected the update.");
      setRequestId(null);
    }
  }, [ack, row.name]);

  const target = targetForAgent(row.machines);
  // Phase-2 controls render only when EVERY claiming desktop's catalog is
  // >= v2 — an older desktop parses the new fields but drops them at the
  // applier, which is exactly the half-applied state the gate prevents.
  const phase2 = controlsEnabled(catalogs, row.machines);
  // API key: the effective provider/runtime decide which secret var (if
  // any) the field targets. Linked → the definition's; else this edit's.
  const keyProvider = row.persona ? row.persona.provider : value.provider;
  const keyRuntime = row.persona?.runtime
    ? row.persona.runtime
    : value.harnessId !== "__keep" && value.harnessId !== "__custom"
      ? value.harnessId
      : null;
  const keySecret = providerSecretEnvVar(keyProvider);
  const keyVisible =
    phase2 && keySecret !== null && apiKeyFieldVisible(keyProvider, keyRuntime);
  const pendingForAgent = admin.pending.filter((entry) =>
    entry.summary.includes(row.name),
  );

  const submit = async () => {
    if (busy) {
      return;
    }
    const built = buildUpdateCommand(row.entry, prefill, {
      ...value,
      apiKeyEnvVar: keyVisible && keySecret ? keySecret.envVar : null,
    });
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    const keyChanged = keyVisible && value.apiKey.kind !== "keep";
    setBusy(true);
    try {
      // The pending label names the field, never the value.
      const id = await admin.send(
        built.command,
        `Update ${row.name}${keyChanged ? ": API key" : ""}`,
        target,
      );
      setRequestId(id);
      if (id && keyChanged) {
        // The secret leaves component state as soon as it is sealed + sent.
        set("apiKey", { kind: "keep" });
      }
    } finally {
      setBusy(false);
    }
  };

  const uploadAvatar = async (file: File) => {
    setAvatarUploading(true);
    try {
      const accepted = acceptAvatarDescriptor(await uploadBlob(file));
      if ("error" in accepted) {
        toast.error(accepted.error);
        return;
      }
      set("avatarUrl", accepted.url);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not upload that image.",
      );
    } finally {
      setAvatarUploading(false);
    }
  };

  const lifecycle = (action: "start" | "stop" | "restart") =>
    void admin.send(
      { action, request: { pubkey: row.pubkey } },
      `${action === "start" ? "Start" : action === "stop" ? "Stop" : "Restart"} ${row.name}`,
      target,
    );

  const confirmDelete = () =>
    void admin
      .send(
        {
          action: "delete",
          request: { pubkey: row.pubkey, forceRemoteDelete: true },
        },
        `Delete ${row.name}`,
        target,
      )
      .then((id) => {
        if (id) {
          setConfirmingDelete(false);
          onDeleted();
        }
      });

  return (
    <div className="space-y-6">
      {!settingsOnly && <IdentitySection row={row} profile={profile} />}
      {row.personaLinked && (
        <DefinitionEditorSection
          row={row}
          roster={roster}
          session={session}
          catalogs={catalogs}
          admin={admin}
          registryModels={registryModels}
        />
      )}
      <IdentityFields
        name={value.name}
        onNameChange={(next) => set("name", next)}
        systemPrompt={value.systemPrompt}
        onSystemPromptChange={(next) => set("systemPrompt", next)}
        promptDisabled={row.personaLinked}
        promptNote={row.personaLinked ? LINKED_QUAD_NOTE : undefined}
        avatarUrl={value.avatarUrl}
        onAvatarUrlChange={
          phase2 ? (next) => set("avatarUrl", next) : undefined
        }
        onAvatarUpload={phase2 ? (file) => void uploadAvatar(file) : undefined}
        avatarUploading={avatarUploading}
        avatarNote={
          phase2
            ? "Leave unchanged to keep the current picture; clearing the field resets it to the harness default."
            : undefined
        }
      />
      {!remainingOnly && (
        <ModelProviderFields
          model={value.model}
          onModelChange={(next) => set("model", next)}
          provider={value.provider}
          onProviderChange={(next) => set("provider", next)}
          registryModels={registryModels}
          quadDisabled={row.personaLinked}
          quadNote={row.personaLinked ? LINKED_QUAD_NOTE : undefined}
          harnessId={value.harnessId}
          onHarnessChange={(next) => set("harnessId", next)}
          customCommand={value.customCommand}
          onCustomCommandChange={(next) => set("customCommand", next)}
          customArgs={value.customArgs}
          onCustomArgsChange={(next) => set("customArgs", next)}
          catalogs={catalogs}
          harnessKeep
        />
      )}
      {!remainingOnly && keyVisible && keySecret && (
        <ProviderApiKeyField
          label={keySecret.label}
          envVar={keySecret.envVar}
          value={value.apiKey}
          onChange={(next) => set("apiKey", next)}
          linked={row.personaLinked}
        />
      )}
      {!remainingOnly && (
        <RuntimeFields
          parallelism={value.parallelism}
          onParallelismChange={(next) => set("parallelism", next)}
        />
      )}
      {!remainingOnly && phase2 && (
        <TimeoutFields
          idleTimeoutSeconds={value.idleTimeoutSeconds}
          onIdleTimeoutChange={(next) => set("idleTimeoutSeconds", next)}
          maxTurnDurationSeconds={value.maxTurnDurationSeconds}
          onMaxTurnDurationChange={(next) =>
            set("maxTurnDurationSeconds", next)
          }
        />
      )}
      {!remainingOnly && phase2 && (
        <StartOnLaunchField
          value={value.startOnAppLaunch}
          onChange={(next) => set("startOnAppLaunch", next)}
        />
      )}
      {!remainingOnly && (
        <AccessFields
          respondTo={value.respondTo}
          onRespondToChange={(next) => set("respondTo", next)}
          allowlist={value.respondToAllowlist}
          onAllowlistChange={(next) => set("respondToAllowlist", next)}
        />
      )}
      <EnvFields
        rows={value.envRows}
        onChange={(next) =>
          setValue((previous) => ({
            ...previous,
            envRows: next,
            envDirty: true,
          }))
        }
        dirty={value.envDirty}
        editMode
      />
      {!remainingOnly && phase2 && (
        <EffortField
          value={value.effort}
          onChange={(next) => set("effort", next)}
        />
      )}
      {!settingsOnly && (
        <LiveControlSection
          session={session}
          agentPubkey={row.pubkey}
          modelSuggestions={modelSuggestions("", registryModels)}
        />
      )}
      {!settingsOnly && (
        <MemorySectionBlock
          agentPubkey={row.pubkey}
          viewerIsOwner={viewerIsOwner}
        />
      )}
      <ActionsRow
        busy={busy}
        pendingCount={pendingForAgent.length}
        confirmingDelete={confirmingDelete}
        setConfirmingDelete={setConfirmingDelete}
        restartEnabled={phase2}
        onSave={() => void submit()}
        onLifecycle={lifecycle}
        onDelete={confirmDelete}
      />
      <p className="text-xs text-muted-foreground">
        Only changed fields are sent. Fields marked "not readable here" have no
        relay read path — the web sets them and the desktop applies them on
        save.
        {!phase2 &&
          " Editing the avatar, turn limits, startup, effort, and restarting needs a desktop update (catalog v2)."}
      </p>
    </div>
  );
}

function IdentitySection({
  row,
  profile,
}: {
  row: RosterRow;
  profile?: Profile;
}) {
  const status =
    row.machines.length > 0
      ? `Runnable on ${row.machines.join(", ")}`
      : "No desktop reports this agent";
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <AuthorAvatar
          pubkey={row.pubkey}
          label={profile?.displayName ?? row.name}
          picture={profile?.avatar}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {profile?.displayName ?? row.name}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <AgentWorkingDot pubkey={row.pubkey} />
            {status}
          </p>
        </div>
      </div>
      <div className="space-y-1">
        <span className="block text-sm text-muted-foreground">Agent key</span>
        <div className="flex items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded-md border border-input bg-card px-3 py-2 font-mono text-xs text-muted-foreground">
            {row.pubkey}
          </code>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            aria-label="Copy agent key"
            onClick={() => {
              void navigator.clipboard
                .writeText(row.pubkey)
                .then(() => toast.success("Agent key copied."))
                .catch(() => toast.error("Could not copy the key."));
            }}
          >
            <Copy aria-hidden className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Read-only NIP-AE agent memory, mounted in the selected agent's detail pane.
 *
 * The desktop mounts `MemorySection` in its agent profile panel; the web
 * client has no profile panel, and this pane is its closest analogue — the
 * per-agent surface you reach by selecting an agent on /repos/agents.
 *
 * `viewerIsOwner` is a UX GATE, NOT A SECURITY BOUNDARY. The real boundary is
 * that every engram is NIP-44 encrypted to the owner's pubkey (so only the
 * owner's key opens it) and that the relay refuses an engram REQ whose `#p`
 * is not the authenticated reader. This flag only decides whether we bother
 * asking — exactly as the desktop's `isCurrentUserOwner || isOwner` does.
 */
function MemorySectionBlock({
  agentPubkey,
  viewerIsOwner,
}: {
  agentPubkey: string;
  viewerIsOwner: boolean;
}) {
  if (!viewerIsOwner) {
    return null;
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <SectionHeading>Memory</SectionHeading>
        <MemoryRefreshButton
          agentPubkey={agentPubkey}
          viewerIsOwner={viewerIsOwner}
        />
      </div>
      <MemorySection agentPubkey={agentPubkey} viewerIsOwner={viewerIsOwner} />
      <p className="text-xs text-muted-foreground">
        What this agent has remembered. Read-only here — memories are written by
        the agent itself.
      </p>
    </div>
  );
}

function ActionsRow({
  busy,
  pendingCount,
  confirmingDelete,
  setConfirmingDelete,
  restartEnabled,
  onSave,
  onLifecycle,
  onDelete,
}: {
  busy: boolean;
  pendingCount: number;
  confirmingDelete: boolean;
  setConfirmingDelete: (next: boolean) => void;
  /** Catalog v2 gate: restart composes the Phase-2 stop-then-start applier. */
  restartEnabled: boolean;
  onSave: () => void;
  onLifecycle: (action: "start" | "stop" | "restart") => void;
  onDelete: () => void;
}) {
  const lifecycleBusy = pendingCount > 0;
  return (
    <div className="space-y-2">
      <SectionHeading>Actions</SectionHeading>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={onSave}>
          {busy ? "Sending…" : "Save changes"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={lifecycleBusy}
          onClick={() => onLifecycle("start")}
        >
          Start
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={lifecycleBusy}
          onClick={() => onLifecycle("stop")}
        >
          Stop
        </Button>
        {restartEnabled && (
          <Button
            size="sm"
            variant="outline"
            disabled={lifecycleBusy}
            onClick={() => onLifecycle("restart")}
          >
            Restart
          </Button>
        )}
        {confirmingDelete ? (
          <>
            <Button size="sm" variant="destructive" onClick={onDelete}>
              Confirm delete
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-red-400 hover:text-red-300"
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </Button>
        )}
      </div>
      {pendingCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {pendingCount} command{pendingCount === 1 ? "" : "s"} in flight —
          watch the strip above for the desktop's ack.
        </p>
      )}
    </div>
  );
}
