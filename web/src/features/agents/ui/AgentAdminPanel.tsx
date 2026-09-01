import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import type { RelaySession } from "@/shared/api/relay-session";
import { sendAdminCommand, useAdminAckWatcher } from "../lib/adminCommandsSend";
import {
  harnessFromSelection,
  type AdminAckEnvelope,
  type AdminCommand,
} from "../lib/adminCommands";
import type { AgentRegistryEntry } from "../lib/agentRegistry";
import type { PersonaDefinition } from "../lib/personas";
import type { DesktopCatalog } from "../lib/desktopCatalog";
import {
  buildUpdateCommand,
  prefillEditForm,
  type EditAgentFormValue,
} from "../lib/editAgentRequest";

/**
 * Remote agent administration (kinds 24201/24202): owner commands the web
 * seals and sends, the owner's Buzz Desktop applies through its own save
 * paths, acks flow back. Field surface mirrors the desktop's agent dialog —
 * "the same as what is available in the desktop buzz".
 *
 * The harness dropdown prefers the live kind-30180 desktop catalog (custom
 * harnesses included) and falls back to a static preset mirror until a
 * desktop publishes one. Commands can target one machine (`target`) so a
 * two-desktop owner never mints an agent twice.
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
  send: (
    command: AdminCommand,
    summary: string,
    options?: { target?: string },
  ) => Promise<string | null>;
  pending: PendingCommand[];
  acks: Map<string, AdminAckEnvelope>;
} {
  const acks = useAdminAckWatcher(session, status);
  const [pending, setPending] = useState<PendingCommand[]>([]);

  const send = async (
    command: AdminCommand,
    summary: string,
    options?: { target?: string },
  ): Promise<string | null> => {
    if (!session) {
      toast.error("Not connected to the relay.");
      return null;
    }
    try {
      const result = await sendAdminCommand(session, command, options);
      if (!result.ok) {
        toast.error(result.message || "The relay refused the command.");
        return null;
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
      return result.requestId;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not send the command.",
      );
      return null;
    }
  };

  return { send, pending, acks };
}

export function AgentAdminPanel({
  admin,
  catalogs,
}: {
  admin: ReturnType<typeof useAdminCommands>;
  catalogs: DesktopCatalog[];
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
        Commands are sealed (NIP-44) and applied by your Buzz Desktop — the same
        create, harness, and lifecycle paths its own dialog uses.
      </p>
      <PendingList pending={admin.pending} acks={admin.acks} />
      {open && <CreateAgentForm admin={admin} catalogs={catalogs} />}
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

/** Availability suffix shown next to a harness label, when not "available". */
function availabilitySuffix(availability: string): string {
  if (availability === "not-installed") {
    return " (not installed)";
  }
  if (availability === "adapter-missing") {
    return " (adapter missing)";
  }
  return "";
}

/**
 * Union of every published catalog's harnesses, custom-first then presets,
 * deduped by id (custom wins a conflict — it is what the owner actually
 * runs). Options stay selectable regardless of availability: the desktop is
 * the executor and its state may differ by the time the command lands.
 */
function mergedCatalogHarnesses(
  catalogs: DesktopCatalog[],
): { id: string; label: string; availability: string }[] {
  const byId = new Map<
    string,
    { id: string; label: string; availability: string; rank: number }
  >();
  const rank = (source: string) => (source === "custom" ? 0 : 1);
  for (const catalog of catalogs) {
    for (const harness of catalog.harnesses) {
      const existing = byId.get(harness.id);
      if (!existing || rank(harness.source) < existing.rank) {
        byId.set(harness.id, {
          id: harness.id,
          label: harness.label,
          availability: harness.availability,
          rank: rank(harness.source),
        });
      }
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map(({ id, label, availability }) => ({ id, label, availability }));
}

/**
 * Harness dropdown. Live catalog when at least one desktop published a
 * kind-30180; static preset mirror otherwise, with a hint about the live list.
 * `includeKeep` (edit mode) prepends a no-change option so the current
 * harness survives unless the user picks one.
 */
function HarnessSelect({
  value,
  onChange,
  catalogs,
  ariaLabel,
  includeKeep,
}: {
  value: string;
  onChange: (next: string) => void;
  catalogs: DesktopCatalog[];
  ariaLabel: string;
  includeKeep?: boolean;
}) {
  const live = mergedCatalogHarnesses(catalogs);
  return (
    <div className="block space-y-1">
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">Harness</span>
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          aria-label={ariaLabel}
        >
          {includeKeep && (
            <option value="__keep">Keep current (unchanged)</option>
          )}
          {live.length > 0
            ? live.map((harness) => (
                <option key={harness.id} value={harness.id}>
                  {harness.label}
                  {availabilitySuffix(harness.availability)}
                </option>
              ))
            : PRESET_HARNESSES.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
          <option value="__custom">Custom command…</option>
        </select>
      </label>
      {live.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Live harness list appears once your desktop publishes its catalog.
        </p>
      )}
    </div>
  );
}

function CreateAgentForm({
  admin,
  catalogs,
}: {
  admin: ReturnType<typeof useAdminCommands>;
  catalogs: DesktopCatalog[];
}) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [presetId, setPresetId] = useState(
    mergedCatalogHarnesses(catalogs)[0]?.id ?? "claude",
  );
  const [customCommand, setCustomCommand] = useState("");
  const [customArgs, setCustomArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [respondTo, setRespondTo] = useState("owner-only");
  const [startOnLaunch, setStartOnLaunch] = useState(true);
  const [busy, setBusy] = useState(false);
  const machines = useMemo(() => catalogs.map((c) => c.machine), [catalogs]);
  const [applyOn, setApplyOn] = useState(machines[0] ?? "");

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
        // Machine targeting: exactly one desktop → silent target; several →
        // the selected one; none → legacy broadcast.
        machines.length === 1
          ? { target: machines[0] }
          : machines.length >= 2 && applyOn
            ? { target: applyOn }
            : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="block space-y-1">
        <span className="block text-sm text-muted-foreground">Name</span>
        <Input
          aria-label="Name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Night Shift"
        />
      </div>
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
        <div className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm text-muted-foreground">Model</span>
          <Input
            aria-label="Model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="e.g. glm-5.3"
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm text-muted-foreground">Provider</span>
          <Input
            aria-label="Provider"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            placeholder="e.g. zai"
          />
        </div>
      </div>
      <HarnessSelect
        value={presetId}
        onChange={setPresetId}
        catalogs={catalogs}
        ariaLabel="Harness"
      />
      {presetId === "__custom" && (
        <div className="flex gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <span className="block text-sm text-muted-foreground">Command</span>
            <Input
              aria-label="Command"
              value={customCommand}
              onChange={(event) => setCustomCommand(event.target.value)}
              placeholder="bun run seat.ts"
            />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <span className="block text-sm text-muted-foreground">Args</span>
            <Input
              aria-label="Args"
              value={customArgs}
              onChange={(event) => setCustomArgs(event.target.value)}
              placeholder="--a --b"
            />
          </div>
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
      {machines.length >= 2 && (
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Apply on
          <select
            value={applyOn}
            onChange={(event) => setApplyOn(event.target.value)}
            className="rounded-md border border-input bg-card px-2 py-1 text-sm"
            aria-label="Apply on machine"
          >
            {machines.map((machine) => (
              <option key={machine} value={machine}>
                {machine}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">
            Only that desktop creates the agent.
          </span>
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          disabled={busy || !name.trim() || !prompt.trim()}
          onClick={() => void submit()}
        >
          {busy ? "Sending…" : "Create agent"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Edit form for one registered agent, prefilled from its 30177 entry (and its
 * 30175 definition when definition-linked). Only changed fields are sent; on
 * an ok ack the form toasts and collapses.
 */
export function EditAgentForm({
  admin,
  entry,
  persona,
  catalogs,
  onClose,
}: {
  admin: ReturnType<typeof useAdminCommands>;
  entry: AgentRegistryEntry;
  persona: PersonaDefinition | null;
  catalogs: DesktopCatalog[];
  onClose: () => void;
}) {
  const prefill = useMemo(
    () => prefillEditForm(entry, persona),
    [entry, persona],
  );
  const [value, setValue] = useState<EditAgentFormValue>(prefill);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);

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
      toast.success(`Updated ${prefill.name}`);
      onClose();
    } else {
      toast.error(ack.error || "The desktop rejected the update.");
      setRequestId(null);
    }
  }, [ack, onClose, prefill.name]);

  const submit = async () => {
    if (busy) {
      return;
    }
    const built = buildUpdateCommand(entry, prefill, value);
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    setBusy(true);
    try {
      const id = await admin.send(built.command, `Update ${prefill.name}`);
      setRequestId(id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border border-border bg-background/40 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Edit {prefill.name}</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>
          <X aria-hidden className="h-4 w-4" />
        </Button>
      </div>
      {prefill.personaLinked && (
        <p className="rounded-md bg-accent/40 px-2 py-1 text-xs text-muted-foreground">
          Definition-linked agent — name, prompt, model, and provider come from
          its persona definition and are shown for context. Changes here pin
          them on this instance.
        </p>
      )}
      <div className="block space-y-1">
        <span className="block text-sm text-muted-foreground">Name</span>
        <Input
          aria-label="Name"
          value={value.name}
          onChange={(event) => set("name", event.target.value)}
        />
      </div>
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">System prompt</span>
        <textarea
          value={value.systemPrompt}
          onChange={(event) => set("systemPrompt", event.target.value)}
          rows={5}
          className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-sm"
        />
      </label>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm text-muted-foreground">Model</span>
          <Input
            aria-label="Model"
            value={value.model}
            onChange={(event) => set("model", event.target.value)}
            placeholder="e.g. glm-5.3"
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm text-muted-foreground">Provider</span>
          <Input
            aria-label="Provider"
            value={value.provider}
            onChange={(event) => set("provider", event.target.value)}
            placeholder="e.g. zai"
          />
        </div>
      </div>
      <div className="flex gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm text-muted-foreground">
            Parallelism
          </span>
          <Input
            aria-label="Parallelism"
            value={value.parallelism}
            onChange={(event) => set("parallelism", event.target.value)}
            placeholder="e.g. 3"
            inputMode="numeric"
          />
        </div>
        <label className="min-w-0 flex-1 space-y-1">
          <span className="text-sm text-muted-foreground">Respond to</span>
          <select
            value={value.respondTo}
            onChange={(event) =>
              set(
                "respondTo",
                event.target.value as EditAgentFormValue["respondTo"],
              )
            }
            className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
            aria-label="Respond to"
          >
            <option value="owner-only">owner only</option>
            <option value="anyone">anyone</option>
            <option value="allowlist">allowlist</option>
          </select>
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">
          Allowlist (64-hex pubkeys, one per line)
        </span>
        <textarea
          value={value.respondToAllowlist}
          onChange={(event) => set("respondToAllowlist", event.target.value)}
          rows={2}
          className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 font-mono text-xs"
        />
      </label>
      <HarnessSelect
        value={value.harnessId}
        onChange={(next) => set("harnessId", next)}
        catalogs={catalogs}
        ariaLabel="Harness"
        includeKeep
      />
      {value.harnessId === "__custom" && (
        <div className="flex gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <span className="block text-sm text-muted-foreground">Command</span>
            <Input
              aria-label="Command"
              value={value.customCommand}
              onChange={(event) => set("customCommand", event.target.value)}
              placeholder="bun run seat.ts"
            />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <span className="block text-sm text-muted-foreground">Args</span>
            <Input
              aria-label="Args"
              value={value.customArgs}
              onChange={(event) => set("customArgs", event.target.value)}
              placeholder="--a --b"
            />
          </div>
        </div>
      )}
      <label className="block space-y-1">
        <span className="text-sm text-muted-foreground">
          Replace env vars (KEY=value per line — leave blank to keep current)
        </span>
        <textarea
          value={value.envText}
          onChange={(event) => set("envText", event.target.value)}
          rows={2}
          className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 font-mono text-xs"
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        Start on app launch
        <select
          value={value.startOnAppLaunch}
          onChange={(event) =>
            set(
              "startOnAppLaunch",
              event.target.value as EditAgentFormValue["startOnAppLaunch"],
            )
          }
          className="rounded-md border border-input bg-card px-2 py-1 text-sm"
          aria-label="Start on app launch"
        >
          <option value="keep">keep current</option>
          <option value="on">on</option>
          <option value="off">off</option>
        </select>
      </label>
      <p className="text-xs text-muted-foreground">
        Only changed fields are sent. Avatar and turn timeouts are create-time
        or desktop-dialog fields (protocol limit) and are not editable here.
      </p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void submit()}>
          {busy ? "Sending…" : "Save changes"}
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
  onEdit,
}: {
  pubkey: string;
  name: string;
  admin: ReturnType<typeof useAdminCommands>;
  onEdit?: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const busy = useMemo(
    () =>
      admin.pending.some(
        (entry) =>
          entry.summary.includes(name) && !admin.acks.has(entry.requestId),
      ),
    [admin.pending, admin.acks, name],
  );
  return (
    <div className="flex items-center gap-1">
      {onEdit && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
          Edit
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() =>
          void admin.send(
            { action: "start", request: { pubkey } },
            `Start ${name}`,
          )
        }
      >
        Start
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() =>
          void admin.send(
            { action: "stop", request: { pubkey } },
            `Stop ${name}`,
          )
        }
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
  );
}
