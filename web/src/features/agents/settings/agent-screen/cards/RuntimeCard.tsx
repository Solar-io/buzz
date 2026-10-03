import { useState } from "react";
import { SettingSelect } from "@/shared/ui/settings/SettingSelect";
import { DurationSelect } from "@/shared/ui/settings/DurationSelect";
import { Input } from "@/shared/ui/input";
import { Button } from "@/shared/ui/button";
import type { DesktopCatalog } from "../../../lib/desktopCatalog";
import {
  mergedCatalogHarnesses,
  PRESET_HARNESSES,
  availabilitySuffix,
} from "../../../ui/HarnessSelect";
import {
  IDLE_BUILTIN,
  LONGEST_BUILTIN,
  UNREPORTED,
} from "./agentSettingsFields";
import type { CardFields } from "./cardTypes";

/** Existing desktop update fields only; unreported settings remain blind. */
export function RuntimeCard({
  fields,
  catalogs,
}: {
  fields: CardFields;
  catalogs: DesktopCatalog[];
}) {
  const [custom, setCustom] = useState(false);
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const live = mergedCatalogHarnesses(
    catalogs.filter((catalog) => catalog.machine === fields.machine),
  );
  const runtime = fields.value("harness");
  const common = {
    source: "built in",
    machine: fields.machine,
    disabled: fields.disabled,
    takesEffect: "on restart",
  };
  const unknown = (
    field:
      | "harness"
      | "parallelism"
      | "startOnAppLaunch"
      | "idleTimeoutSeconds"
      | "maxTurnDurationSeconds",
  ) => fields.value(field) === UNREPORTED;
  const duration = (
    field: "idleTimeoutSeconds" | "maxTurnDurationSeconds",
    label: string,
    builtin: number,
    defaultLabel: string,
    presets: number[],
  ) => (
    <DurationSelect
      {...common}
      label={label}
      value={
        typeof fields.value(field) === "number"
          ? Number(fields.value(field))
          : null
      }
      defaultValue={builtin}
      defaultLabel={defaultLabel}
      presets={presets}
      dirty={fields.dirty(field)}
      originalLabel={fields.originalLabel?.(field)}
      unreported={unknown(field)}
      locked={fields.controlsLocked}
      onChange={(next) => fields.edit(field, next)}
    />
  );
  const runtimeControl = (
    <>
      <SettingSelect
        {...common}
        label="Runtime"
        value={runtime === UNREPORTED ? null : String(runtime)}
        defaultValue=""
        defaultLabel="Desktop default"
        inheritLocked
        unreported={unknown("harness")}
        dirty={fields.dirty("harness")}
        options={(live.length ? live : PRESET_HARNESSES).map((preset) => ({
          value: JSON.stringify({ kind: "preset", runtimeId: preset.id }),
          label:
            preset.label +
            ("availability" in preset
              ? availabilitySuffix(String(preset.availability))
              : ""),
        }))}
        trailingOptions={[{ value: "__custom", label: "Custom…" }]}
        onChange={(next) => {
          if (next === "__custom") setCustom(true);
          else {
            setCustom(false);
            fields.edit("harness", next);
          }
        }}
      />
      {custom && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!fields.disabled && command.trim()) {
              fields.edit(
                "harness",
                JSON.stringify({
                  kind: "custom",
                  command: command.trim(),
                  args: args.trim().split(/\s+/).filter(Boolean),
                }),
              );
              setCustom(false);
            }
          }}
        >
          <Input
            aria-label="Runtime command"
            placeholder="Command"
            value={command}
            disabled={fields.disabled}
            onChange={(event) => setCommand(event.target.value)}
          />
          <Input
            aria-label="Runtime arguments"
            placeholder="Arguments separated by spaces"
            value={args}
            disabled={fields.disabled}
            onChange={(event) => setArgs(event.target.value)}
          />
          <Button type="submit" disabled={fields.disabled || !command.trim()}>
            Use command
          </Button>
        </form>
      )}
    </>
  );
  const controls = [
    { field: "harness", control: runtimeControl },
    {
      field: "idleTimeoutSeconds",
      control: duration(
        "idleTimeoutSeconds",
        "Idle timeout",
        IDLE_BUILTIN,
        "15 min — built in",
        [300, 900, 1800, 3600],
      ),
    },
    {
      field: "maxTurnDurationSeconds",
      control: duration(
        "maxTurnDurationSeconds",
        "Longest turn",
        LONGEST_BUILTIN,
        "12 h — built in",
        [3600, 21600, 43200, 86400],
      ),
    },
    {
      field: "startOnAppLaunch",
      control: (
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 text-sm">
          <span>Start with Buzz Desktop</span>
          {unknown("startOnAppLaunch") ? (
            <SettingSelect
              {...common}
              label="Set start with Buzz Desktop"
              value={null}
              defaultValue="off"
              unreported
              inheritLocked
              locked={fields.controlsLocked}
              options={[
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
              onChange={(next) =>
                fields.edit("startOnAppLaunch", next === "on")
              }
            />
          ) : (
            <input
              aria-label="Start with Buzz Desktop"
              role="switch"
              aria-checked={fields.value("startOnAppLaunch") === true}
              type="checkbox"
              className="size-6"
              disabled={fields.disabled || fields.controlsLocked}
              checked={fields.value("startOnAppLaunch") === true}
              onChange={(event) =>
                fields.edit("startOnAppLaunch", event.target.checked)
              }
            />
          )}
        </div>
      ),
    },
    {
      field: "parallelism",
      control: (
        <SettingSelect
          {...common}
          label="Turns at once"
          value={
            fields.value("parallelism") === UNREPORTED
              ? null
              : String(fields.value("parallelism"))
          }
          defaultValue="1"
          defaultLabel="1"
          unreported={fields.value("parallelism") === UNREPORTED}
          inheritLocked
          dirty={fields.dirty("parallelism")}
          options={[1, 2, 4, 8, 16].map((n) => ({
            value: String(n),
            label: String(n),
          }))}
          onChange={(next) => fields.edit("parallelism", Number(next))}
        />
      ),
    },
  ] as const;
  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-card p-4"
      data-testid="runtime-card"
    >
      <h2 className="text-sm font-semibold">Runtime</h2>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        {controls
          .filter(({ field }) => !unknown(field))
          .map(({ field, control }) => (
            <div key={field} className="min-w-0">
              {control}
            </div>
          ))}
      </div>
      {controls.some(({ field }) => unknown(field)) && (
        <details className="space-y-4">
          <summary className="min-h-11 cursor-pointer text-sm font-medium">
            Set without seeing the current value
          </summary>
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            {controls
              .filter(({ field }) => unknown(field))
              .map(({ field, control }) => (
                <div key={field} className="min-w-0">
                  {control}
                </div>
              ))}
          </div>
        </details>
      )}
      <p className="text-xs text-muted-foreground">
        Runtime inheritance and additional command settings need a later Buzz
        Desktop update.
      </p>
    </section>
  );
}
