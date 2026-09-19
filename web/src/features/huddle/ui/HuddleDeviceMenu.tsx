import { ChevronUp } from "lucide-react";
import type { ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { cn } from "@/shared/lib/cn";

import {
  isSystemDefault,
  SINK_ID_UNSUPPORTED_MESSAGE,
  SYSTEM_DEFAULT_DEVICE_ID,
  type AudioDeviceOption,
} from "../lib/audioDevices.ts";

/**
 * The chevron half of a split button: the device list for one side of the
 * call.
 *
 * It is a SPLIT button rather than a single one because the two actions are
 * different in kind — the big half is "mute me", pressed constantly and in
 * a hurry, and the chevron is "which microphone", pressed rarely and
 * deliberately. Merging them is how a menu ends up opening when someone
 * meant to mute.
 *
 * An unsupported speaker menu renders DISABLED with the reason on it rather
 * than absent or inert: Safari and Firefox have no `setSinkId`, and a
 * control that quietly does nothing is the worse of the two failures.
 */
export function HuddleDeviceMenu({
  label,
  testId,
  itemTestId,
  devices,
  currentDeviceId,
  onSelect,
  disabled = false,
  disabledReason,
  children,
}: {
  /** Menu heading, e.g. "Microphone". */
  label: string;
  testId: string;
  itemTestId: string;
  devices: readonly AudioDeviceOption[];
  currentDeviceId: string;
  onSelect: (deviceId: string) => void;
  disabled?: boolean;
  disabledReason?: string;
  /** Extra rows below the device list (input mode, for the mic menu). */
  children?: ReactNode;
}) {
  if (disabled) {
    return (
      <button
        aria-label={`${label} (unavailable)`}
        className="rounded-r-full border border-l-0 border-border px-1 py-1 text-muted-foreground opacity-50"
        data-testid={testId}
        disabled
        title={disabledReason ?? SINK_ID_UNSUPPORTED_MESSAGE}
        type="button"
      >
        <ChevronUp aria-hidden className="h-3.5 w-3.5" />
      </button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={label}
          className="rounded-r-full border border-l-0 border-border px-1 py-1 text-muted-foreground hover:text-foreground"
          data-testid={testId}
          type="button"
        >
          <ChevronUp aria-hidden className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-72" side="top">
        <DropdownMenuLabel className="text-2xs uppercase tracking-wide">
          {label}
        </DropdownMenuLabel>
        <DropdownMenuItem
          data-testid={itemTestId}
          onSelect={() => onSelect(SYSTEM_DEFAULT_DEVICE_ID)}
        >
          <span
            className={cn(
              "truncate",
              isSystemDefault(currentDeviceId) && "font-medium text-foreground",
            )}
          >
            System default
          </span>
        </DropdownMenuItem>
        {devices.map((device) => (
          <DropdownMenuItem
            data-testid={itemTestId}
            key={device.deviceId}
            onSelect={() => onSelect(device.deviceId)}
          >
            <span
              className={cn(
                "truncate",
                device.deviceId === currentDeviceId &&
                  "font-medium text-foreground",
              )}
            >
              {device.label}
            </span>
          </DropdownMenuItem>
        ))}
        {children !== undefined && (
          <>
            <DropdownMenuSeparator />
            {children}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
