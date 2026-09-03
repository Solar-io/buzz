import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import type { RelaySession } from "@/shared/api/relay-session";
import type { Profile } from "@/features/channels/hooks";
import { AuthorAvatar } from "@/features/channels/ui/ChannelTimeline";
import {
  sendAgentControl,
  type AgentControlCommand,
} from "../lib/agentControl";
import {
  buildUpdateCommand,
  prefillEditForm,
  type EditAgentFormValue,
} from "../lib/editAgentRequest";
import { targetForAgent, type RosterRow } from "../lib/roster";
import type { DesktopCatalog } from "../lib/desktopCatalog";
import type { useAdminCommands } from "./AgentAdminPanel";
import {
  AccessFields,
  EnvFields,
  IdentityFields,
  ModelProviderFields,
  RuntimeFields,
  SectionHeading,
} from "./AgentFormSections";
import { AgentWorkingDot } from "./AgentRosterSidebar";

/**
 * The right pane for a selected agent — desktop-parity config surface. Edit
 * state is per-selection: the page mounts this panel with key={pubkey}, so
 * switching agents discards the edit (a dirty-form guard is a known Phase-2
 * gap). Lifecycle and update commands target the one machine whose catalog
 * claims the agent (targetForAgent) so a second desktop never emits a
 * spurious error ack.
 */

const LINKED_QUAD_NOTE =
  "This agent's prompt, model, and provider come from its definition — edit them in the desktop app.";

function newRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

export function AgentConfigPanel({
  row,
  profile,
  admin,
  session,
  catalogs,
  registryModels,
  onDeleted,
}: {
  row: RosterRow;
  profile?: Profile;
  admin: ReturnType<typeof useAdminCommands>;
  session: RelaySession;
  catalogs: DesktopCatalog[];
  registryModels: string[];
  onDeleted: () => void;
}) {
  const prefill = useMemo(
    () => prefillEditForm(row.entry, row.persona),
    [row.entry, row.persona],
  );
  const [value, setValue] = useState<EditAgentFormValue>(prefill);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
  const pendingForAgent = admin.pending.filter((entry) =>
    entry.summary.includes(row.name),
  );

  const submit = async () => {
    if (busy) {
      return;
    }
    const built = buildUpdateCommand(row.entry, prefill, value);
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    setBusy(true);
    try {
      const id = await admin.send(built.command, `Update ${row.name}`, target);
      setRequestId(id);
    } finally {
      setBusy(false);
    }
  };

  const lifecycle = (action: "start" | "stop") =>
    void admin.send(
      { action, request: { pubkey: row.pubkey } },
      `${action === "start" ? "Start" : "Stop"} ${row.name}`,
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
      <IdentitySection row={row} profile={profile} />
      <IdentityFields
        name={value.name}
        onNameChange={(next) => set("name", next)}
        systemPrompt={value.systemPrompt}
        onSystemPromptChange={(next) => set("systemPrompt", next)}
        promptDisabled={row.personaLinked}
        promptNote={row.personaLinked ? LINKED_QUAD_NOTE : undefined}
      />
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
      <RuntimeFields
        parallelism={value.parallelism}
        onParallelismChange={(next) => set("parallelism", next)}
      />
      <AccessFields
        respondTo={value.respondTo}
        onRespondToChange={(next) => set("respondTo", next)}
        allowlist={value.respondToAllowlist}
        onAllowlistChange={(next) => set("respondToAllowlist", next)}
      />
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
      <LiveControlSection session={session} agentPubkey={row.pubkey} />
      <ActionsRow
        busy={busy}
        pendingCount={pendingForAgent.length}
        confirmingDelete={confirmingDelete}
        setConfirmingDelete={setConfirmingDelete}
        onSave={() => void submit()}
        onLifecycle={lifecycle}
        onDelete={confirmDelete}
      />
      <p className="text-xs text-muted-foreground">
        Only changed fields are sent. Avatar and turn timeouts are create-time
        or desktop-dialog fields (protocol limit) and are not editable here.
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
 * Live owner→agent control for the SELECTED agent (no dropdown — the roster
 * is the picker). Same frames the desktop's model picker sends.
 */
function LiveControlSection({
  session,
  agentPubkey,
}: {
  session: RelaySession;
  agentPubkey: string;
}) {
  const [channelId, setChannelId] = useState("");
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (command: AgentControlCommand) => {
    setBusy(true);
    try {
      const result = await sendAgentControl(session, agentPubkey, command);
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
    <div className="space-y-3">
      <SectionHeading>Live control</SectionHeading>
      <div className="block space-y-1">
        <span className="block text-sm text-muted-foreground">
          Channel id (the conversation the command applies to)
        </span>
        <Input
          aria-label="Channel id"
          value={channelId}
          onChange={(event) => setChannelId(event.target.value)}
          placeholder="channel UUID — copy from the URL ?c=…"
          className="font-mono text-xs"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      <div className="flex flex-wrap items-end gap-2">
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
        <div className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm text-muted-foreground">Model id</span>
          <Input
            aria-label="Model id"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder="e.g. glm-5.3"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
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
        Commands ride the relay's owner→agent control channel — the same frames
        the desktop's model picker sends.
      </p>
    </div>
  );
}

function ActionsRow({
  busy,
  pendingCount,
  confirmingDelete,
  setConfirmingDelete,
  onSave,
  onLifecycle,
  onDelete,
}: {
  busy: boolean;
  pendingCount: number;
  confirmingDelete: boolean;
  setConfirmingDelete: (next: boolean) => void;
  onSave: () => void;
  onLifecycle: (action: "start" | "stop") => void;
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
