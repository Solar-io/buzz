import type {
  AgentUsageAnalytics,
  AgentUsageAnalyticsRequest,
  AnalyticsMetricGroup,
  AnalyticsTimeBucket,
  UsageField,
} from "@/shared/api/tauriArchive";

/** E2E fixtures only. Production analytics are computed by the Rust archive. */
export type MockUsageReport = {
  agent: string;
  at: number;
  input: string | null;
  output: string | null;
  cost: number | null;
  provider?: string;
  account?: string;
  model?: string;
  tier?: string;
};
export type MockUsageAnalytics = {
  reports?: MockUsageReport[];
  error?: string;
  delayMs?: number;
  collectionEnabled?: boolean;
};
function aggregate(
  key: string,
  label: string,
  reports: MockUsageReport[],
): AnalyticsMetricGroup {
  const sum = (field: "input" | "output"): UsageField => ({
    value: reports.some((row) => row[field] !== null)
      ? reports
          .reduce((total, row) => total + BigInt(row[field] ?? "0"), 0n)
          .toString()
      : null,
    incomplete: reports.some((row) => row[field] === null),
  });
  const input = sum("input");
  const output = sum("output");
  const cost = {
    value: reports.some((row) => row.cost !== null)
      ? reports.reduce((total, row) => total + (row.cost ?? 0), 0)
      : null,
    incomplete: reports.some((row) => row.cost === null),
  };
  const unknown = { value: null, incomplete: reports.length > 0 };
  return {
    key,
    label,
    reportCount: reports.length,
    requestCount: null,
    costs: { wireReported: cost, manifestEstimated: unknown, unknown },
    avgLatencyMs: unknown,
    fallbackCount: null,
    usage: {
      inputTokens: input,
      outputTokens: output,
      totalTokens: {
        value:
          input.value === null && output.value === null
            ? null
            : (
                BigInt(input.value ?? "0") + BigInt(output.value ?? "0")
              ).toString(),
        incomplete: input.incomplete || output.incomplete,
      },
      estimatedCostUsd: cost,
      cacheReadTokens: unknown,
      cacheWriteTokens: unknown,
      freshInputTokens: unknown,
    },
  };
}
export function mockUsageAnalytics(
  request: AgentUsageAnalyticsRequest,
  seed: MockUsageAnalytics = {},
): AgentUsageAnalytics {
  const all = seed.reports ?? [];
  const selected = all.filter(
    (row) =>
      !request.selectNone &&
      (!request.agentPubkeys?.length ||
        request.agentPubkeys.includes(row.agent)),
  );
  const rows = selected.filter(
    (row) =>
      row.at >= request.dayBoundaries[0] &&
      row.at < request.dayBoundaries[request.dayBoundaries.length - 1],
  );
  const group = (field: "provider" | "agent" | "account" | "model" | "tier") =>
    Array.from(new Set(rows.map((row) => row[field] ?? "__unknown__"))).map(
      (key) =>
        aggregate(
          key,
          key === "__unknown__" ? "Not reported" : key,
          rows.filter((row) => (row[field] ?? "__unknown__") === key),
        ),
    );
  const buckets = (
    boundaries: number[],
    labels?: string[],
  ): AnalyticsTimeBucket[] =>
    boundaries.slice(0, -1).map((start, index) => ({
      ...aggregate(
        String(start),
        labels?.[index] ??
          new Date(start * 1000).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          }),
        rows.filter((row) => row.at >= start && row.at < boundaries[index + 1]),
      ),
      start,
      end: boundaries[index + 1],
    }));
  const days = buckets(request.dayBoundaries, request.dayLabels);
  const providers = group("provider");
  const summary = aggregate("all", "All", rows);
  const providerByDate = days
    .flatMap((day) =>
      providers.map((provider) => ({
        ...aggregate(
          `${day.label}/${provider.key}`,
          `${day.label} · ${provider.label}`,
          rows.filter(
            (row) =>
              row.at >= day.start &&
              row.at < day.end &&
              (row.provider ?? "__unknown__") === provider.key,
          ),
        ),
        date: day.label,
        provider: provider.label,
      })),
    )
    .filter((row) => row.reportCount);
  const known = providers.filter((row) => row.key !== "__unknown__");
  const knownReports = known.reduce((sum, row) => sum + row.reportCount, 0);
  const shares = known.map((row) => ({
    provider: row.label,
    share: row.reportCount / knownReports,
  }));
  const timestamps = rows.map((row) => row.at);
  const first = timestamps.length ? Math.min(...timestamps) : null;
  const last = timestamps.length ? Math.max(...timestamps) : null;
  const busiest = [...days].sort((a, b) =>
    Number(
      BigInt(b.usage.totalTokens.value ?? "0") -
        BigInt(a.usage.totalTokens.value ?? "0"),
    ),
  )[0];
  const models = group("model");
  return {
    collectionEnabled: seed.collectionEnabled ?? true,
    summary,
    timeline: buckets(request.bucketBoundaries),
    days,
    weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(
      (label, index) =>
        aggregate(
          String(index),
          label,
          rows.filter(
            (row) => (new Date(row.at * 1000).getDay() + 6) % 7 === index,
          ),
        ),
    ),
    providers,
    providerByDate,
    agents: group("agent"),
    models,
    accounts: group("account"),
    serviceTiers: group("tier"),
    availableAgents: [...new Set(all.map((row) => row.agent))],
    highlights: {
      busiestDay: busiest?.reportCount ? busiest.label : null,
      topModel: models[0]?.label ?? null,
      topAgent: rows[0]?.agent ?? null,
      activeDays: days.filter((day) => day.reportCount).length,
    },
    diversity: {
      score: knownReports
        ? known.length <= 1
          ? 0
          : (-shares.reduce(
              (sum, row) => sum + row.share * Math.log(row.share),
              0,
            ) /
              Math.log(known.length)) *
            100
        : null,
      providerCount: known.length,
      knownReportCount: knownReports,
      totalReportCount: rows.length,
      recentScore: null,
      recentStart: Math.floor(Date.now() / 1000) - 3600,
      shares,
    },
    coverage: {
      firstArchivedAt: first,
      lastArchivedAt: last,
      firstReportedAt: first,
      lastReportedAt: last,
      archiveFirstReportedAt: selected.length
        ? Math.min(...selected.map((row) => row.at))
        : null,
      archiveLastReportedAt: selected.length
        ? Math.max(...selected.map((row) => row.at))
        : null,
      reportCount: rows.length,
      invalidReportCount: 0,
      hasUnknownUsage: rows.some(
        (row) => row.input === null || row.output === null || row.cost === null,
      ),
      providerReports: rows.filter((row) => row.provider).length,
      accountReports: rows.filter((row) => row.account).length,
      tierReports: rows.filter((row) => row.tier).length,
      completeRequestReports: 0,
      requestObservationCount: 0,
      inconsistentRequestReports: 0,
      costProvenanceReports: rows.filter((row) => row.cost !== null).length,
    },
  };
}
