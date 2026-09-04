import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import { useProfiles } from "@/features/channels/hooks";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { Button } from "@/shared/ui/button";
import { Skeleton } from "@/shared/ui/skeleton";
import { Switch } from "@/shared/ui/switch";

import { useRemindersQuery } from "../hooks.ts";
import { groupReminders } from "../lib/reminderFilters.ts";
import { reminderDestination } from "../lib/reminderNavigation.ts";
import { ReminderKeyUnavailableError } from "../lib/reminderService.ts";
import type { Reminder } from "../lib/reminderTypes.ts";
import { ReminderRow } from "./ReminderRow.tsx";

/** Re-render cadence so relative due labels and bucketing stay honest. */
const TICK_MS = 30_000;

/**
 * The pending-reminders panel: Overdue / Today / Upcoming, with Completed
 * behind a toggle.
 *
 * `now` is held in state and ticked rather than read at render, so a reminder
 * that crosses its due time while the panel is open MOVES from Today to
 * Overdue on its own. Reading `Date.now()` inline would freeze the buckets
 * until some unrelated state change forced a re-render — which looks exactly
 * like a reminder that failed to come due.
 */
export function RemindersPanel({
  channels,
  onClose,
  onJump,
  selfPubkey,
}: {
  channels: readonly ChannelSummary[];
  onClose: () => void;
  /** Open a channel at a message — the shell owns routing. */
  onJump: (destination: { channelId: string; messageId: string }) => void;
  selfPubkey: string | null;
}) {
  const query = useRemindersQuery(selfPubkey);
  const [showDone, setShowDone] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1_000));

  useEffect(() => {
    const interval = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1_000)),
      TICK_MS,
    );
    return () => window.clearInterval(interval);
  }, []);

  const reminders = useMemo(() => query.data ?? [], [query.data]);
  const groups = useMemo(
    () => groupReminders(reminders, now, { includeDone: showDone }),
    [reminders, now, showDone],
  );

  const authorPubkeys = useMemo(() => {
    const set = new Set<string>();
    for (const reminder of reminders) {
      const author = reminder.content.target?.authorPubkey;
      if (author) {
        set.add(author);
      }
    }
    return [...set];
  }, [reminders]);
  const profiles = useProfiles(authorPubkeys);

  const channelLabel = (reminder: Reminder): string | null => {
    const channelId = reminder.content.target?.channelId;
    if (!channelId) {
      return null;
    }
    const channel = channels.find((entry) => entry.id === channelId);
    if (!channel) {
      return "a channel";
    }
    return channel.type === "dm" ? "a DM" : `#${channel.name}`;
  };

  const keyUnavailable = query.error instanceof ReminderKeyUnavailableError;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="reminders-panel">
      <header className="flex shrink-0 items-center justify-between border-b border-border/50 px-4 py-2">
        <h1 className="text-sm font-semibold text-foreground">Reminders</h1>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch
              aria-labelledby="reminders-show-done-label"
              checked={showDone}
              data-testid="reminders-show-done"
              id="reminders-show-done"
              onCheckedChange={setShowDone}
            />
            <label
              className="text-2xs text-muted-foreground"
              htmlFor="reminders-show-done"
              id="reminders-show-done-label"
            >
              Completed
            </label>
          </div>
          <Button
            aria-label="Close reminders"
            data-testid="reminders-close"
            onClick={onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X aria-hidden className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto w-full max-w-2xl space-y-6">
          {query.isLoading ? (
            <div className="space-y-3" data-testid="reminders-loading">
              {[0, 1, 2].map((row) => (
                <Skeleton className="h-16 w-full rounded-lg" key={row} />
              ))}
            </div>
          ) : keyUnavailable ? (
            <p
              className="rounded-lg border border-dashed border-border/60 px-4 py-10 text-center text-sm text-muted-foreground"
              data-testid="reminders-locked"
            >
              Reminders are encrypted to your key. This session signs with a
              browser extension, which cannot open them — sign in with a local
              key to use reminders.
            </p>
          ) : query.error ? (
            <p
              className="rounded-lg border border-dashed border-destructive/50 px-4 py-10 text-center text-sm text-destructive"
              data-testid="reminders-error"
            >
              {query.error instanceof Error
                ? query.error.message
                : "Could not load your reminders."}
            </p>
          ) : groups.length === 0 ? (
            <p
              className="rounded-lg border border-dashed border-border/60 px-4 py-10 text-center text-sm text-muted-foreground"
              data-testid="reminders-empty"
            >
              Nothing pending. Use “Remind me later” on a message to add one.
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.label}>
                <h2 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </h2>
                <ul className="space-y-2">
                  {group.reminders.map((reminder) => (
                    <ReminderRow
                      channelLabel={channelLabel(reminder)}
                      key={reminder.id}
                      now={now}
                      onJump={(target) => {
                        const destination = reminderDestination(
                          target.content.target,
                        );
                        if (destination) {
                          onJump(destination);
                        }
                      }}
                      profile={
                        reminder.content.target?.authorPubkey
                          ? profiles.get(reminder.content.target.authorPubkey)
                          : undefined
                      }
                      reminder={reminder}
                      selfPubkey={selfPubkey}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
