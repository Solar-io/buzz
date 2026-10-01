/**
 * Vitals v1 math over the usage hub's `/v1/pace` (phase-1 §4), plus its
 * `/v1/runway` projection: per account, the 72 h average use per CALENDAR
 * hour, carried forward to that account's reset. The hub does that math; this
 * module only picks what to show.
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

export interface AccountVitals {
  id: string;
  state: PaceAccountState;
  status: PaceStatus;
  parked: boolean;
  /** The pool's default — where new sessions go (hub `isDefault`). */
  active: boolean;
  used: number | null;
  /** How much of the account's window has passed — the bar's tick. */
  elapsed: number | null;
  resetsAt: string | null;
  /** used ÷ elapsed; null when elapsed < 5 % or either is unknown. */
  paceMultiplier: number | null;
  /** From /v1/runway: when it hits 100 % at the 72 h rate, if before reset. */
  dryAt: string | null;
  /** From /v1/runway: used fraction projected to the reset (may exceed 1). */
  projectedAtReset: number | null;
  /** From /v1/runway: share of this account's week burned per calendar hour. */
  burnPerHour: number | null;
  /** From /v1/runway: hours of history the rate averages (≤ 72). */
  historyHours: number | null;
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

/**
 * One account's row. The projection — and the status colour, when the
 * runway has one — comes from `/v1/runway`; the reading and the window from
 * `/v1/pace`. Pace's own trailing-24 h projection is no longer shown: two
 * forecasts on one panel would disagree.
 */
export function accountVitals(
  pace: Pace,
  account: PaceAccount,
  runway: Runway | null = null,
): AccountVitals {
  const known = account.state === "known";
  const used = known ? account.usedFraction : null;
  const elapsed = known ? account.elapsedFraction : null;
  const paceMultiplier =
    used !== null && elapsed !== null && elapsed >= MIN_ELAPSED_FOR_PACE
      ? used / elapsed
      : null;
  const forecast =
    runway?.accounts.find((entry) => entry.id === account.id) ?? null;
  return {
    id: account.id,
    state: account.state,
    status:
      forecast && forecast.status !== "unknown"
        ? forecast.status
        : account.status,
    parked: isParked(pace, account),
    active: account.isDefault,
    used,
    elapsed,
    resetsAt: account.resetsAt,
    paceMultiplier,
    dryAt: known ? (forecast?.dryAt ?? null) : null,
    projectedAtReset: known ? (forecast?.projectedAtReset ?? null) : null,
    burnPerHour: forecast?.burnPerHour ?? null,
    historyHours: forecast?.historyHours ?? null,
  };
}

/**
 * The account row's right-hand text. A warn/critical row names when it runs
 * dry instead of its reset, so the red is never a colour to decode (Sam,
 * 2026-10-01). `clock` formats an ISO time; `unknown` explains a null usage.
 */
export function accountRowText(
  account: AccountVitals,
  clock: (iso: string) => string,
  unknown: string,
): string {
  if (account.used === null) {
    return unknown;
  }
  const used = `${percent(account.used)}%`;
  const hot = account.status === "warn" || account.status === "critical";
  if (hot && account.dryAt) {
    return `${used} · runs dry ${clock(account.dryAt)}`;
  }
  return account.resetsAt
    ? `${used} · resets ${clock(account.resetsAt)}`
    : used;
}

/** The combined bar: free = 1 − mean(known usedFraction). */
export function vitalsSummary(
  pace: Pace | null,
  runway: Runway | null = null,
): VitalsSummary {
  if (!pace) {
    return { kind: "unavailable", total: 0, accounts: [] };
  }
  const accounts = pace.accounts.map((account) =>
    accountVitals(pace, account, runway),
  );
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
    // Pace's parked-account rule, applied to the statuses the rows show.
    status: activeStatus({
      ...pace,
      status:
        runway && runway.status !== "unknown" ? runway.status : pace.status,
      accounts: pace.accounts.map((account, index) => ({
        ...account,
        status: accounts[index]?.status ?? account.status,
      })),
    }),
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

export interface RunwayAccount {
  id: string;
  usedFraction: number | null;
  resetsAt: string | null;
  /** Wall-clock hours the rate averages over (≤ lookbackHours). */
  historyHours: number | null;
  /** Share of this account's weekly quota burned per calendar hour. */
  burnPerHour: number | null;
  projectedAtReset: number | null;
  dryAt: string | null;
  status: PaceStatus;
}

export interface Runway {
  /** How far back the hub averages (72 h). */
  lookbackHours: number | null;
  /** The quota window measured (`weeklyAll` today). */
  basis: string | null;
  /** Worst account status from the projection. */
  status: PaceStatus;
  accounts: RunwayAccount[];
}

const STATUSES: readonly PaceStatus[] = ["ok", "warn", "critical", "unknown"];

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function statusOf(value: unknown): PaceStatus {
  return STATUSES.includes(value as PaceStatus)
    ? (value as PaceStatus)
    : "unknown";
}

/**
 * Forgiving parse — anything off-shape is null or dropped, which hides the
 * line. A pre-v2 hub (active-hour fields, no `accounts`) parses to no
 * accounts: nothing is projected rather than something wrong.
 */
export function parseRunway(json: unknown): Runway | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return null;
  }
  const raw = json as Record<string, unknown>;
  const accounts: RunwayAccount[] = [];
  for (const entry of Array.isArray(raw.accounts) ? raw.accounts : []) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const a = entry as Record<string, unknown>;
    if (typeof a.id !== "string") {
      continue;
    }
    accounts.push({
      id: a.id,
      usedFraction: num(a.usedFraction),
      resetsAt: str(a.resetsAt),
      historyHours: num(a.historyHours),
      burnPerHour: num(a.burnPerHour),
      projectedAtReset: num(a.projectedAtReset),
      dryAt: str(a.dryAt),
      status: statusOf(a.status),
    });
  }
  return {
    lookbackHours: num(raw.lookbackHours),
    basis: str(raw.basis),
    status: statusOf(raw.status),
    accounts,
  };
}

export type Outlook =
  /** The soonest in-use account to hit 100 % before its own reset. */
  | { kind: "dry"; account: string; at: string }
  /** Every in-use account with a projection lasts to its reset. */
  | { kind: "safe" };

/**
 * The headline: does anything run dry before it resets, at the 72 h pace?
 * Parked accounts are left out (they take no work) unless every account is
 * parked. No projection anywhere → null, and the headline hides.
 */
export function runwayOutlook(summary: VitalsSummary): Outlook | null {
  if (summary.kind !== "known") {
    return null;
  }
  const active = summary.accounts.filter((account) => !account.parked);
  const pool = active.length > 0 ? active : summary.accounts;
  let dry: { account: string; at: string; ms: number } | null = null;
  let projected = 0;
  for (const account of pool) {
    if (account.projectedAtReset === null) {
      continue;
    }
    projected++;
    const ms = account.dryAt ? Date.parse(account.dryAt) : Number.NaN;
    if (account.dryAt && Number.isFinite(ms) && (!dry || ms < dry.ms)) {
      dry = { account: account.id, at: account.dryAt, ms };
    }
  }
  if (dry) {
    return { kind: "dry", account: dry.account, at: dry.at };
  }
  return projected > 0 ? { kind: "safe" } : null;
}

/** 6.48 → "6.5", 16.2 → "16": one decimal only under ten. */
function short(value: number): string {
  return value < 10
    ? String(Math.round(value * 10) / 10)
    : String(Math.round(value));
}

/**
 * The popover's method line, from the hub's own numbers: "72h average,
 * carried forward to each reset: A 1.4%/h · B 0.4%/h". An account with less
 * than the full window of history is noted quietly ("B: 31h of history").
 */
export function runwayMethod(runway: Runway | null): string | null {
  if (!runway || runway.accounts.length === 0) {
    return null;
  }
  const lookback = runway.lookbackHours ?? 72;
  const rated = runway.accounts.filter((a) => a.burnPerHour !== null);
  if (rated.length === 0) {
    return `not enough history in the last ${lookback}h to project yet`;
  }
  const rates = rated
    .map((a) => `${a.id} ${short((a.burnPerHour ?? 0) * 100)}%/h`)
    .join(" · ");
  // A full window of 10-minute samples spans just under the lookback.
  const thin = rated
    .filter((a) => a.historyHours !== null && a.historyHours < lookback - 1)
    .map((a) => `${a.id}: ${Math.round(a.historyHours ?? 0)}h of history`);
  const note = thin.length > 0 ? ` (${thin.join(", ")})` : "";
  return `${lookback}h average, carried forward to each reset: ${rates}${note}`;
}
