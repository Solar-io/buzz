import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import {
  buildCreateCommand,
  type CreateAgentFormValue,
} from "../lib/createAgentRequest";
import type { DesktopCatalog } from "../lib/desktopCatalog";
import type { useAdminCommands } from "./AgentAdminPanel";
import { mergedCatalogHarnesses } from "./HarnessSelect";
import {
  AccessFields,
  EnvFields,
  IdentityFields,
  ModelProviderFields,
  RuntimeFields,
} from "./AgentFormSections";

/**
 * Create flow as a right-pane swap (not a modal): five sections is too tall
 * for a phone modal, and both forms share AgentFormSections anyway. Machine
 * targeting is preserved from the old inline form: exactly one desktop →
 * silent target; several → the selected machine; none → legacy broadcast.
 * On an ok ack carrying agentPubkey the roster auto-selects the new agent.
 */
export function AgentCreateForm({
  admin,
  catalogs,
  registryModels,
  onCreated,
  onCancel,
}: {
  admin: ReturnType<typeof useAdminCommands>;
  catalogs: DesktopCatalog[];
  registryModels: string[];
  onCreated: (pubkey: string) => void;
  onCancel: () => void;
}) {
  const machines = useMemo(() => catalogs.map((c) => c.machine), [catalogs]);
  const [value, setValue] = useState<CreateAgentFormValue>(() => ({
    name: "",
    systemPrompt: "",
    avatarUrl: "",
    model: "",
    provider: "",
    parallelism: "",
    respondTo: "owner-only",
    respondToAllowlist: [],
    harnessId: mergedCatalogHarnesses(catalogs)[0]?.id ?? "claude",
    customCommand: "",
    customArgs: "",
    envRows: [],
    startOnAppLaunch: true,
  }));
  const [applyOn, setApplyOn] = useState(machines[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);

  const set = <K extends keyof CreateAgentFormValue>(
    key: K,
    next: CreateAgentFormValue[K],
  ) => setValue((previous) => ({ ...previous, [key]: next }));

  const ack = requestId ? admin.acks.get(requestId) : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ack is the only re-trigger; value.name/onCreated/onCancel are captured deliberately for this one-shot ack handling
  useEffect(() => {
    if (!ack) {
      return;
    }
    if (ack.ok) {
      toast.success(`Created ${value.name.trim()}`);
      if (ack.agentPubkey) {
        onCreated(ack.agentPubkey);
      } else {
        onCancel();
      }
    } else {
      toast.error(ack.error || "The desktop rejected the create.");
      setRequestId(null);
    }
  }, [ack]);

  const submit = async () => {
    if (busy || requestId !== null) {
      return;
    }
    const built = buildCreateCommand(value);
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    setBusy(true);
    try {
      const id = await admin.send(
        built.command,
        `Create ${value.name.trim()}`,
        machines.length === 1
          ? { target: machines[0] }
          : machines.length >= 2 && applyOn
            ? { target: applyOn }
            : undefined,
      );
      setRequestId(id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <IdentityFields
        name={value.name}
        onNameChange={(next) => set("name", next)}
        systemPrompt={value.systemPrompt}
        onSystemPromptChange={(next) => set("systemPrompt", next)}
        avatarUrl={value.avatarUrl}
        onAvatarUrlChange={(next) => set("avatarUrl", next)}
      />
      <ModelProviderFields
        model={value.model}
        onModelChange={(next) => set("model", next)}
        provider={value.provider}
        onProviderChange={(next) => set("provider", next)}
        registryModels={registryModels}
        harnessId={value.harnessId}
        onHarnessChange={(next) => set("harnessId", next)}
        customCommand={value.customCommand}
        onCustomCommandChange={(next) => set("customCommand", next)}
        customArgs={value.customArgs}
        onCustomArgsChange={(next) => set("customArgs", next)}
        catalogs={catalogs}
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
        onChange={(next) => set("envRows", next)}
        dirty={value.envRows.length > 0}
        editMode={false}
      />
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={value.startOnAppLaunch}
          onChange={(event) => set("startOnAppLaunch", event.target.checked)}
        />
        Start on app launch
      </label>
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
      {requestId !== null && (
        <p className="rounded-md border border-border bg-accent/30 px-2 py-1.5 text-xs text-muted-foreground">
          Sent — waiting for your desktop to apply it. Creating again before it
          responds can mint the same agent twice.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={
            busy ||
            requestId !== null ||
            !value.name.trim() ||
            !value.systemPrompt.trim()
          }
          onClick={() => void submit()}
        >
          {busy
            ? "Sending…"
            : requestId !== null
              ? "Waiting for desktop…"
              : "Create agent"}
        </Button>
      </div>
    </div>
  );
}
