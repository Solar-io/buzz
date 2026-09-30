/**
 * Vitals v1 math over the usage hub's `/v1/pace` (phase-1 §4), plus the
 * `/v1/runway` line now that the hub serves it.
 *
 * Unknown stays unknown: a stale or missing account is left out of the mean
 * and reported as coverage ("1 of 2 accounts"), never folded in as 0% — a
 * stale account shown as "0% used" reads as "plenty left".
 */

import { activeStatus, isParked } from "@/features/usage/lib/paceFormat.ts";
import type {
  Pace,
  PaceAccount,
  PaceAccountState,
  PaceStatus,
} from "@/features/usage/lib/usageHub.ts";

/** Below this much of the window, a pace multiplier is noise. */
export const MIN_ELAPSED_FOR_PACE = 0.05;
/** The "running at N× its pace" line shows only at or above this. */
export const PACE_LINE_AT = 1.1;
/** "Resets with ~N% unused" only when the projection stays under this. */
export const UNUSED_LINE_BELOW = 0.98;

export interface AccountVitals {
  id: string;
  state: PaceAccountState;
  status: PaceStatus;
  parked: boolean;
  used: number | null;
  /** How much of the account's window has passed — the bar's tick. */
  elapsed: number | null;
  resetsAt: string | null;
  /** used ÷ elapsed; null when elapsed < 5 % or either is unknown. */
  paceMultiplier: number | null;
  /** `etaFullAt` when it lands before the reset; else null. */
  fillsAt: string | null;
  /** Whole percent left unused at reset; null when it fills or ≥ 98 %. */
  unusedAtReset: number | null;
}

export type VitalsSummary =
  | {
      kind: "known";
      /** Mean used fraction over known accounts. */
      used: number;
      free: number;
      known: number;
      total: number;
      status: PaceStatus;
      accounts: AccountVitals[];
      /** ms, or null when the hub sent none. */
      computedAt: number | null;
    }
  | { kind: "unavailable"; total: number; accounts: AccountVitals[] };

export function accountVitals(pace: Pace, account: PaceAccount): AccountVitals {
  const known = account.state === "known";
  const used = known ? account.usedFraction : null;
  const elapsed = known ? account.elapsedFraction : null;
  const paceMultiplier =
    used !== null && elapsed !== null && elapsed >= MIN_ELAPSED_FOR_PACE
      ? used / elapsed
      : null;
  const eta = account.etaFullAt ? Date.parse(account.etaFullAt) : Number.NaN;
  const reset = account.resetsAt ? Date.parse(account.resetsAt) : Number.NaN;
  const fillsAt =
    Number.isFinite(eta) && (!Number.isFinite(reset) || eta < reset)
      ? account.etaFullAt
      : null;
  const projected = known ? account.projectedAtReset : null;
  const unusedAtReset =
    projected !== null &&
    account.etaFullAt === null &&
    projected < UNUSED_LINE_BELOW
      ? Math.round((1 - projected) * 100)
      : null;
  return {
    id: account.id,
    state: account.state,
    status: account.status,
    parked: isParked(pace, account),
    used,
    elapsed,
    resetsAt: account.resetsAt,
    paceMultiplier,
    fillsAt,
    unusedAtReset,
  };
}

/** The combined bar: free = 1 − mean(known usedFraction). */
export function vitalsSummary(pace: Pace | null): VitalsSummary {
  if (!pace) {
    return { kind: "unavailable", total: 0, accounts: [] };
  }
  const accounts = pace.accounts.map((account) => accountVitals(pace, account));
  const usedValues = accounts
    .map((account) => account.used)
    .filter((value): value is number => value !== null);
  if (usedValues.length === 0) {
    return { kind: "unavailable", total: accounts.length, accounts };
  }
  const used =
    usedValues.reduce((sum, value) => sum + value, 0) / usedValues.length;
  const computed = Date.parse(pace.computedAt);
  return {
    kind: "known",
    used,
    free: 1 - used,
    known: usedValues.length,
    total: accounts.length,
    status: activeStatus(pace),
    accounts,
    computedAt: Number.isFinite(computed) ? computed : null,
  };
}

/** "B is running at 1.6× its pace" — only at or above {@link PACE_LINE_AT}. */
export function paceLine(account: AccountVitals): string | null {
  if (
    account.paceMultiplier === null ||
    account.paceMultiplier < PACE_LINE_AT
  ) {
    return null;
  }
  return `${account.id} is running at ${account.paceMultiplier.toFixed(1)}× its pace`;
}

/** Whole percent, clamped to 0–100, for bars and labels. */
export function percent(fraction: number): number {
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

/** "12s ago" / "4m ago" / "2h ago" from a ms timestamp. */
export function updatedAgo(computedAt: number | null, nowMs: number): string {
  if (computedAt === null) {
    return "";
  }
  const seconds = Math.max(0, Math.round((nowMs - computedAt) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

// ── /v1/runway ─────────────────────────────────────────────────────────────

export interface Runway {
  /** Σ free across the accounts the hub can read, in ACCOUNTS (1.28 = 128 %). */
  freeFraction: number | null;
  /** One account's quota burned per active hour over the last 48 h. */
  ratePerActiveHour: number | null;
  activeHours: number | null;
  /** freeFraction ÷ rate; null under 3 active intervals. */
  runwayHours: number | null;
  /** The quota window measured (`weeklyAll` today). */
  basis: string | null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Forgiving parse — anything off-shape is null, which hides the line. */
export function parseRunway(json: unknown): Runway | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return null;
  }
  const raw = json as Record<string, unknown>;
  return {
    freeFraction: num(raw.freeFraction),
    ratePerActiveHour: num(raw.ratePerActiveHour),
    activeHours: num(raw.activeHours),
    runwayHours: num(raw.runwayHours),
    basis: typeof raw.basis === "string" ? raw.basis : null,
  };
}

/** "~2h 50m" of active use ("~3d 4h" past two days); null when unknown. */
export function formatRunway(runway: Runway | null): string | null {
  const hours = runway?.runwayHours ?? null;
  if (hours === null || hours < 0) {
    return null;
  }
  const minutes = Math.round(hours * 60);
  if (minutes >= 48 * 60) {
    const wholeHours = Math.round(minutes / 60);
    return `~${Math.floor(wholeHours / 24)}d ${wholeHours % 24}h`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `~${h}h ${m}m` : `~${m}m`;
}

/** 6.48 → "6.5", 16.2 → "16": one decimal only under ten. */
function short(value: number): string {
  return value < 10
    ? String(Math.round(value * 10) / 10)
    : String(Math.round(value));
}

/**
 * The popover's method line (Vitals artboard): how the runway was computed,
 * from the hub's own numbers — "runway = free ÷ use per active hour · 48h:
 * 6.5%/h over 8.3 active h". When the hub has too little active use to
 * divide by, it says so instead of printing a rate of nothing.
 */
export function runwayMethod(runway: Runway | null): string | null {
  if (!runway) {
    return null;
  }
  const rate = runway.ratePerActiveHour;
  const active = runway.activeHours;
  if (runway.runwayHours === null || rate === null || active === null) {
    return active === null
      ? null
      : "runway: too little active use in the last 48h to estimate";
  }
  return `runway = free ÷ use per active hour · 48h: ${short(rate * 100)}%/h over ${short(active)} active h`;
}

export type RunDry =
  /** The next reset lands before the runway could run out. */
  | { kind: "safe"; account: string; resetsAt: string; well: boolean }
  /** Worked without a break, the runway ends before the next reset. */
  | { kind: "tight"; account: string; resetsAt: string };

/**
 * "You won't run dry" (Vitals artboard). The runway is in ACTIVE hours, so
 * the soonest it can end is `now + runwayHours` of wall clock — working
 * without a break. A reset before that is safe whatever the pace; "well
 * inside" when it lands in the first half. No runway or no reset → null.
 */
export function runDryNote(
  runway: Runway | null,
  nextReset: { account: string; resetsAt: string } | null,
  nowMs: number,
): RunDry | null {
  const hours = runway?.runwayHours ?? null;
  if (hours === null || hours < 0 || !nextReset) {
    return null;
  }
  const resetMs = Date.parse(nextReset.resetsAt);
  if (!Number.isFinite(resetMs) || resetMs < nowMs) {
    return null;
  }
  const endMs = nowMs + hours * 3_600_000;
  const { account, resetsAt } = nextReset;
  if (resetMs < endMs) {
    const well = resetMs - nowMs <= (endMs - nowMs) / 2;
    return { kind: "safe", account, resetsAt, well };
  }
  return { kind: "tight", account, resetsAt };
}
