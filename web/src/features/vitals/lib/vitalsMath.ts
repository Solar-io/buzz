/**
 * Vitals v1 math over the usage hub's `/v1/pace` (phase-1 §4), plus its
 * `/v1/runway` rates: the 72 h average use per CALENDAR hour. The combined
 * simulation carries pool demand forward through handoffs and resets; its
 * per-account projections and headline describe the same forecast.
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
 * The account row's right-hand text: used % and when it resets, the same
 * shape on every row (Sam, 2026-10-01: the red row says its reset too).
 * `clock` formats an ISO time; `unknown` explains a null usage.
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
  return account.resetsAt
    ? `${used} · resets ${clock(account.resetsAt)}`
    : used;
}

/**
 * The second line under a warn/critical row: when it runs dry, so the red is
 * never a colour to decode (Sam, 2026-10-01). Null when the row is not hot
 * or has no projection.
 */
export function accountDryText(
  account: AccountVitals,
  clock: (iso: string) => string,
  combined: CombinedRunway | null = null,
): string | null {
  const hot = account.status === "warn" || account.status === "critical";
  const projection = combined?.projections.find((row) => row.id === account.id);
  const dry = projection
    ? projection.beforeReset
      ? projection.dryAt
      : null
    : account.dryAt;
  return account.used !== null && hot && dry ? `runs dry ${clock(dry)}` : null;
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
  /** Saturday/Sunday hours project at this multiple of the rate (1.5). */
  weekendFactor: number | null;
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
    weekendFactor: num(raw.weekendFactor),
    basis: str(raw.basis),
    status: statusOf(raw.status),
    accounts,
  };
}

// ── Combined runway: when does EVERY account run dry? ─────────────────────

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
/** How far ahead the combined simulation looks before calling it "lasts". */
export const COMBINED_HORIZON_DAYS = 14;
/** Sam's own time zone — the hub counts Sat/Sun hours here as weekend. */
const WEEKEND_TZ = "America/Chicago";
const weekdayOf = new Intl.DateTimeFormat("en-US", {
  timeZone: WEEKEND_TZ,
  weekday: "short",
});

/**
 * Weight of the calendar hour containing `ms`, matching the hub's
 * `hourWeight` (usage-hub src/runway.ts): Saturday/Sunday in Chicago count
 * `weekendFactor` hours. Chicago's offset is whole hours, so a UTC hour never
 * straddles a local midnight.
 */
function hourWeight(ms: number, weekendFactor: number): number {
  const day = weekdayOf.format(new Date(ms));
  return day === "Sat" || day === "Sun" ? weekendFactor : 1;
}

/** An account's path through the same allocation used by the pool headline. */
export interface AccountRunway {
  id: string;
  /** First empty moment within the horizon, including an already empty account. */
  dryAt: string | null;
  /** Whether the first empty moment is strictly before its next reset. */
  beforeReset: boolean;
  /** Next reset, advanced a week when the supplied reading predates it. */
  resetsAt: string;
  /** Simulated used share immediately before that reset; null if not reached. */
  projectedAtReset: number | null;
  /** The depleted account whose work this account first takes over. */
  takeover: { account: string; at: string } | null;
}

export type CombinedRunway = {
  projections: AccountRunway[];
} /** Every pool account is at 100 % at `at` (ISO). */ & (
  | {
      kind: "dry";
      accounts: string[];
      at: string;
      /**
       * The first reset (of any pool account) the pool survives to, when the
       * all-dry moment lands after it; null when it lands before every reset.
       */
      pastReset: { account: string; at: string; ms: number } | null;
    }
  /** Not all dry within {@link COMBINED_HORIZON_DAYS} days. */
  | { kind: "lasts"; accounts: string[]; days: number }
);

interface SimAccount {
  id: string;
  /** Unused share of this account's week, 0–1. */
  left: number;
  resetMs: number;
  projection: AccountRunway;
  started: boolean;
}

/**
 * When does the WHOLE pool run dry (Sam, 2026-10-02: "when BOTH accounts are
 * estimated to run dry")? Simulates forward from `nowMs`:
 *
 * - Pool: EVERY account with a known reading, a reset time and a 72 h rate —
 *   parked ones included (Sam, 2026-10-02: "both accounts"). A parked account
 *   takes no work today but is where the balancer moves when the active one
 *   dries, so its room and its own rate both count. Others are left out.
 * - Demand per hour: the sum of the pool's `burnPerHour`, weekend hours
 *   (Sat/Sun, America/Chicago) × `runway.weekendFactor` — the hub's method.
 * - That demand drains whichever accounts still have room, the soonest-reset
 *   account first (use it or lose it): an account that dries early hands its
 *   work to the others.
 * - At its reset an account refills to 0 % used; its next reset is +7 days.
 *
 * Steps are exact segments between UTC hour boundaries and resets, so the
 * answer does not depend on a step size.
 *
 * ASSUMPTION: every account has the same weekly quota. The hub reports only
 * fractions (`usedFraction`, `burnPerHour`) and no plan/size per account, so
 * 1 % of A is treated as the same amount of work as 1 % of B.
 *
 * Null when there is nothing to simulate (no known summary, empty pool).
 */
export function combinedRunway(
  summary: VitalsSummary,
  runway: Runway | null,
  nowMs: number,
): CombinedRunway | null {
  if (summary.kind !== "known" || !Number.isFinite(nowMs)) {
    return null;
  }
  const candidates = summary.accounts;
  const pool: SimAccount[] = [];
  let demand = 0;
  for (const account of candidates) {
    const resetMs = account.resetsAt
      ? Date.parse(account.resetsAt)
      : Number.NaN;
    if (
      account.used === null ||
      account.burnPerHour === null ||
      !Number.isFinite(resetMs)
    ) {
      continue;
    }
    let next = resetMs;
    let left = Math.max(0, Math.min(1, 1 - account.used));
    // A reset already past (the reading predates it) has refilled.
    while (next <= nowMs) {
      next += WEEK_MS;
      left = 1;
    }
    pool.push({
      id: account.id,
      left,
      resetMs: next,
      started: false,
      projection: {
        id: account.id,
        dryAt: left === 0 ? new Date(nowMs).toISOString() : null,
        beforeReset: left === 0,
        resetsAt: new Date(next).toISOString(),
        projectedAtReset: null,
        takeover: null,
      },
    });
    demand += Math.max(0, account.burnPerHour);
  }
  if (pool.length === 0) {
    return null;
  }
  const ids = pool.map((account) => account.id);
  const weekendFactor = runway?.weekendFactor ?? 1;
  const first = pool.reduce((soonest, account) =>
    account.resetMs < soonest.resetMs ? account : soonest,
  );
  const firstReset = { account: first.id, ms: first.resetMs };
  const end = nowMs + COMBINED_HORIZON_DAYS * 24 * HOUR_MS;
  // Keep the existing enumerable result/wire shape (and its exact headline
  // contract) intact. Local consumers read the additional trace explicitly.
  const traced = <T extends object>(result: T) =>
    Object.defineProperty(result, "projections", {
      value: pool.map((account) => account.projection),
    }) as T & { projections: AccountRunway[] };

  const dryAt = (exact: number): CombinedRunway => {
    const ms = Math.round(exact);
    const at = new Date(ms).toISOString();
    for (const account of pool) {
      // Match the pool's numerical empty tolerance, including the final
      // segment that ends exactly at an account's next reset.
      account.projection.dryAt ??= at;
      account.projection.beforeReset =
        Date.parse(account.projection.dryAt) <
        Date.parse(account.projection.resetsAt);
      if (account.resetMs <= ms) {
        account.projection.projectedAtReset ??= 1 - account.left;
      }
    }
    return traced({
      kind: "dry",
      accounts: ids,
      at,
      pastReset:
        ms > firstReset.ms
          ? {
              account: firstReset.account,
              at: new Date(firstReset.ms).toISOString(),
              ms: ms - firstReset.ms,
            }
          : null,
    } as const);
  };

  let previous: SimAccount | undefined;
  const drain = (need: number, rate: number, t: number) => {
    let spent = 0;
    for (const account of [...pool].sort((a, b) => a.resetMs - b.resetMs)) {
      if (account.left === 0) {
        previous = account;
        continue;
      }
      if (!account.started && previous?.left === 0) {
        account.projection.takeover = {
          account: previous.id,
          at: new Date(Math.round(t + (spent / rate) * HOUR_MS)).toISOString(),
        };
      }
      account.started = true;
      const take = Math.min(account.left, need);
      account.left -= take;
      need -= take;
      spent += take;
      if (account.left === 0) {
        const ms = Math.round(t + (spent / rate) * HOUR_MS);
        account.projection.dryAt ??= new Date(ms).toISOString();
        account.projection.beforeReset =
          Date.parse(account.projection.dryAt) <
          Date.parse(account.projection.resetsAt);
        previous = account;
      }
      if (need <= 0) break;
    }
  };
  let t = nowMs;
  while (t < end) {
    const total = pool.reduce((sum, account) => sum + account.left, 0);
    if (total <= 1e-12) {
      return dryAt(t);
    }
    const nextHour = (Math.floor(t / HOUR_MS) + 1) * HOUR_MS;
    const nextReset = Math.min(...pool.map((account) => account.resetMs));
    const segEnd = Math.min(nextHour, nextReset, end);
    const rate = demand * hourWeight(t, weekendFactor);
    const need = (rate * (segEnd - t)) / HOUR_MS;
    if (rate > 0 && need >= total) {
      drain(total, rate, t);
      return dryAt(t + (total / rate) * HOUR_MS);
    }
    // Soonest reset first: its unused room is lost at the reset anyway.
    if (rate > 0) drain(need, rate, t);
    t = segEnd;
    for (const account of pool) {
      if (account.resetMs <= t) {
        account.projection.projectedAtReset ??= 1 - account.left;
        account.left = 1;
        account.resetMs += WEEK_MS;
      }
    }
  }
  return traced({
    kind: "lasts",
    accounts: ids,
    days: COMBINED_HORIZON_DAYS,
  } as const);
}

/** "Both" for two, "All 3" for more, the account itself for one. */
function poolName(accounts: readonly string[]): string {
  if (accounts.length === 1) {
    return accounts[0] ?? "";
  }
  return accounts.length === 2 ? "Both" : `All ${accounts.length}`;
}

/** "+9h" under a day, "+1 day" / "+2 days" (rounded) beyond. */
export function pastResetSpan(ms: number): string {
  const hours = Math.round(ms / HOUR_MS);
  if (hours < 1) {
    return "+<1h";
  }
  if (hours < 24) {
    return `+${hours}h`;
  }
  const days = Math.round(ms / (24 * HOUR_MS));
  return `+${days} day${days === 1 ? "" : "s"}`;
}

/** The popover headline in three parts: lead, bold, trailing. */
export interface CombinedHeadline {
  lead: string;
  strong: string;
  rest: string;
}

/**
 * The popover headline for {@link combinedRunway}:
 * - "Both run dry around **Sat 9:07 AM**"
 * - "Both run dry around **Sat 9:07 AM** · +4 days past A's Tue 8:00 AM reset"
 * - "**Both last** 2+ weeks at your recent pace"
 */
export function combinedHeadline(
  combined: CombinedRunway,
  clock: (iso: string) => string,
): CombinedHeadline {
  const name = poolName(combined.accounts);
  const single = combined.accounts.length === 1;
  if (combined.kind === "lasts") {
    return {
      lead: "",
      strong: `${name} ${single ? "lasts" : "last"}`,
      rest: ` ${combined.days / 7}+ weeks at your recent pace`,
    };
  }
  const past = combined.pastReset;
  return {
    lead: `${name} ${single ? "runs" : "run"} dry around `,
    strong: clock(combined.at),
    rest: past
      ? ` · ${pastResetSpan(past.ms)} past ${past.account}'s ${clock(past.at)} reset`
      : "",
  };
}

/** The sidebar's short form: "both dry Sat 9:07 AM · +4 days" / "lasts 2+ wks". */
export function combinedShort(
  combined: CombinedRunway | null,
  clock: (iso: string) => string,
): string | null {
  if (!combined) {
    return null;
  }
  if (combined.kind === "lasts") {
    return `lasts ${combined.days / 7}+ wks`;
  }
  const name = poolName(combined.accounts);
  const who = combined.accounts.length === 1 ? name : name.toLowerCase();
  const past = combined.pastReset
    ? ` · ${pastResetSpan(combined.pastReset.ms)}`
    : "";
  return `${who} dry ${clock(combined.at)}${past}`;
}

/** 6.48 → "6.5", 16.2 → "16": one decimal only under ten. */
function short(value: number): string {
  return value < 10
    ? String(Math.round(value * 10) / 10)
    : String(Math.round(value));
}

/**
 * The popover's method line, from the hub's own numbers: "72h average,
 * weekends ×1.5, carried forward to each reset: A 1.4%/h · B 0.4%/h". An account with less
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
  const weekend =
    runway.weekendFactor !== null && runway.weekendFactor !== 1
      ? `, weekends ×${runway.weekendFactor}`
      : "";
  return `${lookback}h average${weekend}, carried forward to each reset: ${rates}${note}`;
}
