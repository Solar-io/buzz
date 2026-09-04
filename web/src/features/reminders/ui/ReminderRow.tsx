import { Bell, Check, ExternalLink, X } from "lucide-react";
import { toast } from "sonner";

import type { Profile } from "@/features/channels/hooks";
import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";

import { useReminderMutations } from "../hooks.ts";
import { formatDueLabel } from "../lib/reminderFilters.ts";
import { hasNavigableTarget } from "../lib/reminderNavigation.ts";
import type { Reminder } from "../lib/reminderTypes.ts";
import { SnoozeMenu } from "./SnoozeMenu.tsx";

/**
 * One reminder in the panel: what it is about, when it is due, and the three
 * things you can do with it — done, snooze, cancel.
 *
 * "Cancel" and "Done" are different NIP-ER terminal states and both are
 * offered, because they mean different things to the user: done is "I dealt
 * with it", cancelled is "I no longer want this". Neither deletes anything;
 * both publish a terminal replacement with a cleanup expiration.
 */
export function ReminderRow({
  channelLabel,
  now,
  onJump,
  profile,
  reminder,
  selfPubkey,
}: {
  channelLabel: string | null;
  /** Unix seconds — passed in so every row in one render agrees on "now". */
  now: number;
  onJump: (reminder: Reminder) => void;
  profile: Profile | undefined;
  reminder: Reminder;
  selfPubkey: string | null;
}) {
  const { complete, snooze, cancel } = useReminderMutations(selfPubkey);
  const busy = complete.isPending || snooze.isPending || cancel.isPending;
  const isDone = reminder.content.status === "done";
  const navigable = hasNavigableTarget(reminder.content.target);
  const overdue =
    !isDone && reminder.notBefore !== undefined && reminder.notBefore <= now;

  const authorLabel = reminder.content.target?.authorPubkey
    ? profile?.displayName?.trim() ||
      profile?.name?.trim() ||
      truncatePubkey(reminder.content.target.authorPubkey)
    : null;

  const act = (run: () => void, success: string) => {
    if (busy) {
      return;
    }
    run();
    toast.success(success);
  };

  return (
    <li
      className="flex items-start gap-3 rounded-lg border border-border/50 p-3"
      data-testid={`reminder-row-${reminder.id}`}
    >
      <span
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          overdue
            ? "bg-destructive/10 text-destructive"
            : "bg-muted text-muted-foreground",
        )}
      >
        <Bell aria-hidden className="h-4 w-4" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
          {authorLabel ? (
            <span className="font-medium text-foreground">{authorLabel}</span>
          ) : null}
          {channelLabel ? <span>in {channelLabel}</span> : null}
          {reminder.notBefore !== undefined ? (
            <span
              className={cn(overdue && "font-medium text-destructive")}
              data-testid={`reminder-due-${reminder.id}`}
            >
              {formatDueLabel(reminder.notBefore, now)}
            </span>
          ) : null}
        </div>

        <p
          className={cn(
            "mt-0.5 break-words text-sm",
            isDone ? "text-muted-foreground line-through" : "text-foreground",
          )}
        >
          {reminder.content.note?.trim() ||
            reminder.content.target?.preview ||
            "Reminder"}
        </p>

        {reminder.content.note?.trim() && reminder.content.target?.preview ? (
          <p className="mt-0.5 truncate text-2xs text-muted-foreground">
            {reminder.content.target.preview}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {navigable ? (
          <Button
            aria-label="Open the message this reminder is about"
            data-testid={`reminder-jump-${reminder.id}`}
            onClick={() => onJump(reminder)}
            size="icon"
            title="Jump to message"
            type="button"
            variant="ghost"
          >
            <ExternalLink aria-hidden className="h-4 w-4" />
          </Button>
        ) : null}
        {isDone ? null : (
          <>
            <SnoozeMenu
              disabled={busy}
              onSnooze={(notBefore) =>
                act(
                  () => snooze.mutate({ reminder, notBefore }),
                  "Reminder snoozed",
                )
              }
              reminderId={reminder.id}
            />
            <Button
              aria-label="Mark this reminder done"
              data-testid={`reminder-complete-${reminder.id}`}
              disabled={busy}
              onClick={() =>
                act(() => complete.mutate(reminder), "Reminder completed")
              }
              size="icon"
              title="Done"
              type="button"
              variant="ghost"
            >
              <Check aria-hidden className="h-4 w-4" />
            </Button>
            <Button
              aria-label="Cancel this reminder"
              data-testid={`reminder-cancel-${reminder.id}`}
              disabled={busy}
              onClick={() =>
                act(() => cancel.mutate(reminder), "Reminder cancelled")
              }
              size="icon"
              title="Cancel"
              type="button"
              variant="ghost"
            >
              <X aria-hidden className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
