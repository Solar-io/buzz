import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import type { RelaySession } from "@/shared/api/relay-session";
import {
  sendAdminCommand,
  useAdminAckWatcher,
} from "../lib/adminCommandsSend";
import {
  harnessFromSelection,
  type AdminAckEnvelope,
  type AdminCommand,
} from "../lib/adminCommands";

/**
 * Remote agent administration (kinds 24201/24202): owner commands the web
 * seals and sends, the owner's Buzz Desktop applies through its own save
 * paths, acks flow back. Field surface mirrors the desktop's agent dialog —
 * "the same as what is available in the desktop buzz".
 */

/** Static mirror of the desktop's runtime catalog (discovery.rs + presets.rs). */
const PRESET_HARNESSES: { id: string; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "buzz-agent", label: "Buzz Agent" },
  { id: "devin", label: "Devin" },
  { id: "cursor", label: "Cursor" },
  { id: "omp", label: "Oh My Pi" },
  { id: "grok", label: "Grok Build" },
  { id: "opencode", label: "OpenCode" },
  { id: "kimi", label: "Kimi Code" },
  { id: "amp", label: "Amp" },
  { id: "hermes", label: "Hermes Agent" },
  { id: "openclaw", label: "OpenClaw" },
];

interface PendingCommand {
  requestId: string;
  summary: string;
  sentAt: number;
}

const ACK_TIMEOUT_MS = 20_000;

export function useAdminCommands(
  session: RelaySession | null,
  status: string,
): {
  send: (command: AdminCommand, summary: string) => Promise<void>;
  pending: PendingCommand[];
  acks: Map<string, AdminAckEnvelope>;
} {
  const acks = useAdminAckWatcher(session, status);
  const [pending, setPending] = useState<PendingCommand[]>([]);

  const send = async (command: AdminCommand, summary: string) => {
    if (!session) {
      toast.error("Not connected to the relay.");
      return;
    }
    try {
      const result = await sendAdminCommand(session, command);
      if (!result.ok) {
        toast.error(result.message || "The relay refused the command.");
        return;
      }
      setPending((previous) => [
        ...previous,
        { requestId: result.requestId, summary, sentAt: Date.now() },
      ]);
      // Acks clear their pending row; stragglers age out.
      window.setTimeout(() => {
        setPending((previous) =>
          previous.filter(
            (entry) => Date.now() - entry.sentAt < ACK_TIMEOUT_MS * 4,
          ),
        );
      }, ACK_TIMEOUT_MS * 4);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not send the command.",
      );
    }
  };

  return { send, pending, acks };
}

export function AgentAdminPanel({
  admin,
}: {
  admin: ReturnType<typeof useAdminCommands>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium">Create & manage</h2>
        <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
          {open ? (
            <X aria-hidden className="mr-1 h-4 w-4" />
          ) : (
            <Plus aria-hidden className="mr-1 h-4 w-4" />
          )}
          {open ? "Close" : "New agent"}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Commands are sealed (NIP-44) and applied by your Buzz Desktop — the
        same create, harness, and lifecycle paths its own dialog uses.
      </p>
      <PendingList pending={admin.pending} acks={admin.acks} />
      {open && <CreateAgentForm admin={admin} />}
    </section>
  );
}

function PendingList({
  pending,
  acks,
}: {
  pending: PendingCommand[];
  acks: Map<string, AdminAckEnvelope>;
}) {
  if (pending.length === 0) {
    return null;
  }
  return (
    <ul className="space-y-1">
      {pending.map((entry) => {
        const ack = acks.get(entry.requestId);
        const timedOut = !ack && Date.now() - entry.sentAt > ACK_TIMEOUT_MS;
        return (
          <li
            key={entry.requestId}
            className="flex items-center gap-2 rounded-md bg-accent/40 px-2 py-1.5 text-xs"
          >
            <span
              className={
                ack
                  ? ack.ok
                    ? "h-2 w-2 shrink-0 rounded-full bg-emerald-500"
                    : "h-2 w-2 shrink-0 rounded-full bg-red-500"
                  : "h-2 w-2 shrink-0 animate-pulse rounded-full bg-muted-foreground/50"
              }
            />
            <span className="min-w-0 flex-1 truncate">
              {entry.summary}
              {ack && !ack.ok && (
                <span className="text-red-400"> — {ack.error ?? "failed"}</span>
              )}
              {timedOut && (
                <span className="text-amber-400">
                  {" "}
                  — no desktop responded. Is Buzz running?
                </span>
              )}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {ack ? (ack.ok ? "applied" : "error") : timedOut ? "?" : "sent"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function CreateAgentForm({
  admin,
}: {
  admin: ReturnType<typeof useAdminCommands>;
}) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [presetId, setPresetId] = useState("claude");
  const [customCommand, setCustomCommand] = useState("");
  const [customArgs, setCustomArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [respondTo, setRespondTo] = useState("owner-only");
  const [startOnLaunch, setStartOnLaunch] = useState(true);
  const [busy, setBusy] = useState(false);

  const parseEnv = (): Record<string, string> | undefined | null => {
    const trimmed = envText.trim();
    if (!trimmed) {
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const line of trimmed.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) {
        toast.error(`Env line is not KEY=value: ${line}`);
        return null;
      }
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    return out;
  };

  const submit = async () => {
    if (!name.trim() || !prompt.trim() || busy) {
      return;
    }
    const harness = harnessFromSelection(
      presetId === "__custom" ? null : presetId,
      customCommand,
      customArgs,
    );
    if (presetId === "__custom" && !harness) {
      toast.error("A custom harness needs a command.");
      return;
    }
    const envVars = parseEnv();
    if (envVars === null) {
      return;
    }
    setBusy(true);
    try {
      await admin.send(
        {
          action: "create",
          request: {
            name: name.trim(),
            systemPrompt: prompt.trim(),
            ...(model.trim() ? { model: model.trim() } : {}),
            ...(provider.trim() ? { provider: provider.trim() } : {}),
            ...(harness ? { harness } : {}),
            ...(envVars ? { envVars } : {}),
            respondTo: respondTo as "owner-only" | "anyone" | "allowlist",
            spawnAfterCreate: true,
            startOnAppLaunch: startOnLaunch,
          },
        },
        `Create ${name.trim()}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">Name</span>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Night Shift"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">System prompt</span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          rows={5}
          className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-sm"
          placeholder="What this agent does day to day…"
        />
      </label>
      <div className="flex gap-2">
        <label className="min-w-0 flex-1 space-y-1">
          <span className="text-sm text-muted-foreground">Model</span>
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="e.g. glm-5.3"
          />
        </label>
        <label className="min-w-0 flex-1 space-y-1">
          <span className="text-sm text-muted-foreground">Provider</span>
          <Input
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            placeholder="e.g. zai"
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">Harness</span>
        <select
          value={presetId}
          onChange={(event) => setPresetId(event.target.value)}
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          aria-label="Harness"
        >
          {PRESET_HARNESSES.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
          <option value="__custom">Custom command…</option>
        </select>
      </label>
      {presetId === "__custom" && (
        <div className="flex gap-2">
          <label className="min-w-0 flex-1 space-y-1">
            <span className="text-sm text-muted-foreground">Command</span>
            <Input
              value={customCommand}
              onChange={(event) => setCustomCommand(event.target.value)}
              placeholder="bun run seat.ts"
            />
          </label>
          <label className="min-w-0 flex-1 space-y-1">
            <span className="text-sm text-muted-foreground">Args</span>
            <Input
              value={customArgs}
              onChange={(event) => setCustomArgs(event.target.value)}
              placeholder="--a --b"
            />
          </label>
        </div>
      )}
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">
          Env vars (KEY=value per line)
        </span>
        <textarea
          value={envText}
          onChange={(event) => setEnvText(event.target.value)}
          rows={2}
          className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 font-mono text-xs"
        />
      </label>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Respond to
          <select
            value={respondTo}
            onChange={(event) => setRespondTo(event.target.value)}
            className="rounded-md border border-input bg-card px-2 py-1 text-sm"
            aria-label="Respond to"
          >
            <option value="owner-only">owner only</option>
            <option value="anyone">anyone</option>
            <option value="allowlist">allowlist</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={startOnLaunch}
            onChange={(event) => setStartOnLaunch(event.target.checked)}
          />
          Start on app launch
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" disabled={busy || !name.trim() || !prompt.trim()} onClick={() => void submit()}>
          {busy ? "Sending…" : "Create agent"}
        </Button>
      </div>
    </div>
  );
}

/** Row-level lifecycle actions for a registered agent. */
export function AgentRowActions({
  pubkey,
  name,
  admin,
}: {
  pubkey: string;
  name: string;
  admin: ReturnType<typeof useAdminCommands>;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const busy = useMemo(
    () =>
      admin.pending.some(
        (entry) => entry.summary.includes(name) && !admin.acks.has(entry.requestId),
      ),
    [admin.pending, admin.acks, name],
  );
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => void admin.send({ action: "start", request: { pubkey } }, `Start ${name}`)}
      >
        Start
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => void admin.send({ action: "stop", request: { pubkey } }, `Stop ${name}`)}
      >
        Stop
      </Button>
      {confirmingDelete ? (
        <>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setConfirmingDelete(false);
              void admin.send(
                {
                  action: "delete",
                  request: { pubkey, forceRemoteDelete: true },
                },
                `Delete ${name}`,
              );
            }}
          >
            Confirm delete
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
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
  );
}
