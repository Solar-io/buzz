import { ArrowDownToLine, ArrowUpFromLine, Coins, Layers } from "lucide-react";
import type {
  AgentUsageAnalytics,
  AnalyticsMetricGroup,
} from "@/shared/api/tauriArchive";
import { compactTokens, exactTokens, ioRatio, money } from "../lib/analytics";
import { UsageCard } from "./UsageCharts";

export function UsageSummary({ data }: { data: AgentUsageAnalytics }) {
  const { summary, highlights } = data;
  const known = (rows: AnalyticsMetricGroup[]) =>
    rows.filter((row) => row.key !== "__unknown__").length;
  const average =
    summary.usage.totalTokens.value === null || !summary.reportCount
      ? "—"
      : compactTokens({
          value: (
            BigInt(summary.usage.totalTokens.value) /
            BigInt(summary.reportCount)
          ).toString(),
          incomplete: summary.usage.totalTokens.incomplete,
        });
  // Carries the partial marker its band-neighbours carry. The ratio divides one
  // population by another, so it is marked when *either* side is incomplete —
  // a complete input over a partial output is not a confident number.
  const ratio = ioRatio(summary.usage.inputTokens, summary.usage.outputTokens);
  const topProvider =
    [...data.providers]
      .filter(
        (row) =>
          row.key !== "__unknown__" &&
          !row.usage.totalTokens.incomplete &&
          row.usage.totalTokens.value !== null,
      )
      .sort((a, b) =>
        BigInt(a.usage.totalTokens.value ?? "0") <
        BigInt(b.usage.totalTokens.value ?? "0")
          ? 1
          : -1,
      )[0]?.label ?? "—";
  const fast = data.serviceTiers.find(
    (tier) => tier.key.toLowerCase() === "fast",
  );
  const bands = [
    {
      title: "Infrastructure",
      fields: [
        ["Accounts", known(data.accounts)],
        ["Providers", known(data.providers)],
        ["Agents", data.agents.length],
        ["Models", known(data.models)],
      ],
    },
    {
      title: "Performance",
      fields: [
        ["Avg tokens / turn", average],
        [
          "Cost / turn",
          money({
            value:
              summary.usage.estimatedCostUsd.value === null ||
              !summary.reportCount
                ? null
                : summary.usage.estimatedCostUsd.value / summary.reportCount,
            incomplete: summary.usage.estimatedCostUsd.incomplete,
          }),
        ],
        ["I/O ratio", ratio],
        ["Fast requests", fast?.requestCount ?? "— Not reported"],
      ],
    },
    {
      title: "Highlights",
      fields: [
        ["Top model", highlights.topModel ?? "—"],
        ["Top provider", topProvider],
        ["Busiest day", highlights.busiestDay ?? "—"],
        [
          "Diversity",
          data.diversity.score === null
            ? "—"
            : `${data.diversity.score.toFixed(1)}%`,
        ],
        [
          "Fallback rate",
          summary.fallbackCount === null ||
          summary.requestCount === null ||
          BigInt(summary.requestCount) === 0n
            ? "— Not reported"
            : `${(Number((BigInt(summary.fallbackCount) * 10000n) / BigInt(summary.requestCount)) / 100).toFixed(1)}%`,
        ],
      ],
    },
  ];
  return (
    <>
      <div className="usage-kpis">
        <div className="usage-card usage-kpi">
          <h2>
            <Layers size={16} />
            Total tokens
          </h2>
          <strong
            data-testid="usage-total"
            title={exactTokens(summary.usage.totalTokens)}
          >
            {compactTokens(summary.usage.totalTokens)}
          </strong>
          <p>
            {summary.reportCount.toLocaleString()} Turns
            {summary.requestCount !== null
              ? ` · ${BigInt(summary.requestCount).toLocaleString()} requests`
              : " · Requests not reported"}
          </p>
        </div>
        <div className="usage-card usage-kpi usage-input">
          <h2>
            <ArrowDownToLine size={16} />
            Input tokens
          </h2>
          <strong title={exactTokens(summary.usage.inputTokens)}>
            {compactTokens(summary.usage.inputTokens)}
          </strong>
          <p>
            Fresh {compactTokens(summary.usage.freshInputTokens)} · Cache read{" "}
            {compactTokens(summary.usage.cacheReadTokens)} · Write{" "}
            {compactTokens(summary.usage.cacheWriteTokens)}
          </p>
        </div>
        <div className="usage-card usage-kpi usage-output">
          <h2>
            <ArrowUpFromLine size={16} />
            Output tokens
          </h2>
          <strong title={exactTokens(summary.usage.outputTokens)}>
            {compactTokens(summary.usage.outputTokens)}
          </strong>
          <p>As reported by each agent</p>
        </div>
        <div className="usage-card usage-kpi usage-cost">
          <h2>
            <Coins size={16} />
            Est. cost
          </h2>
          <strong data-testid="usage-cost">
            Wire {money(summary.costs.wireReported)} · Manifest{" "}
            {money(summary.costs.manifestEstimated)}
          </strong>
          <p>Unknown source {money(summary.costs.unknown)} · never blended</p>
        </div>
      </div>
      <section className="usage-card usage-summary" aria-label="Usage summary">
        {bands.map((band) => (
          <div className="usage-summary-band" key={band.title}>
            <h2>{band.title}</h2>
            <dl>
              {band.fields.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd title={String(value)}>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </section>
    </>
  );
}

export function ServiceTiers({ data }: { data: AgentUsageAnalytics }) {
  return (
    <UsageCard title="Service tier" subtitle="Fast / Flex / Standard split">
      <div className="usage-tiers">
        {data.serviceTiers.map((tier) => (
          <div key={tier.key}>
            <div>
              <strong>{tier.label}</strong>
              <span>
                {tier.reportCount.toLocaleString()} turns ·{" "}
                {compactTokens(tier.usage.totalTokens)} tokens
              </span>
            </div>
            <div>
              <strong className="usage-cost">
                {money(tier.usage.estimatedCostUsd)}
              </strong>
              {/* No turns to divide by is an absent share, not a zero one —
                  the same em dash the breakdown tables' Share column uses. */}
              <span>
                {data.summary.reportCount
                  ? `${(
                      (tier.reportCount / data.summary.reportCount) * 100
                    ).toFixed(1)}% of turns`
                  : "—"}
              </span>
            </div>
            <meter
              min="0"
              max={Math.max(data.summary.reportCount, 1)}
              value={tier.reportCount}
              aria-label={`${tier.label} turn share`}
            />
          </div>
        ))}
        {data.serviceTiers.length === 0 && (
          <p className="usage-empty">No service tiers reported.</p>
        )}
      </div>
      <p className="usage-note">
        Tier reported for {data.coverage.tierReports.toLocaleString()} of{" "}
        {data.summary.reportCount.toLocaleString()} turns. Missing tiers stay
        “Not reported”.
      </p>
    </UsageCard>
  );
}

export function UsageCoverage({ data }: { data: AgentUsageAnalytics }) {
  const coverage = data.coverage;
  return (
    <UsageCard
      title="Reporting coverage"
      subtitle="Unknown values are never counted as zero"
    >
      <dl className="usage-coverage-grid">
        {[
          ["Provider", coverage.providerReports],
          ["Account", coverage.accountReports],
          // Attributed and *confirmed* are different facts: a seeded label
          // groups usage without the owner having vouched for the identity.
          ["Confirmed account", coverage.confirmedAccountReports],
          ["Service tier", coverage.tierReports],
          ["Complete requests", coverage.completeRequestReports],
          ["Cost source", coverage.costProvenanceReports],
        ].map(([label, count]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {Number(count).toLocaleString()} /{" "}
              {data.summary.reportCount.toLocaleString()} turns
            </dd>
          </div>
        ))}
      </dl>
      <div className="usage-cost-sources">
        <span>
          Wire reported{" "}
          <strong>{money(data.summary.costs.wireReported)}</strong>
        </span>
        <span>
          Manifest estimated{" "}
          <strong>{money(data.summary.costs.manifestEstimated)}</strong>
        </span>
        <span>
          Unknown source <strong>{money(data.summary.costs.unknown)}</strong>
        </span>
      </div>
      <div className="usage-cost-sources">
        <span>
          Average request latency{" "}
          <strong>
            {data.summary.avgLatencyMs.value === null
              ? "— Not reported"
              : `${data.summary.avgLatencyMs.value.toLocaleString(undefined, { maximumFractionDigits: 0 })} ms${data.summary.avgLatencyMs.incomplete ? "+" : ""}`}
          </strong>
        </span>
        {data.stopReasons?.map((reason) => (
          <span key={reason.key}>
            {reason.label}
            <strong>{reason.reportCount.toLocaleString()} turns</strong>
          </span>
        ))}
      </div>
      <p className="usage-note">
        {coverage.inconsistentRequestReports > 0
          ? `${coverage.inconsistentRequestReports.toLocaleString()} reports have inconsistent request breakdowns; turn totals remain authoritative. `
          : ""}
        {coverage.invalidReportCount > 0
          ? `${coverage.invalidReportCount.toLocaleString()} invalid reports excluded. `
          : ""}
        A + indicates a partial total. A derived value computed over partial
        data reads “(partial)” instead, because a missing denominator can move
        it in either direction. Subscription value compares observed usage, not
        promised capacity. Only usage archived on this device is included.
      </p>
    </UsageCard>
  );
}

export function Diversity({ data }: { data: AgentUsageAnalytics }) {
  const { diversity } = data;
  return (
    <UsageCard
      title="Provider diversity"
      subtitle="Provider concentration for the selected agents"
    >
      <div className="usage-diversity">
        <div>
          <span>Shannon entropy</span>
          <strong>
            {diversity.score === null ? "—" : `${diversity.score.toFixed(1)}%`}
          </strong>
          <p>
            {diversity.score === null
              ? "No attributed provider usage"
              : "Higher values mean traffic is spread across providers."}
          </p>
        </div>
        <div>
          <span>Recent window · last 60 minutes</span>
          <strong>
            {diversity.recentScore === null
              ? "—"
              : `${diversity.recentScore.toFixed(1)}%`}
          </strong>
          <p>
            {diversity.recentScore === null
              ? "No attributed usage in this window."
              : `Since ${new Date(diversity.recentStart * 1000).toLocaleTimeString()}`}
          </p>
        </div>
      </div>
      <div className="usage-provider-shares">
        {diversity.shares.map((share) => (
          <span key={share.provider}>
            {share.provider}
            <strong>{(share.share * 100).toFixed(1)}%</strong>
          </span>
        ))}
      </div>
      <p className="usage-note">
        Provider known for {diversity.knownReportCount.toLocaleString()} of{" "}
        {diversity.totalReportCount.toLocaleString()} turns; unknown providers
        excluded from diversity. Shares use requests when complete request
        coverage exists; otherwise each attributed turn is one observation.
      </p>
    </UsageCard>
  );
}
