/**
 * The hover bar's one-click "+" reminder: a fixed delay, no dialog.
 *
 * Sam, 2026-09-29: "give me a '+' sign that would allow me to send that
 * message to reminders … set it to +1 day for each item." So the delay is a
 * flat 24 hours from the click, not the dialog's "Tomorrow at 9am" preset —
 * a message saved at 4pm comes back at 4pm tomorrow.
 *
 * Like `timePresets.ts`, the clock is injected (`nowMs`) so a test can pin an
 * instant and assert a hardcoded timestamp rather than one derived from the
 * constant it is checking.
 */

/** How far out the "+" reminder lands: one day, in seconds. */
export const QUICK_REMIND_DELAY_SECONDS = 24 * 60 * 60;

/** Unix seconds at which a "+" reminder clicked at `nowMs` comes due. */
export function quickRemindDueAt(nowMs: number): number {
  return Math.floor(nowMs / 1_000) + QUICK_REMIND_DELAY_SECONDS;
}

/**
 * The success toast, e.g. "Reminder set for tomorrow 4:05 PM".
 *
 * Says "tomorrow" unconditionally because the delay is exactly one day; the
 * clock time is local, formatted by the runtime's locale.
 */
export function quickRemindConfirmation(notBefore: number): string {
  const time = new Date(notBefore * 1_000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `Reminder set for tomorrow ${time}`;
}
