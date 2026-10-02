import { useEffect, useMemo, useState } from "react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { ModelSelect } from "@/shared/ui/settings/ModelSelect";
import { SettingSelect } from "@/shared/ui/settings/SettingSelect";
import { createControlsEnabled } from "../lib/adminCommandCapabilities";
import type { DesktopCatalog } from "../lib/desktopCatalog";
import type { useAdminCommands } from "../ui/AgentAdminPanel";
import {
  AccessFields,
  EnvFields,
  IdentityFields,
} from "../ui/AgentFormSections";
import { SettingsNavGuard } from "./ui/SettingsNavGuard";
import { blankAgentDefaults } from "./blankAgentDefaults";
import { CreateAgentCard } from "./CreateAgentCard";
import { CreateRuntimeCard } from "./CreateRuntimeCard";
import { useBlankAgentCreate } from "./useBlankAgentCreate";

/** Blank creation uses settings cards and the existing owner-signed create path. */
export function CreateAgentScreen({
  admin,
  catalogs,
  registryModels,
  onCreated,
  onCancel,
  onDraftChange,
}: {
  admin: ReturnType<typeof useAdminCommands>;
  catalogs: DesktopCatalog[];
  registryModels: string[];
  onCreated: (pubkey: string) => void;
  onCancel: () => void;
  onDraftChange?: (dirty: boolean, busy: boolean) => void;
}) {
  const initial = useMemo(blankAgentDefaults, []);
  const [value, setValue] = useState(initial);
  const [applyOn, setApplyOn] = useState(catalogs[0]?.machine ?? "");
  const [customProvider, setCustomProvider] = useState(false);
  const target =
    catalogs.find((catalog) => catalog.machine === applyOn) ?? catalogs[0];
  const timeoutsEnabled = createControlsEnabled(
    catalogs,
    target?.machine ?? null,
  );
  const create = useBlankAgentCreate({
    admin,
    value,
    target: target?.machine ?? null,
    timeoutsEnabled,
    onCreated,
  });
  const set = <K extends keyof typeof value>(key: K, next: (typeof value)[K]) =>
    setValue((previous) => ({ ...previous, [key]: next }));
  const changed = Object.keys(initial).filter(
    (key) =>
      JSON.stringify(value[key as keyof typeof value]) !==
      JSON.stringify(initial[key as keyof typeof initial]),
  ).length;
  useEffect(() => {
    onDraftChange?.(changed > 0, create.busy);
  }, [changed, create.busy, onDraftChange]);
  return (
    <div className="min-w-0 space-y-4" data-testid="blank-agent-create">
      <p className="text-sm text-muted-foreground">
        Give your agent instructions. It starts after Buzz Desktop creates it.
      </p>
      <fieldset
        disabled={create.disabled}
        className="min-w-0 space-y-4 disabled:opacity-70"
      >
        <CreateAgentCard title="Identity & instructions">
          <IdentityFields
            name={value.name}
            onNameChange={(next) => set("name", next)}
            systemPrompt={value.systemPrompt}
            onSystemPromptChange={(next) => set("systemPrompt", next)}
            avatarUrl={value.avatarUrl}
            onAvatarUrlChange={(next) => set("avatarUrl", next)}
          />
        </CreateAgentCard>
        <CreateAgentCard title="Model & thinking">
          <div className="grid gap-4 md:grid-cols-2">
            <ModelSelect
              label="Model"
              value={value.model || null}
              defaultValue=""
              defaultLabel="Runtime default"
              source="runtime"
              inUse={registryModels.map((model) => ({
                value: model,
                label: model,
              }))}
              onChange={(next) => set("model", next ?? "")}
            />
            {value.harnessId === "buzz-agent" && (
              <SettingSelect
                label="Provider"
                value={value.provider || null}
                defaultValue=""
                defaultLabel="Runtime default"
                source="runtime"
                options={["anthropic", "openai", "openrouter"].map(
                  (provider) => ({ value: provider, label: provider }),
                )}
                trailingOptions={[
                  { value: "__custom", label: "Other provider…" },
                ]}
                onChange={(next) => {
                  setCustomProvider(next === "__custom");
                  if (next !== "__custom") set("provider", next ?? "");
                }}
              />
            )}
          </div>
          {customProvider && value.harnessId === "buzz-agent" && (
            <Input
              aria-label="Other provider"
              placeholder="Provider id"
              value={value.provider}
              onChange={(event) => set("provider", event.target.value)}
            />
          )}
        </CreateAgentCard>
        <CreateRuntimeCard
          value={value}
          set={set}
          catalogs={target ? [target] : []}
          timeoutsEnabled={timeoutsEnabled}
          machine={target?.machine.replace(/\.local$/, "") ?? "your desktop"}
        />
        <CreateAgentCard title="Who can instruct">
          <AccessFields
            respondTo={value.respondTo}
            onRespondToChange={(next) => set("respondTo", next)}
            allowlist={value.respondToAllowlist}
            onAllowlistChange={(next) => set("respondToAllowlist", next)}
          />
        </CreateAgentCard>
        <CreateAgentCard title="Environment variables">
          <EnvFields
            rows={value.envRows}
            onChange={(next) => set("envRows", next)}
            dirty={value.envRows.length > 0}
            editMode={false}
          />
        </CreateAgentCard>
        {catalogs.length > 1 && (
          <label className="block space-y-1 text-sm">
            Create on
            <select
              aria-label="Create on"
              value={target?.machine}
              className="min-h-11 w-full rounded-lg border border-input bg-card px-3"
              onChange={(event) => setApplyOn(event.target.value)}
            >
              {catalogs.map((catalog) => (
                <option key={catalog.machine} value={catalog.machine}>
                  {catalog.machine.replace(/\.local$/, "")}
                </option>
              ))}
            </select>
          </label>
        )}
      </fieldset>
      {create.error && (
        <p role="alert" className="break-words text-sm text-coral-ink">
          {create.error}
        </p>
      )}
      {create.uncertain && (
        <p role="status" className="text-sm text-honey-ink">
          No answer from{" "}
          {target?.machine.replace(/\.local$/, "") ?? "your desktop"} — it may
          still apply. Check status after reload.
        </p>
      )}
      <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 rounded-xl border border-border bg-card p-3">
        <Button variant="outline" disabled={create.busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={
            create.disabled || !value.name.trim() || !value.systemPrompt.trim()
          }
          onClick={() => void create.submit()}
        >
          {create.sending
            ? "Sending…"
            : create.waiting
              ? "Waiting for desktop…"
              : "Create agent"}
        </Button>
      </div>
      <SettingsNavGuard
        count={changed}
        screenName="new agent"
        busy={create.busy}
        discard={() => setValue(initial)}
      />
    </div>
  );
}
