import { useState } from "react";
import { Input } from "@/shared/ui/input";
import { SettingSelect, type SettingSelectProps } from "./SettingSelect";

/** Readable duration label for a wire value in seconds. */
export function durationLabel(seconds: number): string {
  if (seconds % 3600 === 0)
    return `${seconds / 3600} ${seconds === 3600 ? "hour" : "hours"}`;
  if (seconds % 60 === 0)
    return `${seconds / 60} ${seconds === 60 ? "min" : "mins"}`;
  return `${seconds / 60} mins`;
}
/** Every numeric value and preset uses seconds, regardless of display units. */
export interface DurationSelectProps
  extends Omit<
    SettingSelectProps,
    "value" | "defaultValue" | "options" | "groups" | "onChange" | "children"
  > {
  value: number | null;
  defaultValue: number;
  presets: readonly number[];
  onChange: (seconds: number | null) => void;
}

/** Presets and custom minute/hour inputs, emitting whole seconds only. */
export function DurationSelect({
  value,
  defaultValue,
  presets,
  onChange,
  ...props
}: DurationSelectProps) {
  const [custom, setCustom] = useState(false);
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState(60);
  const unavailable = props.locked || props.offline || props.disabled;
  const seconds = Number(amount) * unit;
  const valid =
    amount.trim() !== "" && Number.isSafeInteger(seconds) && seconds > 0;
  const customValue = value !== null && !presets.includes(value);
  return (
    <SettingSelect
      {...props}
      value={
        custom || customValue
          ? "__custom_duration"
          : value === null
            ? null
            : String(value)
      }
      defaultValue={String(defaultValue)}
      defaultLabel={props.defaultLabel ?? durationLabel(defaultValue)}
      options={[
        ...presets.map((preset) => ({
          value: String(preset),
          label: durationLabel(preset),
        })),
        {
          value: "__custom_duration",
          label: customValue ? `${durationLabel(value)} · Custom…` : "Custom…",
        },
      ]}
      onChange={(next) => {
        if (next === "__custom_duration") {
          setCustom(true);
          setAmount(String((value ?? defaultValue) / 60));
          setUnit(60);
        } else {
          setCustom(false);
          onChange(next === null ? null : Number(next));
        }
      }}
    >
      {custom && (
        <form
          className="space-y-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (!unavailable && valid) {
              onChange(seconds);
              setCustom(false);
            }
          }}
        >
          <div className="flex min-w-0 gap-2">
            <Input
              className="min-h-11 md:min-h-9"
              aria-label={`${props.label} custom amount`}
              type="number"
              min="0"
              step="any"
              value={amount}
              disabled={unavailable}
              onChange={(event) => setAmount(event.target.value)}
            />
            <select
              aria-label={`${props.label} custom unit`}
              value={unit}
              disabled={unavailable}
              className="min-h-11 rounded-lg border border-input bg-background px-2 text-base focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
              onChange={(event) => setUnit(Number(event.target.value))}
            >
              <option value={60}>Minutes</option>
              <option value={3600}>Hours</option>
            </select>
            <button
              type="submit"
              disabled={unavailable || !valid}
              className="rounded-lg border border-input px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Use
            </button>
          </div>
          {amount !== "" && !valid && (
            <p role="alert" className="text-xs text-coral-ink">
              Enter a positive duration in whole seconds.
            </p>
          )}
        </form>
      )}
    </SettingSelect>
  );
}
