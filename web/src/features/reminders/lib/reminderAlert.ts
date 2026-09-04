import type { Reminder } from "./reminderTypes.ts";

/** Longer bodies are cut here; OS notification panels truncate anyway. */
export const REMINDER_BODY_MAX = 140;

export interface ReminderAlertCopy {
  title: string;
  body: string;
  /** Groups repeat alerts into one OS slot. */
  tag: string;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max
    ? collapsed
    : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The wording of one due-reminder alert.
 *
 * Pure and separate from the runtime for the same reason the message
 * notification copy is: an OS notification is drawn outside the page, where
 * no browser automation can read it, so the only way its text is ever checked
 * is a test on this function.
 *
 * A batch collapses into one alert rather than N. Several reminders coming
 * due while the tab was in the background is the common case (a laptop
 * reopened after lunch), and N system notifications for it is the behaviour
 * users turn the feature off over.
 */
export function reminderAlertCopy(
  due: readonly Reminder[],
): ReminderAlertCopy | null {
  if (due.length === 0) {
    return null;
  }
  if (due.length > 1) {
    return {
      title: "Reminders due",
      body: `${due.length} reminders are due`,
      tag: "buzz:reminders",
    };
  }
  const only = due[0];
  const detail =
    only.content.note?.trim() || only.content.target?.preview || "";
  return {
    title: "Reminder due",
    body: truncate(detail, REMINDER_BODY_MAX) || "A reminder is waiting",
    tag: `buzz:reminder:${only.id}`,
  };
}
