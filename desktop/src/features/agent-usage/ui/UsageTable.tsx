import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import type { AnalyticsMetricGroup } from "@/shared/api/tauriArchive";
import {
  compactTokens,
  exactTokens,
  money,
  tokenShare,
} from "../lib/analytics";

type SortKey =
  | "label"
  | "reportCount"
  | "inputTokens"
  | "outputTokens"
  | "totalTokens"
  | "cost";
export function sortUsageRows(
  rows: AnalyticsMetricGroup[],
  sort: SortKey,
  ascending: boolean,
  search = "",
) {
  return rows
    .filter((row) => row.label.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const left =
        sort === "label"
          ? a.label
          : sort === "reportCount"
            ? a.reportCount
            : sort === "cost"
              ? a.usage.estimatedCostUsd.value
              : a.usage[sort].value == null
                ? null
                : BigInt(a.usage[sort].value);
      const right =
        sort === "label"
          ? b.label
          : sort === "reportCount"
            ? b.reportCount
            : sort === "cost"
              ? b.usage.estimatedCostUsd.value
              : b.usage[sort].value == null
                ? null
                : BigInt(b.usage[sort].value);
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      return (
        (left < right ? -1 : left > right ? 1 : a.key.localeCompare(b.key)) *
        (ascending ? 1 : -1)
      );
    });
}
export function UsageTable({
  title,
  dimension,
  rows,
  total,
  byDate = false,
}: {
  title: string;
  dimension: string;
  rows: AnalyticsMetricGroup[];
  total: string | null;
  byDate?: boolean;
}) {
  const [sort, setSort] = useState<SortKey>(byDate ? "label" : "totalTokens");
  const [ascending, setAscending] = useState(false);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(10);
  const sorted = sortUsageRows(rows, sort, ascending, search);
  const columns: [SortKey, string][] = [
    ["label", dimension],
    ["reportCount", "Turns"],
    ["inputTokens", "Input"],
    ["outputTokens", "Output"],
    ["totalTokens", "Total"],
    ["cost", "Est. cost"],
  ];
  return (
    <section className="usage-card usage-table-card" aria-label={title}>
      <div className="usage-card-heading">
        <h2>{title}</h2>
        <label className="usage-search">
          <Search size={13} />
          <input
            aria-label={`Search ${title.toLowerCase()}`}
            placeholder={`Search ${dimension.toLowerCase()}…`}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setLimit(10);
            }}
          />
        </label>
      </div>
      <div className="usage-table-scroll">
        <table>
          <caption className="sr-only">
            {title}; token counts and estimated costs for the selected agents
            and date range. A plus means partial reporting.
          </caption>
          <thead>
            <tr>
              {columns.map(([key, label]) => (
                <th
                  key={key}
                  scope="col"
                  aria-sort={
                    sort === key
                      ? ascending
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
                  <button
                    type="button"
                    onClick={() => {
                      setSort(key);
                      setAscending(sort === key ? !ascending : key === "label");
                    }}
                  >
                    {label}
                    {sort === key ? (
                      ascending ? (
                        <ArrowUp size={12} />
                      ) : (
                        <ArrowDown size={12} />
                      )
                    ) : (
                      <ArrowUpDown size={12} />
                    )}
                  </button>
                </th>
              ))}
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, limit).map((row) => (
              <tr key={row.key}>
                <th scope="row" title={row.label}>
                  {row.label}
                </th>
                <td>{row.reportCount.toLocaleString()}</td>
                {(["inputTokens", "outputTokens", "totalTokens"] as const).map(
                  (key) => (
                    <td key={key} title={exactTokens(row.usage[key])}>
                      {compactTokens(row.usage[key])}
                    </td>
                  ),
                )}
                <td
                  title={`Wire reported: ${money(row.costs.wireReported)}; manifest estimated: ${money(row.costs.manifestEstimated)}; unknown source: ${money(row.costs.unknown)}`}
                >
                  {money(row.usage.estimatedCostUsd)}
                </td>
                <td>
                  {row.usage.totalTokens.value === null || total === null
                    ? "—"
                    : `${tokenShare(row.usage.totalTokens.value, total).toFixed(1)}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length === 0 && (
        <p className="usage-empty">
          {search
            ? "No matching rows. Try another search."
            : "No usage reported for this selection."}
        </p>
      )}
      <footer className="usage-table-footer">
        <span>
          {Math.min(limit, sorted.length)} of {sorted.length} rows
        </span>
        {limit < sorted.length && (
          <button type="button" onClick={() => setLimit(limit + 25)}>
            Show more
          </button>
        )}
        {limit > 10 && (
          <button type="button" onClick={() => setLimit(10)}>
            Show less
          </button>
        )}
      </footer>
    </section>
  );
}
