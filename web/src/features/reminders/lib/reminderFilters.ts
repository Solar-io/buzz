import type { Reminder } from "./reminderTypes.ts";

/**
 * The due/snooze arithmetic. Every function takes `now` (Unix seconds)
 * explicitly — see the note in `timePresets.ts` for why the clock is never
 * read in here.
 */

/**
 * A reminder that has come due.
 *
 * All three conditions are load-bearing, and the middle one is the easy one
 * to drop: NIP-ER says a `done`/`cancelled` replacement MUST omit
 * `not_before`, but a client that got that wrong would leave a terminal
 * reminder carrying a past due time, and the spec is explicit that a terminal
 * head must never be scheduled or notified. Checking `status` first is what
 * makes an already-completed reminder stay quiet.
 */
export function isDue(reminder: Reminder, now: number): boolean {
  return (
    reminder.content.status === "pending" &&
    reminder.notBefore !== undefined &&
    reminder.notBefore <= now
  );
}

/** How many reminders are due or overdue — the badge's number. */
export function countDue(reminders: readonly Reminder[], now: number): number {
  return reminders.filter((reminder) => isDue(reminder, now)).length;
}

/**
 * Reminders that crossed `not_before` in `(watermark, now]`.
 *
 * The lower bound is STRICT and that is the whole design. A reminder already
 * past at the seeded watermark (first launch on a device) must not fire a
 * toast — otherwise opening the app replays the user's entire reminder
 * history as alerts. It still shows in the panel and the badge, which is
 * where history belongs.
 */
export function dueSince(
  reminders: readonly Reminder[],
  watermark: number,
  now: number,
): Reminder[] {
  return reminders.filter(
    (reminder) =>
      reminder.content.status === "pending" &&
      reminder.notBefore !== undefined &&
      reminder.notBefore > watermark &&
      reminder.notBefore <= now,
  );
}

export interface ReminderGroup {
  label: "Overdue" | "Today" | "Upcoming" | "Completed";
  reminders: Reminder[];
}

/** End of the local calendar day containing `now`, in Unix seconds. */
export function endOfLocalDay(now: number): number {
  const date = new Date(now * 1_000);
  date.setHours(23, 59, 59, 999);
  return Math.floor(date.getTime() / 1_000);
}

/**
 * Bucket reminders for the panel: Overdue / Today / Upcoming, plus Completed
 * when `includeDone` is set. Cancelled reminders are never surfaced — the
 * user cancelled them, and a "Cancelled" pile is a graveyard nobody asked
 * for. Empty buckets are omitted rather than rendered as empty headings.
 *
 * Within a bucket, pending reminders are ordered by due time (soonest first)
 * and completed ones by recency, so the top of each list is the one the user
 * is most likely acting on.
 */
export function groupReminders(
  reminders: readonly Reminder[],
  now: number,
  options: { includeDone?: boolean } = {},
): ReminderGroup[] {
  const endOfToday = endOfLocalDay(now);
  const overdue: Reminder[] = [];
  const today: Reminder[] = [];
  const upcoming: Reminder[] = [];
  const done: Reminder[] = [];

  for (const reminder of reminders) {
    if (reminder.content.status === "done") {
      if (options.includeDone) {
        done.push(reminder);
      }
      continue;
    }
    if (reminder.content.status !== "pending") {
      continue;
    }
    if (reminder.notBefore === undefined) {
      continue;
    }
    if (reminder.notBefore <= now) {
      overdue.push(reminder);
    } else if (reminder.notBefore <= endOfToday) {
      today.push(reminder);
    } else {
      upcoming.push(reminder);
    }
  }

  const byDue = (left: Reminder, right: Reminder) =>
    (left.notBefore ?? 0) - (right.notBefore ?? 0) ||
    left.id.localeCompare(right.id);
  overdue.sort(byDue);
  today.sort(byDue);
  upcoming.sort(byDue);
  done.sort(
    (left, right) =>
      right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );

  const groups: ReminderGroup[] = [];
  if (overdue.length > 0) {
    groups.push({ label: "Overdue", reminders: overdue });
  }
  if (today.length > 0) {
    groups.push({ label: "Today", reminders: today });
  }
  if (upcoming.length > 0) {
    groups.push({ label: "Upcoming", reminders: upcoming });
  }
  if (done.length > 0) {
    groups.push({ label: "Completed", reminders: done });
  }
  return groups;
}

/** Event ids of messages carrying a pending reminder, for row tinting. */
export function pendingTargetEventIds(
  reminders: readonly Reminder[],
): Set<string> {
  const ids = new Set<string>();
  for (const reminder of reminders) {
    if (
      reminder.content.status === "pending" &&
      reminder.content.target?.eventId
    ) {
      ids.add(reminder.content.target.eventId);
    }
  }
  return ids;
}

/** "in 20m" / "3h overdue" — the relative wording the panel rows carry. */
export function formatDueLabel(notBefore: number, now: number): string {
  const diff = notBefore - now;
  const magnitude = Math.abs(diff);
  const unit =
    magnitude < 60
      ? null
      : magnitude < 3_600
        ? `${Math.floor(magnitude / 60)}m`
        : magnitude < 86_400
          ? `${Math.floor(magnitude / 3_600)}h`
          : `${Math.floor(magnitude / 86_400)}d`;
  if (diff < 0) {
    return unit === null ? "just now" : `${unit} overdue`;
  }
  return unit === null ? "in less than a minute" : `in ${unit}`;
}
