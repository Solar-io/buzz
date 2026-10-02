import { useState } from "react";
import { Input } from "@/shared/ui/input";
import {
  SettingSelect,
  type SettingOption,
  type SettingSelectProps,
} from "./SettingSelect";

export interface ModelChoice extends SettingOption {
  count?: number;
}
export interface ModelSelectProps
  extends Omit<SettingSelectProps, "options" | "groups" | "children"> {
  inUse?: readonly ModelChoice[];
  discovered?: readonly SettingOption[];
  mesh?: readonly SettingOption[];
}

/** Searchable, supplied model catalogs; no static or inferred model list. */
export function ModelSelect({
  inUse = [],
  discovered = [],
  mesh = [],
  ...props
}: ModelSelectProps) {
  const [search, setSearch] = useState("");
  const [custom, setCustom] = useState(false);
  const [modelId, setModelId] = useState(props.value ?? "");
  const unavailable = props.locked || props.offline || props.disabled;
  const matches = (option: SettingOption) =>
    `${option.label} ${option.value}`
      .toLowerCase()
      .includes(search.toLowerCase());
  const groups = [
    {
      label: "In use on your agents",
      options: inUse.filter(matches).map((model) => ({
        ...model,
        label: `${model.label}${model.count === undefined ? "" : ` · ${model.count} agents`}`,
      })),
    },
    { label: "Runtime-discovered", options: discovered.filter(matches) },
    { label: "Mesh", options: mesh.filter(matches) },
  ].filter((group) => group.options.length > 0);
  return (
    <div className="min-w-0 space-y-2">
      <Input
        aria-label={`Search ${props.label} models`}
        placeholder="Search models…"
        value={search}
        disabled={unavailable}
        onChange={(event) => setSearch(event.target.value)}
      />
      <SettingSelect
        {...props}
        groups={groups}
        options={[{ value: "__other_model", label: "Other model id…" }]}
        onChange={(value) => {
          if (value === "__other_model") {
            setCustom(true);
            setModelId(props.value ?? "");
          } else {
            setCustom(false);
            props.onChange(value);
          }
        }}
      >
        {custom && (
          <form
            className="flex min-w-0 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!unavailable && modelId.trim()) {
                props.onChange(modelId.trim());
                setCustom(false);
              }
            }}
          >
            <Input
              aria-label="Other model id"
              value={modelId}
              placeholder="Model id"
              disabled={unavailable}
              onChange={(event) => setModelId(event.target.value)}
            />
            <button
              type="submit"
              disabled={unavailable || !modelId.trim()}
              className="rounded-lg border border-input px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Use
            </button>
          </form>
        )}
      </SettingSelect>
    </div>
  );
}
