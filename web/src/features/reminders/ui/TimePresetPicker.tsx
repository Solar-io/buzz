import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import { parseCustomDateTime, todayDateString } from "../lib/timePresets.ts";

/**
 * The custom date + time pair, shared by the create dialog and the snooze
 * menu so the two cannot disagree about what counts as a valid instant.
 *
 * The confirm button is disabled whenever {@link parseCustomDateTime} returns
 * null, which covers the case a native `<input type="time">` cannot express:
 * a time earlier today. Without that guard, picking 08:00 this morning
 * creates a reminder that is due the moment it is published.
 */
export function CustomTimeFields({
  confirmLabel,
  idPrefix,
  onConfirm,
}: {
  confirmLabel: string;
  /** Namespaces the input ids so two instances can coexist on one page. */
  idPrefix: string;
  onConfirm: (notBefore: number) => void;
}) {
  const [date, setDate] = useState(() => todayDateString());
  const [time, setTime] = useState("09:00");
  const timestamp = parseCustomDateTime(date, time);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          aria-label="Reminder date"
          className="flex-1"
          data-testid={`${idPrefix}-date`}
          min={todayDateString()}
          onChange={(event) => setDate(event.target.value)}
          type="date"
          value={date}
        />
        <Input
          aria-label="Reminder time"
          className="w-28"
          data-testid={`${idPrefix}-time`}
          onChange={(event) => setTime(event.target.value)}
          type="time"
          value={time}
        />
      </div>
      <Button
        className="w-full"
        data-testid={`${idPrefix}-confirm`}
        disabled={timestamp === null}
        onClick={() => {
          if (timestamp !== null) {
            onConfirm(timestamp);
          }
        }}
        size="sm"
        type="button"
      >
        {confirmLabel}
      </Button>
      {timestamp === null ? (
        <p className="text-2xs text-muted-foreground">
          Pick a date and time in the future.
        </p>
      ) : null}
    </div>
  );
}
