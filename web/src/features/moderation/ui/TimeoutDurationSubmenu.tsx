import { Clock } from "lucide-react";

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/shared/ui/dropdown-menu";
import { TIMEOUT_PRESETS, timeoutExpiresAt } from "../lib/timeout.ts";

/**
 * A submenu of community-timeout durations. Each item resolves its preset to
 * an absolute expiry (epoch seconds) and hands it to `onSelect` — the caller
 * runs the command. Presentational and duration-only: it knows nothing about
 * who is being timed out, so any later surface (a report queue, a member card)
 * can share it and stay on one preset list.
 */
export function TimeoutDurationSubmenu({
  label = "Time out author",
  disabled = false,
  testIdPrefix,
  onSelect,
}: {
  label?: string;
  disabled?: boolean;
  /** Prefix for each preset item's `data-testid`. */
  testIdPrefix?: string;
  /** Called with the absolute expiry in epoch seconds for the chosen preset. */
  onSelect: (expiresAt: number) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        data-testid={testIdPrefix ? `${testIdPrefix}-trigger` : undefined}
        disabled={disabled}
      >
        <Clock className="h-4 w-4" aria-hidden="true" />
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {TIMEOUT_PRESETS.map((preset) => (
          <DropdownMenuItem
            data-testid={
              testIdPrefix ? `${testIdPrefix}-${preset.seconds}` : undefined
            }
            disabled={disabled}
            key={preset.seconds}
            onClick={() => onSelect(timeoutExpiresAt(preset.seconds))}
          >
            {preset.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
