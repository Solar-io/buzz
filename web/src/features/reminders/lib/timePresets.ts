/**
 * Reminder time presets — one source of truth for the create dialog and the
 * snooze menu, so "In 1 hour" cannot mean two different things.
 *
 * Every function here takes `nowMs` explicitly rather than reading the clock
 * itself. That is not ceremony: a preset that closes over `Date.now()` can
 * only be tested against an expectation derived from `Date.now()`, which is
 * the self-adjusting assertion that passes whether the arithmetic is right or
 * wrong. With the clock injected, a test can pin a fixed instant and assert a
 * hardcoded timestamp.
 */

export interface TimePreset {
  label: string;
  /** Unix seconds, always strictly in the future relative to `nowMs`. */
  at: (nowMs: number) => number;
}

const SECOND_MS = 1_000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;

function seconds(nowMs: number): number {
  return Math.floor(nowMs / SECOND_MS);
}

/**
 * `dayOffset` days from `nowMs`, at 09:00 local time — rolled forward a day if
 * that instant is already past.
 *
 * The roll-forward is what makes "Tomorrow at 9am" safe at 11pm and
 * "Next Monday at 9am" safe on a Monday morning: without it the preset can
 * return a timestamp in the past, and a past `not_before` fires the instant it
 * is published.
 */
export function nextDayAt9am(nowMs: number, dayOffset: number): number {
  const now = new Date(nowMs);
  const target = new Date(nowMs);
  target.setDate(target.getDate() + dayOffset);
  target.setHours(9, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return Math.floor(target.getTime() / SECOND_MS);
}

/** Days from `nowMs` until the next Monday — never 0, so "next" means next. */
export function daysUntilNextMonday(nowMs: number): number {
  return (8 - new Date(nowMs).getDay()) % 7 || 7;
}

export const TIME_PRESETS: readonly TimePreset[] = [
  { label: "In 30 minutes", at: (nowMs) => seconds(nowMs) + 30 * MINUTE },
  { label: "In 1 hour", at: (nowMs) => seconds(nowMs) + HOUR },
  { label: "In 3 hours", at: (nowMs) => seconds(nowMs) + 3 * HOUR },
  { label: "Tomorrow at 9am", at: (nowMs) => nextDayAt9am(nowMs, 1) },
  {
    label: "Next Monday at 9am",
    at: (nowMs) => nextDayAt9am(nowMs, daysUntilNextMonday(nowMs)),
  },
] as const;

/** Local `YYYY-MM-DD` for the date input's `min` attribute. */
export function todayDateString(nowMs: number = Date.now()): string {
  const now = new Date(nowMs);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Parse a `YYYY-MM-DD` + `HH:MM` pair into a future Unix timestamp, or null.
 *
 * Null covers three cases that must all be refused, not just the obviously
 * malformed one: an empty field, an unparseable pair, and — the one that
 * matters — a valid instant that is already past. A native `<input type=time>`
 * has no `min`, so without the last check picking 08:00 this morning creates a
 * reminder that is due the moment it is published.
 */
export function parseCustomDateTime(
  date: string,
  time: string,
  nowMs: number = Date.now(),
): number | null {
  if (!date || !time) {
    return null;
  }
  const parsed = new Date(`${date}T${time}`).getTime();
  if (Number.isNaN(parsed)) {
    return null;
  }
  const timestamp = Math.floor(parsed / SECOND_MS);
  return timestamp > seconds(nowMs) ? timestamp : null;
}
