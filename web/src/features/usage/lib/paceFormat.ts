/**
 * Pure formatters for the pace card. All pace math lives in usage-hub; these
 * only turn payload values into words. `now` and `timeZone` are explicit so
 * tests are deterministic.
 */
import type { Pace, PaceAccount } from "./usageHub.ts";

const HOUR_MS = 3_600_000;

/**
 * `<1h` → "in 45m", `<48h` → "in 19h", otherwise "in 4d". An unparseable
 * date yields "" — the card must never throw on bad hub data.
 */
export function formatCountdown(resetsAt: string, now: number): string {
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return "";
  const remaining = Math.max(0, at - now);
  if (remaining < HOUR_MS) return `in ${Math.floor(remaining / 60_000)}m`;
  const hours = remaining / HOUR_MS;
  if (hours < 48) return `in ${Math.floor(hours)}h`;
  return `in ${Math.floor(hours / 24)}d`;
}

/**
 * "Tue 8 AM" in the given zone (viewer's zone when omitted). "" for an
 * unparseable date or an unknown zone — Intl throws RangeError on both.
 */
export function formatResetDay(iso: string, timeZone?: string): string {
  try {
    // The CLI reports resets like 7:59; round to the nearest hour so it reads "8 AM".
    const parts = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      hour: "numeric",
      hour12: true,
      timeZone,
    }).formatToParts(
      new Date(Math.round(Date.parse(iso) / 3_600_000) * 3_600_000),
    );
    const part = (type: string) =>
      parts.find((entry) => entry.type === type)?.value ?? "";
    return `${part("weekday")} ${part("hour")} ${part("dayPeriod")}`.trim();
  } catch {
    return "";
  }
}

/** "HH:MM" for the stale "as of" note; "" if it cannot be formatted. */
export function formatClock(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    }).format(new Date(ms));
  } catch {
    return "";
  }
}

function worstAccount(pace: Pace): PaceAccount | undefined {
  return pace.accounts.find((account) => account.status === pace.status);
}

/**
 * Short headline for the footer strip, e.g. "A runs out before reset" or
 * "On pace". The next reset moved into the strip's expanded details
 * ({@link nextResetLabel}) in the left-nav redesign.
 */
export function headlineFor(pace: Pace, now: number = Date.now()): string {
  const worst = worstAccount(pace);
  const id = worst?.id ?? "An account";
  switch (pace.status) {
    case "ok":
      return "On pace";
    case "warn":
      return `${id} runs out before reset`;
    case "critical": {
      if (worst && worst.usedFraction !== null && worst.usedFraction >= 1) {
        return `${id} is out`;
      }
      const eta = worst?.etaFullAt
        ? formatCountdown(worst.etaFullAt, now).replace(/^in /, "")
        : "";
      return eta ? `${id} runs out in ~${eta}` : `${id} is about to run out`;
    }
    default:
      return "Pace unknown";
  }
}

/** "Tue 8 AM (A)" for the details' Next reset row; "" when unknown. */
export function nextResetLabel(pace: Pace, timeZone?: string): string {
  if (!pace.nextReset) return "";
  const day = formatResetDay(pace.nextReset.resetsAt, timeZone);
  return day ? `${day} (${pace.nextReset.account})` : "";
}

/** Why an account has no number — never "0%". */
export function unknownLabel(account: PaceAccount): string {
  switch (account.state) {
    case "logged-out":
      return "logged out";
    case "reset-pending":
      return "reset pending";
    case "missing":
      return "unknown (no data)";
    default:
      return "unknown (stale)";
  }
}
