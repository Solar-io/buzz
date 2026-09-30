/**
 * "Send to Feedback": one click files a message as a reminder you answer
 * later (web redesign Phase 2; plan default 3 — due tomorrow 9:00 AM).
 *
 * Feedback is not a new kind. It is a NIP-ER reminder (kind 30300) with a
 * fixed due time, so it shows up in Work → Needs you under the Feedback chip
 * and can be moved from the snooze menu like any other reminder.
 *
 * The due time is a wall-clock 9:00 tomorrow, not "+24 h": a message filed at
 * 4 pm should be waiting at the start of the next day, not resurface at 4 pm.
 * (`/remind` with no argument keeps the flat +1 day of `quickRemind.ts`.)
 *
 * The clock is injected so a test pins an instant and asserts a hardcoded
 * timestamp.
 */

import { nextDayAt9am } from "./timePresets.ts";

/** Unix seconds at which a message filed at `nowMs` comes due. */
export function feedbackDueAt(nowMs: number): number {
  return nextDayAt9am(nowMs, 1);
}

/** The success toast: "Sent to Feedback · due tomorrow 9:00 AM". */
export function feedbackConfirmation(notBefore: number): string {
  const time = new Date(notBefore * 1_000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `Sent to Feedback · due tomorrow ${time}`;
}
