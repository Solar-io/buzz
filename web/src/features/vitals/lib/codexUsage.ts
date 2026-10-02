/** A usage bucket from the usage hub's /v1/codex contract. */
export interface CodexUsageBucket {
  calls: number;
  totalInput: number;
  output: number;
  listCost: number | null;
  incomplete: boolean;
}

/** A measured quota window; stale readings remain visible with a marker. */
export interface CodexWindow {
  usedFraction: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  capturedAt: string | null;
  stale: boolean;
  source: string;
}

/** Weekly quota and Chicago-calendar usage totals, supplied by the hub. */
export interface CodexVitals {
  v: 1;
  computedAt: string;
  planLabel: string | null;
  planType: string | null;
  weekly: CodexWindow | null;
  short: CodexWindow | null;
  credits: {
    balance: number | null;
    unlimited: boolean | null;
    capturedAt: string | null;
  } | null;
  usage: {
    today: { direct: CodexUsageBucket; routed: CodexUsageBucket };
    last7d: { direct: CodexUsageBucket; routed: CodexUsageBucket };
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function date(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function window(value: unknown): CodexWindow | null {
  const raw = record(value);
  if (
    !raw ||
    typeof raw.stale !== "boolean" ||
    typeof raw.source !== "string"
  ) {
    return null;
  }
  return {
    usedFraction: number(raw.usedFraction),
    resetsAt: date(raw.resetsAt),
    windowMinutes: number(raw.windowMinutes),
    capturedAt: date(raw.capturedAt),
    stale: raw.stale,
    source: raw.source,
  };
}

function bucket(value: unknown): CodexUsageBucket | null {
  const raw = record(value);
  if (!raw) return null;
  const calls = number(raw.calls);
  const totalInput = number(raw.totalInput);
  const output = number(raw.output);
  // Counters are required by the contract. Reject malformed buckets rather
  // than inventing zero calls/tokens for an unknown history.
  if (
    calls === null ||
    totalInput === null ||
    output === null ||
    typeof raw.incomplete !== "boolean"
  ) {
    return null;
  }
  return {
    calls,
    totalInput,
    output,
    listCost: number(raw.listCost),
    incomplete: raw.incomplete,
  };
}

/** Parse v1 without coercing missing, malformed or null values to zero. */
export function parseCodex(json: unknown): CodexVitals | null {
  const raw = record(json);
  if (raw?.v !== 1 || date(raw.computedAt) === null) return null;
  const usage = record(raw.usage);
  const today = record(usage?.today);
  const last7d = record(usage?.last7d);
  const todayDirect = bucket(today?.direct);
  const todayRouted = bucket(today?.routed);
  const weekDirect = bucket(last7d?.direct);
  const weekRouted = bucket(last7d?.routed);
  if (!todayDirect || !todayRouted || !weekDirect || !weekRouted) return null;
  const credits = record(raw.credits);
  return {
    v: 1,
    computedAt: raw.computedAt as string,
    planLabel: string(raw.planLabel),
    planType: string(raw.planType),
    weekly: window(raw.weekly),
    short: window(raw.short),
    credits: credits
      ? {
          balance: number(credits.balance),
          unlimited:
            typeof credits.unlimited === "boolean" ? credits.unlimited : null,
          capturedAt: date(credits.capturedAt),
        }
      : null,
    usage: {
      today: { direct: todayDirect, routed: todayRouted },
      last7d: { direct: weekDirect, routed: weekRouted },
    },
  };
}

/** Calls and credit balances with thousands separators; null is an em dash. */
export function codexNumber(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

/** Token totals in the small usage table, e.g. 1.2M. */
export function codexTokens(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** USD list cost, distinct from subscription spend; ~ marks incomplete totals. */
export function codexCost(value: number | null, incomplete = false): string {
  return value === null
    ? "—"
    : `${incomplete ? "~" : ""}${new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(value)}`;
}

/** An unlimited balance takes precedence; a null balance never becomes 0. */
export function codexCredits(credits: CodexVitals["credits"]): string {
  return credits?.unlimited === true
    ? "unlimited"
    : codexNumber(credits?.balance ?? null);
}

/** Weekly reset in the viewer's zone, always including weekday and time. */
export function codexReset(iso: string | null, timeZone?: string): string {
  return date(iso) === null
    ? "—"
    : new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
        timeZone,
      }).format(new Date(iso as string));
}
