import { useState } from "react";
import { CalendarClock, Clock } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Textarea } from "@/shared/ui/textarea";

import { useReminderMutations } from "../hooks.ts";
import { TIME_PRESETS } from "../lib/timePresets.ts";
import type { ReminderTarget } from "../lib/reminderTypes.ts";
import { CustomTimeFields } from "./TimePresetPicker.tsx";

/**
 * "Remind me later" for one message: the shared presets, a custom instant,
 * and an optional private note.
 *
 * The note is encrypted with the rest of the payload, so it is genuinely
 * private — the relay sees only that this author has something due at a time.
 */
export function RemindMeLaterDialog({
  onOpenChange,
  open,
  selfPubkey,
  target,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  selfPubkey: string | null;
  target: ReminderTarget | null;
}) {
  const { create } = useReminderMutations(selfPubkey);
  const [note, setNote] = useState("");

  const submit = (notBefore: number) => {
    if (!target || create.isPending) {
      return;
    }
    create.mutate(
      { target, notBefore, note: note.trim() || undefined },
      {
        onSuccess: () => {
          toast.success("Reminder set");
          setNote("");
          onOpenChange(false);
        },
        onError: (error) =>
          toast.error(
            error instanceof Error
              ? error.message
              : "Failed to create the reminder",
          ),
      },
    );
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-100" data-testid="remind-me-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock aria-hidden className="h-4 w-4" />
            Remind me later
          </DialogTitle>
          <DialogDescription>
            {target?.preview
              ? `“${target.preview}”`
              : "Choose when to be reminded about this message."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {TIME_PRESETS.map((preset) => (
            <Button
              className="justify-start"
              data-testid={`remind-preset-${preset.label
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")}`}
              disabled={create.isPending}
              key={preset.label}
              onClick={() => submit(preset.at(Date.now()))}
              type="button"
              variant="outline"
            >
              {preset.label}
            </Button>
          ))}
        </div>

        <div className="space-y-2 border-t border-border/60 pt-3">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <CalendarClock aria-hidden className="h-4 w-4" />
            Custom date &amp; time
          </p>
          <CustomTimeFields
            confirmLabel="Set reminder"
            idPrefix="remind-custom"
            onConfirm={submit}
          />
        </div>

        <div className="space-y-2">
          <label
            className="text-sm font-medium text-muted-foreground"
            htmlFor="reminder-note"
          >
            Note (optional)
          </label>
          <Textarea
            className="resize-none"
            data-testid="remind-note"
            id="reminder-note"
            onChange={(event) => setNote(event.target.value)}
            placeholder="Add a note…"
            rows={2}
            value={note}
          />
        </div>

        <DialogFooter>
          <Button
            disabled={create.isPending}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
