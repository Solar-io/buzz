/**
 * Timeline date/time formatting, split out of ChannelTimeline so the strings
 * are unit-testable and shared by the row header, the continuation hover
 * gutter and the absolute-date tooltip.
 *
 * Mirrors `desktop/src/features/messages/lib/dateFormatters.ts`:
 *
 * - `formatDayLabel` / `formatTime` — the relative ladder ("Today",
 *   "Yesterday at 9:05 AM"). These follow the viewer's locale, because they
 *   are the strings a person reads at a glance.
 * - `formatClockTime` — clock only, AM/PM stripped. Renders in the 36px
 *   gutter that replaces the avatar on continuation rows, which has room for
 *   "9:05" and nothing more.
 * - `formatFullDateTime` — the verbose tooltip string. Pinned to en-US like
 *   the desktop so the tooltip wording is stable across machines.
 */

/** Locale-fixed formatters (desktop parity — see the module comment). */
const CLOCK_FORMATTER = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

const FULL_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Trailing AM/PM, including the narrow no-break space Intl emits. */
const DAY_PERIOD_SUFFIX_RE = /[\s\u00a0\u202f]*(?:AM|PM)$/i;

/** "Today" / "Yesterday" / "August 28" — the day-divider label. */
export function formatDayLabel(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) {
    return "Today";
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }
  return date.toLocaleDateString([], {
    month: "long",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

/**
 * Desktop-qualified timestamps: time-only today, "Yesterday at …", weekday
 * within the week, "Aug 28 at …" beyond. Day dividers carry the day for
 * scanning; the qualifier keeps individual rows self-describing.
 */
export function formatTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const today = new Date();
  const dayKey = (d: Date) => d.toDateString();
  if (dayKey(date) === dayKey(today)) {
    return time;
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) {
    return `Yesterday at ${time}`;
  }
  if (today.getTime() - date.getTime() < 7 * 86_400_000) {
    return `${date.toLocaleDateString([], { weekday: "long" })} at ${time}`;
  }
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

/** Clock time with the AM/PM marker removed, e.g. "2:34" — the hover gutter. */
export function formatClockTime(unixSeconds: number): string {
  return CLOCK_FORMATTER.format(new Date(unixSeconds * 1000))
    .replace(DAY_PERIOD_SUFFIX_RE, "")
    .trim();
}

/** Full date + time for tooltips, e.g. "Thursday, April 2, 2026 at 2:34 PM". */
export function formatFullDateTime(unixSeconds: number): string {
  return FULL_DATE_TIME_FORMATTER.format(new Date(unixSeconds * 1000));
}
