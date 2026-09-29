/**
 * usage-hub client — the one cross-origin read Buzz web makes against the hub
 * (`GET /v1/pace`, CORS-allowlisted for the web origin only).
 *
 * Forgiving by design, following `projects/lib/trackerClient.ts`: any
 * network, HTTP, CORS or parse failure resolves to `null`, which renders no
 * card at all. Unknown values stay `null` — never coerced to 0, because a
 * stale account shown as "0%" reads as "plenty left".
 */

/** usage-hub: measured per-account usage and real quota for each pool. */
export const USAGE_HUB_URL = "https://pilot.tailb3d4b8.ts.net:6770";
export const PACE_URL = `${USAGE_HUB_URL}/v1/pace`;

export type PaceStatus = "ok" | "warn" | "critical" | "unknown";
export type PaceAccountState =
  | "known"
  | "stale"
  | "missing"
  | "logged-out"
  | "reset-pending";

export type PaceAccount = {
  id: string;
  isDefault: boolean;
  /**
   * Whether any agent routes to this pool (default, or agents assigned).
   * `null` when the hub does not send it; the card then falls back to
   * `isDefault`.
   */
  inUse: boolean | null;
  state: PaceAccountState;
  usedFraction: number | null;
  resetsAt: string | null;
  elapsedFraction: number | null;
  projectedAtReset: number | null;
  etaFullAt: string | null;
  basis: string | null;
  status: PaceStatus;
};

export type Pace = {
  v: 1;
  computedAt: string;
  status: PaceStatus;
  nextReset: { account: string; resetsAt: string } | null;
  headroomAccounts: number | null;
  headroomPartial: boolean;
  accounts: PaceAccount[];
};

const STATUSES = new Set<string>(["ok", "warn", "critical", "unknown"]);
const STATES = new Set<string>([
  "known",
  "stale",
  "missing",
  "logged-out",
  "reset-pending",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** ISO timestamp that `Date` can actually parse; anything else is null. */
function dateOrNull(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function parseAccount(raw: unknown): PaceAccount | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id === "") return null;
  if (typeof raw.state !== "string" || !STATES.has(raw.state)) return null;
  if (typeof raw.status !== "string" || !STATUSES.has(raw.status)) return null;
  return {
    id: raw.id,
    isDefault: raw.isDefault === true,
    inUse: typeof raw.inUse === "boolean" ? raw.inUse : null,
    state: raw.state as PaceAccountState,
    usedFraction: numOrNull(raw.usedFraction),
    resetsAt: dateOrNull(raw.resetsAt),
    elapsedFraction: numOrNull(raw.elapsedFraction),
    projectedAtReset: numOrNull(raw.projectedAtReset),
    etaFullAt: dateOrNull(raw.etaFullAt),
    basis: strOrNull(raw.basis),
    status: raw.status as PaceStatus,
  };
}

/** Strict v1 parse: wrong version or shape → null; malformed accounts dropped. */
export function parsePace(json: unknown): Pace | null {
  if (!isRecord(json) || json.v !== 1) return null;
  if (typeof json.status !== "string" || !STATUSES.has(json.status)) {
    return null;
  }
  if (!Array.isArray(json.accounts)) return null;
  const accounts = json.accounts
    .map(parseAccount)
    .filter((account): account is PaceAccount => account !== null);
  let nextReset: Pace["nextReset"] = null;
  if (isRecord(json.nextReset) && typeof json.nextReset.account === "string") {
    const resetsAt = dateOrNull(json.nextReset.resetsAt);
    if (resetsAt) nextReset = { account: json.nextReset.account, resetsAt };
  }
  return {
    v: 1,
    computedAt: strOrNull(json.computedAt) ?? "",
    status: json.status as PaceStatus,
    nextReset,
    headroomAccounts: numOrNull(json.headroomAccounts),
    headroomPartial: json.headroomPartial === true,
    accounts,
  };
}

/**
 * Plain simple GET — no headers, no credentials — so it never preflights
 * (the hub answers OPTIONS with 405). Never throws.
 */
export async function fetchPace(signal?: AbortSignal): Promise<Pace | null> {
  try {
    const response = await fetch(PACE_URL, { signal });
    if (!response.ok) return null;
    return parsePace(await response.json());
  } catch {
    return null;
  }
}
