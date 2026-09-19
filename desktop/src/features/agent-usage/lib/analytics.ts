import type { CostField, UsageField } from "@/shared/api/tauriArchive";

export const RANGES = [
  "1D",
  "7D",
  "30D",
  "90D",
  "YTD",
  "All",
  "Custom",
] as const;
export type UsageRange = (typeof RANGES)[number];
export type UsageSearch = {
  agents?: string;
  range?: string;
  start?: string;
  end?: string;
};
export const USAGE_SEARCH_KEYS = ["agents", "range", "start", "end"] as const;

export function validateUsageSearch(
  search: Record<string, unknown>,
): UsageSearch {
  return Object.fromEntries(
    USAGE_SEARCH_KEYS.flatMap((key) =>
      typeof search[key] === "string" ? [[key, search[key]]] : [],
    ),
  );
}
export function selectedAgents(value?: string | null): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .filter((key) => /^[a-f0-9]{64}$/i.test(key))
        .map((key) => key.toLowerCase()),
    ),
  ].sort();
}
export function civilDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function parseCivilDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const result = new Date(year, month - 1, day);
  return civilDate(result) === value ? result : null;
}
/** Civil calendar increments preserve 23/25-hour days at DST transitions. */
export function usageWindow(
  search: UsageSearch,
  now = new Date(),
  firstReportedAt?: number | null,
) {
  const range: UsageRange = RANGES.includes(search.range as UsageRange)
    ? (search.range as UsageRange)
    : "30D";
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  let start = new Date(end);
  if (range === "Custom") {
    const from = parseCivilDate(search.start ?? "");
    const through = parseCivilDate(search.end ?? "");
    if (!from || !through || from > through)
      return {
        error: "Choose valid dates with the start on or before the end.",
        range,
      } as const;
    start = from;
    end.setTime(through.getTime());
    end.setDate(end.getDate() + 1);
  } else if (range === "YTD") start = new Date(now.getFullYear(), 0, 1);
  else if (range === "All") {
    start =
      firstReportedAt == null
        ? new Date(end.getFullYear(), end.getMonth(), end.getDate() - 30)
        : new Date(firstReportedAt * 1000);
    start.setHours(0, 0, 0, 0);
  } else start.setDate(start.getDate() - Number.parseInt(range, 10));
  const dayBoundaries: number[] = [];
  const dayLabels: string[] = [];
  for (
    const cursor = new Date(start);
    cursor < end;
    cursor.setDate(cursor.getDate() + 1)
  ) {
    dayBoundaries.push(Math.floor(cursor.getTime() / 1000));
    dayLabels.push(civilDate(cursor));
    if (dayLabels.length > 36600)
      return { error: "Choose a range of 100 years or fewer.", range } as const;
  }
  dayBoundaries.push(Math.floor(end.getTime() / 1000));
  let bucketBoundaries = dayBoundaries;
  if (dayLabels.length === 1) {
    bucketBoundaries = [];
    for (let time = dayBoundaries[0]; time < dayBoundaries[1]; time += 3600)
      bucketBoundaries.push(time);
    bucketBoundaries.push(dayBoundaries[1]);
  } else if (dayLabels.length > 120) {
    const step = dayLabels.length > 400 ? 30 : 7;
    bucketBoundaries = dayBoundaries.filter((_, index) => index % step === 0);
    if (bucketBoundaries.at(-1) !== dayBoundaries.at(-1))
      bucketBoundaries.push(dayBoundaries[dayBoundaries.length - 1]);
  }
  return {
    range,
    request: {
      bucketBoundaries,
      dayBoundaries,
      dayLabels,
      agentPubkeys: selectedAgents(search.agents),
      selectNone: search.agents === "none",
    },
    error: null,
  } as const;
}

export function exactTokens(field: UsageField): string {
  return field.value === null
    ? "Not reported"
    : `${BigInt(field.value).toLocaleString()}${field.incomplete ? " (partial)" : ""}`;
}
export function compactTokens(field: UsageField): string {
  if (field.value === null) return "—";
  const value = BigInt(field.value);
  const suffixes = [
    [1_000_000_000_000n, "T"],
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
    [1_000n, "K"],
  ] as const;
  for (const [scale, suffix] of suffixes)
    if (value >= scale) {
      const tenths = (value * 10n + scale / 2n) / scale;
      return `${tenths / 10n}.${tenths % 10n}${suffix}${field.incomplete ? "+" : ""}`;
    }
  return `${value.toLocaleString()}${field.incomplete ? "+" : ""}`;
}
export function money(field: CostField): string {
  return field.value === null
    ? "—"
    : `${new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: field.value > 0 && field.value < 0.01 ? 6 : 2 }).format(field.value)}${field.incomplete ? "+" : ""}`;
}
/** Only visual proportions use floating point; displayed/exported counts stay exact. */
export function tokenShare(value: string | null, total: string | null): number {
  if (value == null || total == null || BigInt(total) === 0n) return 0;
  return Number((BigInt(value) * 1_000_000n) / BigInt(total)) / 10_000;
}
export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function csvDocument(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}
