/**
 * The `[when]` argument of `/remind`.
 *
 * Deliberately small and literal: a handful of shapes a person actually
 * types, each resolving to one instant, and `null` for everything else. A
 * parser that guesses ("next sprint", "later") would file a reminder at a
 * time nobody chose, and a reminder at the wrong time is worse than an error
 * that says what it understands.
 *
 *   30m · 45 min · 2h · 3 hours · 1d · 2 days · 1w   (optionally "in …")
 *   3pm · 3:30pm · 15:00        today, or tomorrow when that time has passed
 *   tomorrow · tomorrow 3pm     9:00 unless a time is given
 *   monday · fri · friday 2pm   the NEXT such day, never today
 *
 * The clock is injected (`nowMs`), like `timePresets.ts`, so a test pins an
 * instant and asserts a hardcoded timestamp.
 */

export interface RemindWhen {
  /** Unix seconds — always strictly after `nowMs`. */
  at: number;
}

const UNIT_SECONDS: Record<string, number> = {
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3_600,
  hr: 3_600,
  hrs: 3_600,
  hour: 3_600,
  hours: 3_600,
  d: 86_400,
  day: 86_400,
  days: 86_400,
  w: 604_800,
  wk: 604_800,
  week: 604_800,
  weeks: 604_800,
};

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/** "3pm" / "3:30 pm" / "15:00" → minutes since midnight, or null. */
function parseClock(text: string): number | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) {
    return null;
  }
  let hour = Number.parseInt(match[1], 10);
  const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
  const meridiem = match[3];
  if (minute > 59) {
    return null;
  }
  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (!match[2] || hour > 23) {
    // A bare number ("3") is not a time; "15:00" is.
    return null;
  }
  return hour * 60 + minute;
}

function at(nowMs: number, dayOffset: number, minutes: number): number {
  const date = new Date(nowMs);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return Math.floor(date.getTime() / 1_000);
}

/** Parse `text` relative to `nowMs`; null when it is not a time we read. */
export function parseRemindWhen(text: string, nowMs: number): RemindWhen | null {
  const input = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (input === "") {
    return null;
  }
  const nowS = Math.floor(nowMs / 1_000);

  const relative = /^(?:in )?(\d{1,4}) ?([a-z]+)$/.exec(input);
  if (relative) {
    const unit = UNIT_SECONDS[relative[2]];
    const count = Number.parseInt(relative[1], 10);
    if (unit !== undefined && count > 0) {
      return { at: nowS + count * unit };
    }
  }

  const clock = parseClock(input);
  if (clock !== null) {
    const today = at(nowMs, 0, clock);
    // Roll forward: a time that has passed today means tomorrow, never a
    // reminder that is due the instant it is published.
    return { at: today > nowS ? today : at(nowMs, 1, clock) };
  }

  const [head, ...tail] = input.split(" ");
  const time = tail.length > 0 ? parseClock(tail.join(" ")) : 9 * 60;
  if (time === null) {
    return null;
  }
  if (head === "tomorrow") {
    return { at: at(nowMs, 1, time) };
  }
  const weekday = WEEKDAYS.findIndex(
    (day) => day === head || (head.length >= 3 && day.startsWith(head)),
  );
  if (weekday !== -1) {
    const today = new Date(nowMs).getDay();
    // Never 0: "monday" typed on a Monday means next Monday.
    const ahead = (weekday - today + 7) % 7 || 7;
    return { at: at(nowMs, ahead, time) };
  }
  return null;
}

/** "tomorrow 9:00 AM", "today 3:30 PM", "Mon, Oct 5, 9:00 AM" — for the toast. */
export function remindWhenLabel(atS: number, nowMs: number): string {
  const due = new Date(atS * 1_000);
  const time = due.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor(
    (due.getTime() - startOfToday.getTime()) / 86_400_000,
  );
  if (days === 0) {
    return `today ${time}`;
  }
  if (days === 1) {
    return `tomorrow ${time}`;
  }
  const day = due.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${day}, ${time}`;
}
