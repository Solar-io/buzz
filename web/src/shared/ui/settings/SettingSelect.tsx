import { useId, type ReactNode } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { cn } from "@/shared/lib/cn";

/** Readable choice and opaque underlying value. */
export interface SettingOption {
  value: string;
  label: string;
}
/** Named source group for a native picker. */
export interface SettingOptionGroup {
  label: string;
  options: readonly SettingOption[];
}
/** Requires a known resolved default; availability is supplied by the catalog. */
export interface SettingSelectProps {
  label: string;
  /** null means inherit; defaultValue is the readable, resolved default. */
  value: string | null;
  defaultValue: string;
  defaultLabel?: string;
  source: string;
  options?: readonly SettingOption[];
  trailingOptions?: readonly SettingOption[];
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
  /** Consumers lock clears until the desktop can apply them. */
  inheritLocked?: boolean;
  /** A blind control must never present a built-in as its current value. */
  unreported?: boolean;
}

/** A native picker with explicit inheritance, draft and desktop availability. */
export function SettingSelect({
  label,
  value,
  defaultValue,
  defaultLabel = defaultValue,
  source,
  options = [],
  trailingOptions = [],
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
  inheritLocked = false,
  unreported = false,
}: SettingSelectProps) {
  const id = useId();
  const unavailable = Boolean(locked || offline || disabled);
  const state = dirty ? "dirty" : value === null ? "inherited" : "set";
  const choices = [
    ...options,
    ...groups.flatMap((group) => group.options),
    ...trailingOptions,
  ];
  // Encode option values so real model ids never collide with inheritance.
  const encoded = (option: string) => `value:${option}`;
  const selected =
    value === null ? (unreported ? "unreported" : "inherit") : encoded(value);
  const resolvedLabel =
    value === null
      ? unreported
        ? "Not reported · choose to set"
        : defaultLabel
      : (choices.find((option) => option.value === value)?.label ?? value);
  const reason = offline
    ? `${machine} is offline · Needs the desktop`
    : locked
      ? `Update Buzz Desktop on ${machine} to change this`
      : undefined;
  const meta =
    reason ??
    (unreported && value === null
      ? "Current value is not reported by Buzz Desktop."
      : dirty
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
                : "border-info-ink bg-info-ink",
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
            "text-transparent",
            dirty && "border-honey-line bg-honey-wash",
          )}
          onChange={(event) => {
            if (
              !unavailable &&
              event.target.value !== "unreported" &&
              !(inheritLocked && event.target.value === "inherit")
            )
              onChange(
                event.target.value === "inherit"
                  ? null
                  : event.target.value.slice(6),
              );
          }}
        >
          {unreported && (
            <option value="unreported" disabled>
              Not reported · choose to set
            </option>
          )}
          <option
            value="inherit"
            disabled={inheritLocked}
            className="text-foreground"
          >
            Use default — {defaultLabel} · {source}
          </option>
          {value !== null &&
            !choices.some((option) => option.value === value) && (
              <option value={encoded(value)} className="text-foreground">
                {value}
              </option>
            )}
          {options.map((option) => (
            <option
              key={option.value}
              value={encoded(option.value)}
              className="text-foreground"
            >
              {option.label}
            </option>
          ))}
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options.map((option) => (
                <option
                  key={option.value}
                  value={encoded(option.value)}
                  className="text-foreground"
                >
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))}
          {trailingOptions.map((option) => (
            <option
              key={option.value}
              value={encoded(option.value)}
              className="text-foreground"
            >
              {option.label}
            </option>
          ))}
        </select>
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 left-3 right-20 flex min-w-0 items-center text-base md:right-16 md:text-sm",
            unavailable && "opacity-55",
            dirty
              ? "text-honey-ink"
              : value === null
                ? "text-muted-foreground"
                : "text-foreground",
          )}
        >
          <span className="truncate">{resolvedLabel}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        {value !== null && (
          <button
            type="button"
            disabled={unavailable || inheritLocked}
            aria-label={`Reset ${label} to default`}
            title={`Use default — ${defaultLabel}`}
            className="absolute right-6 top-0 flex min-h-11 w-11 items-center justify-center rounded-md text-muted-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:min-h-9 md:w-8"
            onClick={() => {
              if (!unavailable && !inheritLocked) onChange(null);
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
