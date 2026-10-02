import { useId, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/shared/lib/cn";

export interface SettingOption {
  value: string;
  label: string;
}
export interface SettingOptionGroup {
  label: string;
  options: readonly SettingOption[];
}
export interface SettingSelectProps {
  label: string;
  /** null means inherit; defaultValue is the readable, resolved default. */
  value: string | null;
  defaultValue: string;
  defaultLabel?: string;
  source: string;
  options?: readonly SettingOption[];
  groups?: readonly SettingOptionGroup[];
  onChange: (value: string | null) => void;
  dirty?: boolean;
  originalLabel?: string;
  takesEffect?: string;
  hint?: string;
  locked?: boolean;
  offline?: boolean;
  disabled?: boolean;
  machine?: string;
  children?: ReactNode;
}

/** A native picker with explicit inheritance, draft and desktop availability. */
export function SettingSelect({
  label,
  value,
  defaultValue,
  defaultLabel = defaultValue,
  source,
  options = [],
  groups = [],
  onChange,
  dirty = false,
  originalLabel,
  takesEffect,
  hint,
  locked,
  offline,
  disabled,
  machine = "crichton",
  children,
}: SettingSelectProps) {
  const id = useId();
  const unavailable = Boolean(locked || offline || disabled);
  const state = dirty ? "dirty" : value === null ? "inherited" : "set";
  const choices = [...options, ...groups.flatMap((group) => group.options)];
  // Encode option values so real model ids never collide with inheritance.
  const encoded = (option: string) => `value:${option}`;
  const selected = value === null ? "inherit" : encoded(value);
  const reason = offline
    ? `${machine} is offline · Needs the desktop`
    : locked
      ? `Update Buzz Desktop on ${machine} to change this`
      : undefined;
  const meta =
    reason ??
    (dirty
      ? `was ${originalLabel ?? defaultLabel}`
      : value === null
        ? `Uses the default · from ${source}`
        : (hint ?? `Set here · default is ${defaultLabel}`));
  return (
    <div className="min-w-0 space-y-1.5" data-setting-state={state}>
      <label
        htmlFor={id}
        className="flex items-center gap-2 text-sm font-medium"
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 rounded-full border",
            dirty
              ? "border-honey-ink bg-honey-ink"
              : value === null
                ? "border-muted-foreground"
                : "border-blue-ink bg-blue-ink",
          )}
        />
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={selected}
          disabled={unavailable}
          title={reason}
          aria-describedby={`${id}-hint`}
          className={cn(
            "min-h-11 w-full min-w-0 rounded-lg border border-input bg-background py-2 pl-3 pr-12 text-base focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-55 md:min-h-9 md:text-sm",
            dirty
              ? "border-honey-line bg-honey-wash text-honey-ink"
              : value === null
                ? "text-muted-foreground"
                : "text-foreground",
          )}
          onChange={(event) => {
            if (!unavailable)
              onChange(
                event.target.value === "inherit"
                  ? null
                  : event.target.value.slice(6),
              );
          }}
        >
          <option value="inherit">
            Use default — {defaultLabel} · {source}
          </option>
          {value !== null &&
            !choices.some((option) => option.value === value) && (
              <option value={encoded(value)}>{value}</option>
            )}
          {options.map((option) => (
            <option key={option.value} value={encoded(option.value)}>
              {option.label}
            </option>
          ))}
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((option) => (
                <option key={option.value} value={encoded(option.value)}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {value !== null && (
          <button
            type="button"
            disabled={unavailable}
            aria-label={`Reset ${label} to default`}
            title={`Use default — ${defaultLabel}`}
            className="absolute right-6 top-0 flex min-h-11 w-8 items-center justify-center rounded-md text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:min-h-9"
            onClick={() => {
              if (!unavailable) onChange(null);
            }}
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
          </button>
        )}
      </div>
      {children}
      <div
        id={`${id}-hint`}
        className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-xs"
      >
        <span
          className={
            reason
              ? "text-coral-ink"
              : dirty
                ? "text-honey-ink"
                : "text-muted-foreground"
          }
        >
          {meta}
        </span>
        {takesEffect && (
          <span className="shrink-0 rounded bg-honey-soft px-1.5 text-honey-ink">
            {takesEffect}
          </span>
        )}
      </div>
    </div>
  );
}
