import { useState } from "react";
import { Clock } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

import { TIME_PRESETS } from "../lib/timePresets.ts";
import { CustomTimeFields } from "./TimePresetPicker.tsx";

/**
 * The clock-icon snooze control: the shared presets plus a custom instant.
 *
 * A popover rather than the desktop's dropdown-inside-dropdown. Radix's
 * dropdown closes on item select, so nesting a date picker inside one needs
 * an `event.preventDefault()` on the item and a second controlled open state
 * to keep it alive — machinery that exists only to fight the menu. One
 * popover holding both halves has no such problem, and keeps the whole
 * snooze surface reachable by keyboard.
 */
export function SnoozeMenu({
  disabled,
  onSnooze,
  reminderId,
}: {
  disabled?: boolean;
  onSnooze: (notBefore: number) => void;
  /** Namespaces this row's test ids. */
  reminderId: string;
}) {
  const [open, setOpen] = useState(false);

  const choose = (notBefore: number) => {
    onSnooze(notBefore);
    setOpen(false);
  };

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Snooze this reminder"
          data-testid={`reminder-snooze-${reminderId}`}
          disabled={disabled}
          size="icon"
          title="Snooze"
          type="button"
          variant="ghost"
        >
          <Clock aria-hidden className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 space-y-3">
        <p className="text-sm font-medium text-foreground">Snooze until</p>
        <div className="flex flex-col gap-1">
          {TIME_PRESETS.map((preset) => (
            <Button
              className="justify-start"
              data-testid={`reminder-snooze-preset-${reminderId}-${preset.label
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")}`}
              key={preset.label}
              onClick={() => choose(preset.at(Date.now()))}
              size="sm"
              type="button"
              variant="ghost"
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <div className="border-t border-border/60 pt-3">
          <CustomTimeFields
            confirmLabel="Snooze"
            idPrefix={`reminder-snooze-custom-${reminderId}`}
            onConfirm={choose}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
