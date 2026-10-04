import { cn } from "@/shared/lib/cn";
import {
  codexCost,
  codexCredits,
  codexNumber,
  codexOutlook,
  codexReset,
  codexTokens,
  type CodexUsageBucket,
  type CodexVitals,
  type CodexWindow,
} from "../lib/codexUsage.ts";
import { barTone, type BarTone } from "../lib/hostStats.ts";
import { percent } from "../lib/vitalsMath.ts";

const FILL: Record<BarTone, string> = {
  ink: "bg-ink-2",
  work: "bg-work",
  need: "bg-need",
};

function CodexBar({ used }: { used: number }) {
  return (
    <span className="relative block h-1 rounded-full bg-line-2">
      <span
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          FILL[barTone(used)],
        )}
        style={{ width: `${used}%` }}
      />
    </span>
  );
}

/** Codex below the combined Claude reading, in the same sidebar section. */
export function CodexRow({ data }: { data: CodexVitals | null }) {
  const weekly = data?.weekly;
  const fraction = weekly?.usedFraction ?? null;
  const outlook = codexOutlook(weekly);
  return (
    <span
      data-testid="vitals-codex-row"
      className="mt-2.5 block font-mono text-2xs"
    >
      {fraction === null ? (
        <span className="text-muted-foreground">Codex usage unavailable</span>
      ) : (
        <>
          <span className="flex items-center justify-between text-muted-foreground">
            <span>Codex</span>
          </span>
          <span className="mt-1.5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <CodexBar used={percent(fraction)} />
            <span>
              {percent(fraction)}% used{weekly?.stale ? " · stale" : ""}
            </span>
          </span>
          <span className="mt-1 block text-muted-foreground">
            {percent(1 - fraction)}% free ·{" "}
            {outlook ? (
              <b className="font-semibold text-foreground">{outlook}</b>
            ) : (
              <>resets {codexReset(weekly?.resetsAt ?? null)}</>
            )}
          </span>
        </>
      )}
    </span>
  );
}

/** Shares Claude's phone column, leaving crichton's second column intact. */
export function CodexStrip({ data }: { data: CodexVitals | null }) {
  const weekly = data?.weekly;
  const fraction = weekly?.usedFraction ?? null;
  const outlook = codexOutlook(weekly);
  return (
    <span
      data-testid="vitals-codex-strip"
      className="mt-1.5 block text-muted-foreground"
    >
      {fraction === null ? (
        "Codex usage unavailable"
      ) : (
        <span className="flex flex-wrap justify-between gap-x-1">
          <span>Codex</span>
          <span>
            <b className="font-semibold text-foreground">
              {percent(1 - fraction)}% free
            </b>
            {weekly?.stale ? " · stale" : ""}
            {outlook ? ` · ${outlook}` : ""}
          </span>
        </span>
      )}
    </span>
  );
}

function WindowRow({
  label,
  window,
}: {
  label: string;
  window: CodexWindow | null;
}) {
  const fraction = window?.usedFraction ?? null;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap justify-between gap-x-2 font-mono text-2xs">
        <span>{label}</span>
        <span>
          {fraction === null
            ? "usage unavailable"
            : `${percent(fraction)}% used`}
          {window?.stale ? " · stale" : ""}
        </span>
      </div>
      {fraction !== null && (
        <div className="mt-1.5">
          <CodexBar used={percent(fraction)} />
        </div>
      )}
      <p className="mt-1 font-mono text-2xs text-muted-foreground">
        resets {codexReset(window?.resetsAt ?? null)}
        {codexOutlook(window) ? ` · ${codexOutlook(window)}` : ""}
      </p>
      {window?.runway?.burnPerHour != null && !window.stale && (
        <p className="mt-0.5 font-mono text-2xs text-muted-foreground">
          72h average, weekends ×1.5:{" "}
          {(window.runway.burnPerHour * 100).toFixed(1)}%/h
          {window.runway.historyHours !== null &&
          window.runway.historyHours < 72
            ? ` (${Math.round(window.runway.historyHours)}h of history)`
            : ""}
        </p>
      )}
    </div>
  );
}

function UsageRow({
  period,
  lane,
  bucket,
}: {
  period: string;
  lane: string;
  bucket: CodexUsageBucket;
}) {
  return (
    <tr>
      <th scope="row" className="py-1 pr-2 text-left font-normal">
        {period}
      </th>
      <td className="pr-2">{lane}</td>
      <td className="px-1 text-right tabular-nums">
        {codexNumber(bucket.calls)}
      </td>
      <td className="px-1 text-right tabular-nums">
        {codexTokens(bucket.totalInput)} / {codexTokens(bucket.output)}
      </td>
      <td className="pl-1 text-right tabular-nums">
        {codexCost(bucket.listCost, bucket.incomplete)}
      </td>
    </tr>
  );
}

/** Quota, credits and direct/routed usage in the Vitals pop-out. */
export function CodexPanel({ data }: { data: CodexVitals | null }) {
  const incomplete =
    data &&
    [data.usage.today, data.usage.last7d].some(
      (period) => period.direct.incomplete || period.routed.incomplete,
    );
  return (
    <section
      aria-label="Codex"
      data-testid="vitals-codex-panel"
      className="border-t border-border px-4.5 py-3.5"
    >
      <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Codex
      </h2>
      {data ? (
        <>
          <p className="mt-1 text-xs">
            {data.planLabel ?? data.planType ?? "Plan unavailable"}
          </p>
          {data.weekly?.usedFraction == null ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Codex usage unavailable
            </p>
          ) : (
            <WindowRow label="Weekly" window={data.weekly} />
          )}
          {data.short && <WindowRow label="Short window" window={data.short} />}
          {data.credits && (
            <p className="mt-2 font-mono text-2xs text-muted-foreground">
              Credits · {codexCredits(data.credits)}
            </p>
          )}
          <div className="mt-3 overflow-x-auto">
            <table
              aria-label="Codex usage breakdown"
              className="w-full whitespace-nowrap text-2xs"
            >
              <thead className="text-muted-foreground">
                <tr>
                  <th scope="col" className="pr-2 text-left font-normal">
                    Period
                  </th>
                  <th scope="col" className="pr-2 text-left font-normal">
                    Lane
                  </th>
                  <th scope="col" className="px-1 text-right font-normal">
                    Calls
                  </th>
                  <th scope="col" className="px-1 text-right font-normal">
                    Tokens in / out
                  </th>
                  <th scope="col" className="pl-1 text-right font-normal">
                    List cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {(["today", "last7d"] as const).map((period) =>
                  (["direct", "routed"] as const).map((lane) => (
                    <UsageRow
                      key={`${period}-${lane}`}
                      period={period === "today" ? "Today" : "Last 7 days"}
                      lane={
                        lane === "direct"
                          ? "Direct (Codex CLI)"
                          : "Routed (OmniRoute)"
                      }
                      bucket={data.usage[period][lane]}
                    />
                  )),
                )}
              </tbody>
            </table>
          </div>
          {incomplete && (
            <p className="mt-1 font-mono text-2xs text-muted-foreground">
              Incomplete usage totals; ~ marks estimated list cost.
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Codex usage unavailable
        </p>
      )}
    </section>
  );
}
