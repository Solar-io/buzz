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
  freeFraction: number | null;
  ratePerActiveHour: number | null;
  activeHours: number | null;
  runwayHours: number | null;
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
  };
}

/** "~2h 50m" of active use; null when the hub cannot say. */
export function formatRunway(runway: Runway | null): string | null {
  const hours = runway?.runwayHours ?? null;
  if (hours === null || hours < 0) {
    return null;
  }
  const minutes = Math.round(hours * 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `~${h}h ${m}m` : `~${m}m`;
}
