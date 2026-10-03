import { ModelSelect } from "@/shared/ui/settings/ModelSelect";
import { SettingSelect } from "@/shared/ui/settings/SettingSelect";
import type { RosterRow } from "../../../lib/roster";
import type { ApiKeySelection } from "../../../lib/providerApiKey";
import { providerSecretEnvVar } from "../../../lib/providerApiKey";
import { ProviderApiKeyField } from "../../../ui/ProviderApiKeyField";
import { UNREPORTED } from "./agentSettingsFields";
import type { CardFields } from "./cardTypes";

/** No inferred provider controls or editable effort until their desktop phase. */
export function ModelThinkingCard({
  row,
  fields,
  models,
  apiKey,
  onApiKey,
}: {
  row: RosterRow;
  fields: CardFields;
  models: string[];
  apiKey: ApiKeySelection;
  onApiKey: (value: ApiKeySelection) => void;
}) {
  const runtime = fields.value("harness");
  let runtimeId = "";
  if (typeof runtime === "string" && runtime !== UNREPORTED) {
    try {
      runtimeId = JSON.parse(runtime).runtimeId ?? "";
    } catch {
      /* A blind runtime has no inferred provider. */
    }
  }
  const providerVisible = runtimeId === "buzz-agent" || runtimeId === "goose";
  const provider = fields.value("provider");
  const secret = providerSecretEnvVar(
    provider === UNREPORTED ? "" : String(provider),
  );
  const common = {
    source: "desktop default",
    machine: fields.machine,
    disabled: fields.disabled,
    inheritLocked: true,
    takesEffect: "on restart",
  };
  const model = (
    <ModelSelect
      {...common}
      label="Model"
      value={
        fields.value("model") === UNREPORTED
          ? null
          : String(fields.value("model"))
      }
      defaultValue=""
      defaultLabel="Desktop default"
      unreported={fields.value("model") === UNREPORTED}
      dirty={fields.dirty("model")}
      disabled={fields.disabled || row.personaLinked}
      inUse={models.map((value) => ({ value, label: value }))}
      onChange={(next) => fields.edit("model", next)}
    />
  );
  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-card p-4"
      data-testid="model-thinking-card"
    >
      <h2 className="text-sm font-semibold">Model &amp; thinking</h2>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        {fields.value("model") === UNREPORTED ? (
          <details>
            <summary className="min-h-11 cursor-pointer text-sm">
              Set without seeing the current value
            </summary>
            {model}
          </details>
        ) : (
          model
        )}
        <SettingSelect
          {...common}
          label="Effort"
          value={row.entry.effort?.acp ?? null}
          defaultValue=""
          locked
          defaultLabel="Not published"
          options={
            row.entry.effort?.acp
              ? [{ value: row.entry.effort.acp, label: row.entry.effort.acp }]
              : []
          }
          onChange={() => {}}
        />
      </div>
      {row.personaLinked && (
        <p className="text-xs text-muted-foreground">
          Model and provider come from the definition. Edit them in Library.
        </p>
      )}
      {providerVisible && (
        <details className="space-y-3">
          <summary className="min-h-11 cursor-pointer text-sm font-medium">
            Provider &amp; API key · set without seeing the current key
          </summary>
          <SettingSelect
            {...common}
            label="Provider"
            value={provider === UNREPORTED ? null : String(provider)}
            defaultValue=""
            defaultLabel="Desktop default"
            unreported={provider === UNREPORTED}
            dirty={fields.dirty("provider")}
            disabled={fields.disabled || row.personaLinked}
            options={["anthropic", "openai", "openai-compat", "openrouter"].map(
              (value) => ({ value, label: value }),
            )}
            onChange={(next) => {
              onApiKey({ kind: "keep" });
              fields.edit("provider", next);
            }}
          />
          {secret && (
            <fieldset disabled={fields.disabled || fields.controlsLocked}>
              <ProviderApiKeyField
                label={secret.label}
                envVar={secret.envVar}
                value={apiKey}
                onChange={onApiKey}
                linked={row.personaLinked}
              />
            </fieldset>
          )}
        </details>
      )}
    </section>
  );
}
