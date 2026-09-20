import { useState, type CSSProperties, type ReactNode } from "react";
import type {
  AnalyticsMetricGroup,
  AnalyticsTimeBucket,
} from "@/shared/api/tauriArchive";
import {
  compactTokens,
  exactTokens,
  money,
  tokenShare,
} from "../lib/analytics";

export const CHART_COLORS = [
  "var(--usage-input)",
  "var(--usage-output)",
  "var(--usage-cost)",
  "#8b5cf6",
  "#0891b2",
  "#ec4899",
  "#3b82f6",
  "#64748b",
];
export function UsageCard({
  title,
  subtitle,
  children,
  className = "",
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`usage-card ${className}`} aria-label={title}>
      <div className="usage-card-heading">
        <h2>{title}</h2>
        {subtitle && <span>{subtitle}</span>}
      </div>
      {children}
    </section>
  );
}

export function Distribution({
  title,
  rows,
  cost = false,
  note,
}: {
  title: string;
  rows: AnalyticsMetricGroup[];
  cost?: boolean;
  /** Coverage note rendered under the chart, in the shared `usage-note` voice. */
  note?: ReactNode;
}) {
  const values = rows.map((row) =>
    cost
      ? [
          row.costs.wireReported.value,
          row.costs.manifestEstimated.value,
          row.costs.unknown.value,
        ].reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : Number(BigInt(row.usage.totalTokens.value ?? "0")),
  );
  const total = values.reduce((a, b) => a + b, 0);
  let offset = 0;
  const stops = values.map((value, index) => {
    const start = offset;
    offset += total > 0 ? (value / total) * 100 : 0;
    return `${CHART_COLORS[index % CHART_COLORS.length]} ${start}% ${offset}%`;
  });
  return (
    <UsageCard title={title}>
      <div className="usage-distribution">
        <div
          className="usage-donut"
          role="img"
          aria-label={`${title}. Exact values in adjacent list.`}
          style={{
            background:
              total > 0
                ? `conic-gradient(${stops.join(",")})`
                : "hsl(var(--muted))",
          }}
        >
          <div>
            <strong>
              {rows.filter((row) => row.key !== "__unknown__").length}
            </strong>
            <small>{cost ? "providers" : "reported"}</small>
          </div>
        </div>
        <ul className="usage-legend">
          {rows.map((row, index) => (
            <li key={row.key}>
              <span
                className="usage-dot"
                style={{
                  backgroundColor: CHART_COLORS[index % CHART_COLORS.length],
                }}
              />
              <span title={row.label}>{row.label}</span>
              <strong
                title={cost ? undefined : exactTokens(row.usage.totalTokens)}
              >
                {cost ? (
                  <span>
                    Wire {money(row.costs.wireReported)} · Manifest{" "}
                    {money(row.costs.manifestEstimated)} · Unknown{" "}
                    {money(row.costs.unknown)}
                  </span>
                ) : (
                  compactTokens(row.usage.totalTokens)
                )}
              </strong>
            </li>
          ))}
          {rows.length === 0 && <li>No reported data</li>}
        </ul>
      </div>
      {note}
    </UsageCard>
  );
}

export function Timeline({ buckets }: { buckets: AnalyticsTimeBucket[] }) {
  const [active, setActive] = useState<number | null>(null);
  const maxTokens = buckets.reduce((max, bucket) => {
    const amount = [
      bucket.usage.inputTokens.value,
      bucket.usage.outputTokens.value,
    ].reduce<bigint>((largest, value) => {
      const parsed = BigInt(value ?? "0");
      return parsed > largest ? parsed : largest;
    }, 0n);
    return amount > max ? amount : max;
  }, 0n);
  const maxCost = Math.max(
    ...buckets.map((bucket) => bucket.usage.estimatedCostUsd.value ?? 0),
    0,
  );
  const point = active === null ? undefined : buckets[active];
  const costs = buckets.map((bucket, index) =>
    bucket.usage.estimatedCostUsd.value === null
      ? null
      : `${((index + 0.5) / Math.max(buckets.length, 1)) * 100},${100 - (maxCost === 0 ? 0 : (bucket.usage.estimatedCostUsd.value / maxCost) * 95)}`,
  );
  const costSegments: string[] = [];
  let segment: string[] = [];
  for (const cost of costs) {
    if (cost === null) {
      if (segment.length) costSegments.push(segment.join(" "));
      segment = [];
    } else segment.push(cost);
  }
  if (segment.length) costSegments.push(segment.join(" "));
  return (
    <UsageCard
      title="Model usage over time"
      subtitle="Input / output / estimated cost"
    >
      <div className="usage-timeline">
        <div className="usage-y-axis">
          <span>
            {compactTokens({ value: maxTokens.toString(), incomplete: false })}
          </span>
          <span>0</span>
        </div>
        <div className="usage-plot">
          <svg
            className="usage-cost-line"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {costSegments.map((line) => (
              <polyline
                key={line}
                points={line}
                fill="none"
                stroke="var(--usage-cost)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          {buckets.map((bucket, index) => (
            <button
              type="button"
              key={bucket.start}
              className="usage-bar"
              aria-label={`${bucket.label}: input ${exactTokens(bucket.usage.inputTokens)}, output ${exactTokens(bucket.usage.outputTokens)}, combined observed cost ${money(bucket.usage.estimatedCostUsd)}; wire ${money(bucket.costs.wireReported)}, manifest ${money(bucket.costs.manifestEstimated)}, unknown source ${money(bucket.costs.unknown)}`}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                  event.preventDefault();
                  const sibling =
                    event.key === "ArrowRight"
                      ? event.currentTarget.nextElementSibling
                      : event.currentTarget.previousElementSibling;
                  if (sibling instanceof HTMLButtonElement) sibling.focus();
                }
              }}
            >
              <span
                className="usage-bar-output"
                style={{
                  height: `${tokenShare(bucket.usage.outputTokens.value, maxTokens.toString())}%`,
                }}
              />
              <span
                className="usage-bar-input"
                style={{
                  height: `${tokenShare(bucket.usage.inputTokens.value, maxTokens.toString())}%`,
                }}
              />
            </button>
          ))}
        </div>
        <div className="usage-y-axis usage-cost-axis">
          <span>{money({ value: maxCost, incomplete: false })}</span>
          <span>$0</span>
        </div>
      </div>
      <div className="usage-axis-labels">
        <span>{buckets[0]?.label}</span>
        <span>{buckets[Math.floor(buckets.length / 2)]?.label}</span>
        <span>{buckets.at(-1)?.label}</span>
      </div>
      <div className="usage-chart-key">
        <span>
          <i style={{ background: "var(--usage-input)" }} />
          Input
        </span>
        <span>
          <i style={{ background: "var(--usage-output)" }} />
          Output
        </span>
        <span>
          <i style={{ background: "var(--usage-cost)" }} />
          Combined cost ($): wire + manifest + unknown source
        </span>
      </div>
      <div className="usage-chart-tooltip" aria-live="polite">
        {point ? (
          <>
            {point.label} · Input {exactTokens(point.usage.inputTokens)} ·
            Output {exactTokens(point.usage.outputTokens)} · Combined cost{" "}
            {money(point.usage.estimatedCostUsd)} (wire{" "}
            {money(point.costs.wireReported)}; manifest{" "}
            {money(point.costs.manifestEstimated)}; unknown{" "}
            {money(point.costs.unknown)})
          </>
        ) : (
          "Focus or point to a bar for exact values. Arrow keys move between periods."
        )}
      </div>
      <details className="usage-chart-data">
        <summary>View timeline data</summary>
        <div className="usage-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Input</th>
                <th>Output</th>
                <th>Wire cost</th>
                <th>Manifest cost</th>
                <th>Unknown-source cost</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.start}>
                  <th>{bucket.label}</th>
                  <td>{exactTokens(bucket.usage.inputTokens)}</td>
                  <td>{exactTokens(bucket.usage.outputTokens)}</td>
                  <td>{money(bucket.costs.wireReported)}</td>
                  <td>{money(bucket.costs.manifestEstimated)}</td>
                  <td>{money(bucket.costs.unknown)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </UsageCard>
  );
}

export function Heatmap({
  days,
  weekdays,
  activeDays,
}: {
  days: AnalyticsTimeBucket[];
  weekdays: AnalyticsMetricGroup[];
  activeDays: number;
}) {
  const max = days.reduce((value, day) => {
    const amount = BigInt(day.usage.totalTokens.value ?? "0");
    return amount > value ? amount : value;
  }, 0n);
  const busiest = days.find(
    (day) =>
      day.usage.totalTokens.value !== null &&
      BigInt(day.usage.totalTokens.value) === max,
  );
  const [focused, setFocused] = useState<string | null>(null);
  const calendarStart = new Date((days[0]?.start ?? Date.now() / 1000) * 1000);
  const paddingDays = Math.max(0, 365 - days.length);
  calendarStart.setDate(calendarStart.getDate() - paddingDays);
  const inactiveDates = Array.from({ length: paddingDays }, (_, index) => {
    const date = new Date(calendarStart);
    date.setDate(date.getDate() + index);
    return date;
  });
  const firstWeekday = (calendarStart.getDay() + 6) % 7;
  const weeks = Math.max(
    1,
    Math.ceil((days.length + paddingDays + firstWeekday) / 7),
  );
  const months = Array.from({ length: weeks }, (_, week) => {
    const date = new Date(calendarStart);
    date.setDate(date.getDate() + week * 7);
    return {
      key: date.getTime(),
      label:
        week === 0 || date.getDate() <= 7
          ? date.toLocaleDateString(undefined, { month: "short" })
          : "",
    };
  });
  return (
    <div className="usage-calendar-row">
      <UsageCard
        title="Overview"
        subtitle={`${activeDays} active days · ${days.length} days`}
      >
        <div className="usage-heatmap-scroll">
          <div
            className="usage-heatmap-months"
            aria-hidden="true"
            style={{ gridTemplateColumns: `repeat(${weeks}, 10px)` }}
          >
            {months.map((month) => (
              <span key={month.key}>{month.label}</span>
            ))}
          </div>
          <div
            className="usage-heatmap"
            style={
              {
                "--weeks": weeks,
              } as CSSProperties
            }
          >
            {[
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
            ]
              .slice(0, firstWeekday)
              .map((day) => (
                <span key={day} />
              ))}
            {inactiveDates.map((date) => (
              <span
                className="usage-heatmap-inactive"
                key={date.getTime()}
                title={`${date.toLocaleDateString()}: outside selected range`}
              />
            ))}
            {days.map((day) => {
              const label = `${day.label}: ${exactTokens(day.usage.totalTokens)} tokens; ${day.reportCount.toLocaleString()} turns`;
              return (
                <button
                  type="button"
                  key={day.start}
                  aria-label={label}
                  title={label}
                  onFocus={() => setFocused(label)}
                  onMouseEnter={() => setFocused(label)}
                  onKeyDown={(event) => {
                    const amount =
                      event.key === "ArrowRight"
                        ? 7
                        : event.key === "ArrowLeft"
                          ? -7
                          : event.key === "ArrowDown"
                            ? 1
                            : event.key === "ArrowUp"
                              ? -1
                              : 0;
                    if (amount) {
                      event.preventDefault();
                      const buttons =
                        event.currentTarget.parentElement?.querySelectorAll(
                          "button",
                        );
                      const index = buttons
                        ? Array.from(buttons).indexOf(event.currentTarget)
                        : -1;
                      buttons?.[index + amount]?.focus();
                    }
                  }}
                  style={{
                    background:
                      day.reportCount === 0
                        ? "hsl(var(--muted))"
                        : `color-mix(in srgb, var(--usage-input) ${Math.max(18, tokenShare(day.usage.totalTokens.value, max.toString()))}%, hsl(var(--muted)))`,
                  }}
                />
              );
            })}
          </div>
        </div>
        <div className="usage-heatmap-legend">
          <span>Less</span>
          {[0, 25, 50, 75, 100].map((value) => (
            <i
              key={value}
              style={{
                background: `color-mix(in srgb, var(--usage-input) ${value}%, hsl(var(--muted)))`,
              }}
            />
          ))}
          <span>More</span>
          <span>Mon → Sun</span>
          {paddingDays > 0 && <span>Faded: outside range</span>}
        </div>
        <p className="usage-heatmap-detail" aria-live="polite">
          {focused ??
            "Every square is one local calendar day. Focus a square for exact usage."}
        </p>
        <details className="usage-chart-data">
          <summary>View daily data</summary>
          <div className="usage-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Tokens</th>
                  <th>Turns</th>
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr key={day.key}>
                    <th>{day.label}</th>
                    <td>{exactTokens(day.usage.totalTokens)}</td>
                    <td>{day.reportCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </UsageCard>
      <div className="usage-calendar-side">
        <UsageCard title="Most active day">
          <strong className="usage-day-name">
            {busiest && max > 0n
              ? new Date(busiest.start * 1000).toLocaleDateString(undefined, {
                  weekday: "long",
                })
              : "—"}
          </strong>
          <p>
            {busiest && max > 0n
              ? `${busiest.label} · ${compactTokens(busiest.usage.totalTokens)} tokens`
              : "No token usage reported"}
          </p>
        </UsageCard>
        <UsageCard title="Weekly">
          <div className="usage-weekdays">
            {weekdays.map((day) => (
              <div
                key={day.key}
                title={`${day.label}: ${exactTokens(day.usage.totalTokens)} tokens`}
              >
                <span
                  style={{
                    background: `color-mix(in srgb, var(--usage-input) ${Math.max(day.reportCount ? 20 : 0, tokenShare(day.usage.totalTokens.value, weekdays.reduce((sum, item) => sum + BigInt(item.usage.totalTokens.value ?? "0"), 0n).toString()) * 3)}%, hsl(var(--muted)))`,
                  }}
                />
                <small>{day.label}</small>
                <b>{compactTokens(day.usage.totalTokens)}</b>
              </div>
            ))}
          </div>
        </UsageCard>
      </div>
    </div>
  );
}

export function RankedModels({
  rows,
  total,
}: {
  rows: AnalyticsMetricGroup[];
  total: string | null;
}) {
  const sorted = [...rows].sort((a, b) =>
    BigInt(a.usage.totalTokens.value ?? "0") >
    BigInt(b.usage.totalTokens.value ?? "0")
      ? -1
      : 1,
  );
  return (
    <UsageCard title="Model usage" subtitle="Ranked by total tokens">
      <div className="usage-rankings">
        {sorted.map((row, index) => (
          <div key={row.key} className="usage-rank-row">
            <span title={row.label}>{row.label}</span>
            <div className="usage-rank-track">
              <span
                style={{
                  width: `${tokenShare(row.usage.totalTokens.value, total)}%`,
                  backgroundColor: CHART_COLORS[index % CHART_COLORS.length],
                }}
              />
            </div>
            <strong title={exactTokens(row.usage.totalTokens)}>
              {compactTokens(row.usage.totalTokens)}
            </strong>
          </div>
        ))}
        {!rows.length && <p className="usage-empty">No models reported.</p>}
      </div>
    </UsageCard>
  );
}
