import { useRef } from "react";
import { Link } from "@tanstack/react-router";
import { BarChart3, Download, RefreshCw } from "lucide-react";
import type { AgentUsageAnalytics } from "@/shared/api/tauriArchive";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { useHistorySearchState } from "@/shared/hooks/useHistorySearchState";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { useUsageAnalytics } from "../hooks";
import {
  USAGE_SEARCH_KEYS,
  csvDocument,
  selectedAgents,
  type UsageSearch,
} from "../lib/analytics";
import { Distribution, Heatmap, RankedModels, Timeline } from "./UsageCharts";
import { UsageControls } from "./UsageControls";
import {
  Diversity,
  ServiceTiers,
  UsageCoverage,
  UsageSummary,
} from "./UsageSummary";
import { UsageTable } from "./UsageTable";
import "./usage.css";

export function usageCsv(data: AgentUsageAnalytics): string {
  const dimensions = [
    ["provider", data.providers],
    ["provider/date", data.providerByDate],
    ["agent", data.agents],
    ["model", data.models],
    ["account", data.accounts],
    ["service_tier", data.serviceTiers],
  ] as const;
  return csvDocument(
    [
      "dimension",
      "key",
      "label",
      "turns",
      "requests",
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "estimated_cost_usd",
      "wire_reported_cost_usd",
      "manifest_estimated_cost_usd",
      "unknown_source_cost_usd",
      "input_partial",
      "output_partial",
      "total_partial",
      "cost_partial",
    ],
    dimensions.flatMap(([dimension, rows]) =>
      rows.map((row) => [
        dimension,
        row.key,
        row.label,
        row.reportCount,
        row.requestCount,
        row.usage.inputTokens.value,
        row.usage.outputTokens.value,
        row.usage.totalTokens.value,
        row.usage.cacheReadTokens.value,
        row.usage.cacheWriteTokens.value,
        row.usage.estimatedCostUsd.value,
        row.costs.wireReported.value,
        row.costs.manifestEstimated.value,
        row.costs.unknown.value,
        row.usage.inputTokens.incomplete,
        row.usage.outputTokens.incomplete,
        row.usage.totalTokens.incomplete,
        row.usage.estimatedCostUsd.incomplete,
      ]),
    ),
  );
}
function downloadUsage(data: AgentUsageAnalytics) {
  const url = URL.createObjectURL(
    new Blob(["\uFEFF", usageCsv(data)], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "buzz-usage.csv";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AgentUsagePage() {
  const { values, applyPatch } = useHistorySearchState(USAGE_SEARCH_KEYS);
  const search: UsageSearch = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== null),
  );
  const { query, window, scopeKey } = useUsageAnalytics(search);
  const lastAvailable = useRef<string[]>([]);
  const lastScope = useRef(scopeKey);
  if (lastScope.current !== scopeKey) {
    lastAvailable.current = [];
    lastScope.current = scopeKey;
  }
  if (query.data) lastAvailable.current = query.data.availableAgents;
  const profiles = useUsersBatchQuery(lastAvailable.current);
  const label = (key: string) =>
    profiles.data?.profiles[key]?.displayName ??
    profiles.data?.profiles[key]?.name ??
    truncatePubkey(key);
  const options = lastAvailable.current
    .map((key) => ({
      key,
      label: label(key),
      avatarUrl: profiles.data?.profiles[key]?.avatarUrl ?? null,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const data = query.data
    ? {
        ...query.data,
        agents: query.data.agents.map((agent) => ({
          ...agent,
          label: label(agent.key),
        })),
        timeline: query.data.timeline.map((bucket) => ({
          ...bucket,
          label: new Date(bucket.start * 1000).toLocaleString(
            undefined,
            bucket.end - bucket.start < 86400
              ? {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  timeZoneName: "short",
                }
              : { month: "short", day: "numeric", year: "numeric" },
          ),
        })),
      }
    : undefined;
  const isStale =
    data?.coverage.archiveLastReportedAt != null &&
    Date.now() / 1000 - data.coverage.archiveLastReportedAt > 86400;
  return (
    <main className="usage-page" data-testid="agent-usage-page">
      <header className="usage-page-header">
        <div>
          <BarChart3 size={21} />
          <div>
            <h1>Usage</h1>
            <p>Agent, model and subscription analytics</p>
          </div>
        </div>
        <div className="usage-header-actions">
          <button
            className="usage-button"
            type="button"
            aria-label="Refresh usage"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw size={15} />
          </button>
          <button
            className="usage-button"
            type="button"
            disabled={!data || query.isFetching}
            onClick={() => data && downloadUsage(data)}
          >
            <Download size={15} />
            Export CSV
          </button>
        </div>
      </header>
      <div className="usage-content">
        <nav className="usage-breadcrumb" aria-label="Breadcrumb">
          <Link to="/agents">Agents</Link>
          <span>›</span>
          <span>Usage</span>
        </nav>
        <div className="usage-title-row">
          <h2>
            <BarChart3 size={18} />
            Usage Analytics
          </h2>
          <UsageControls
            agents={options}
            selected={selectedAgents(search.agents)}
            search={search}
            onChange={applyPatch}
          />
        </div>
        {window.error && (
          <div role="alert" className="usage-notice">
            {window.error}
          </div>
        )}
        {!window.error && query.isPending && (
          <div role="status" className="usage-loading">
            <div className="usage-loading-bar" />
            <p>Loading your usage reports…</p>
          </div>
        )}
        {query.isError && (
          <div role="alert" className="usage-notice">
            <strong>Usage could not be loaded.</strong>
            <span>
              {query.error instanceof Error
                ? query.error.message
                : "The local archive is unavailable."}
            </span>
            <button
              type="button"
              className="usage-button"
              onClick={() => void query.refetch()}
            >
              Try again
            </button>
          </div>
        )}
        {data && !window.error && (
          <>
            <div className="usage-status" role="status">
              {query.isFetching
                ? "Updating usage…"
                : `Updated ${new Date(query.dataUpdatedAt).toLocaleTimeString()}`}
              {isStale && (
                <span>Latest archived report is over 24 hours old.</span>
              )}
            </div>
            {!data.collectionEnabled && (
              <div className="usage-notice">
                <strong>Usage collection is disabled.</strong>
                <span>
                  Existing history is shown. Enable agent usage in local archive
                  settings to collect new reports.
                </span>
                <Link to="/settings">Open settings</Link>
              </div>
            )}
            {data.summary.reportCount === 0 && (
              <div className="usage-notice">
                <strong>
                  {search.agents === "none"
                    ? "No agents selected."
                    : "No usage in this range."}
                </strong>
                <span>
                  Select agents or a wider range to explore archived reports.
                </span>
              </div>
            )}
            {data.coverage.hasUnknownUsage && (
              <div className="usage-partial">
                Some reports are incomplete. Partial totals are marked +;
                unreported values appear as —.
              </div>
            )}
            <UsageSummary data={data} />
            <Heatmap
              days={data.days}
              weekdays={data.weekdays}
              activeDays={data.highlights.activeDays}
            />
            <div className="usage-two-column">
              <Timeline buckets={data.timeline} />
              <Distribution
                title="Cost by provider and source"
                rows={data.providers}
                cost
              />
            </div>
            <ServiceTiers data={data} />
            <RankedModels
              rows={data.models}
              total={data.summary.usage.totalTokens.value}
            />
            <div className="usage-two-column">
              <Distribution
                title="By account / subscription"
                rows={data.accounts}
              />
              <Distribution title="By agent" rows={data.agents} />
            </div>
            <UsageTable
              title="Provider breakdown"
              dimension="Provider"
              rows={data.providers}
              total={data.summary.usage.totalTokens.value}
            />
            <UsageTable
              title="Turns by provider & date"
              dimension="Date / provider"
              rows={data.providerByDate.map((row) => ({
                ...row,
                label: `${row.date} · ${row.provider}`,
              }))}
              total={data.summary.usage.totalTokens.value}
              byDate
            />
            <UsageTable
              title="Agent breakdown"
              dimension="Agent"
              rows={data.agents}
              total={data.summary.usage.totalTokens.value}
            />
            <UsageTable
              title="Model breakdown"
              dimension="Model"
              rows={data.models}
              total={data.summary.usage.totalTokens.value}
            />
            <Diversity data={data} />
            <UsageCoverage data={data} />
          </>
        )}
        <footer className="usage-page-footer">
          Private usage reports · Local archive · Dates shown in{" "}
          {Intl.DateTimeFormat().resolvedOptions().timeZone}
        </footer>
      </div>
    </main>
  );
}
