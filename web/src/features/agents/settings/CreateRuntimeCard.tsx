import { useId } from "react";
import { Input } from "@/shared/ui/input";
import { SettingSelect } from "@/shared/ui/settings/SettingSelect";
import { DurationSelect } from "@/shared/ui/settings/DurationSelect";
import type { CreateAgentFormValue } from "../lib/createAgentRequest";
import type { DesktopCatalog } from "../lib/desktopCatalog";
import {
  availabilitySuffix,
  mergedCatalogHarnesses,
  PRESET_HARNESSES,
} from "../ui/HarnessSelect";
import { CreateAgentCard } from "./CreateAgentCard";

export type SetCreateField = <K extends keyof CreateAgentFormValue>(
  key: K,
  value: CreateAgentFormValue[K],
) => void;

/** Runtime and turn-limit controls, using the shared W7 native pickers. */
export function CreateRuntimeCard({
  value,
  set,
  catalogs,
  timeoutsEnabled,
  machine,
}: {
  value: CreateAgentFormValue;
  set: SetCreateField;
  catalogs: DesktopCatalog[];
  timeoutsEnabled: boolean;
  machine: string;
}) {
  const live = mergedCatalogHarnesses(catalogs);
  const commandId = useId();
  const argsId = useId();
  const runtimes = live.length ? live : PRESET_HARNESSES;
  return (
    <CreateAgentCard title="Runtime">
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <SettingSelect
          label="Runtime"
          value={value.harnessId === "buzz-agent" ? null : value.harnessId}
          defaultValue="buzz-agent"
          defaultLabel="Buzz Agent"
          source="built in"
          options={[
            ...runtimes.map((runtime) => ({
              value: runtime.id,
              label:
                runtime.label +
                ("availability" in runtime
                  ? availabilitySuffix(String(runtime.availability))
                  : ""),
            })),
            { value: "__custom", label: "Custom command…" },
          ]}
          onChange={(next) => set("harnessId", next ?? "buzz-agent")}
        />
        <SettingSelect
          label="Turns at once"
          value={value.parallelism === "10" ? null : value.parallelism}
          defaultValue="10"
          source="built in"
          options={[1, 2, 3, 5, 10, 20].map((n) => ({
            value: String(n),
            label: String(n),
          }))}
          onChange={(next) => set("parallelism", next ?? "10")}
        />
        <DurationSelect
          label="Idle timeout"
          value={
            value.idleTimeoutSeconds === "900"
              ? null
              : Number(value.idleTimeoutSeconds)
          }
          defaultValue={900}
          source="built in"
          presets={[120, 300, 900, 1800, 3600]}
          locked={!timeoutsEnabled}
          machine={machine}
          onChange={(next) => set("idleTimeoutSeconds", String(next ?? 900))}
        />
        <DurationSelect
          label="Longest turn"
          value={
            value.maxTurnDurationSeconds === "43200"
              ? null
              : Number(value.maxTurnDurationSeconds)
          }
          defaultValue={43200}
          source="built in"
          presets={[1800, 3600, 7200, 14400, 43200]}
          locked={!timeoutsEnabled}
          machine={machine}
          onChange={(next) =>
            set("maxTurnDurationSeconds", String(next ?? 43200))
          }
        />
      </div>
      {value.harnessId === "__custom" && (
        <div className="grid gap-3 md:grid-cols-2">
          <label htmlFor={commandId} className="space-y-1 text-sm">
            Command
            <Input
              aria-label="Custom runtime command"
              id={commandId}
              value={value.customCommand}
              onChange={(event) => set("customCommand", event.target.value)}
            />
          </label>
          <label htmlFor={argsId} className="space-y-1 text-sm">
            Arguments
            <Input
              aria-label="Custom runtime arguments"
              id={argsId}
              value={value.customArgs}
              onChange={(event) => set("customArgs", event.target.value)}
            />
          </label>
        </div>
      )}
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.startOnAppLaunch}
          onChange={(event) => set("startOnAppLaunch", event.target.checked)}
        />
        Start with Buzz Desktop
      </label>
    </CreateAgentCard>
  );
}
