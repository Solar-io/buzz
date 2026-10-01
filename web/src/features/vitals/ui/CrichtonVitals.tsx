import { type ReactNode, useEffect, useState } from "react";

import { cn } from "@/shared/lib/cn";
import type { HostStatsSnapshot } from "../hostStatsPoller.ts";
import {
  barTone,
  barWidth,
  type BarTone,
  type CrichtonStatus,
  crichtonStatus,
  diskLine,
  formatPercent,
  loadLine,
  memoryLine,
  primaryDisk,
  STATUS_TEXT,
  servicesLine,
  sparkline,
  uptimeLine,
  vitalRows,
} from "../lib/hostStats.ts";

/** A clock for staleness: the rows must turn "stale" even when no poll lands. */
function useNow(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(timer);
  }, [stepMs]);
  return now;
}

const FILL: Record<BarTone, string> = {
  ink: "bg-ink-2",
  work: "bg-work",
  need: "bg-need",
};

const DOT: Record<CrichtonStatus, string> = {
  ok: "bg-leaf",
  stale: "bg-work",
  offline: "bg-need",
  "signed-out": "bg-faint",
  forbidden: "bg-need",
};

function Bar({
  percent,
  tone,
  thick,
}: {
  percent: number | null;
  tone: BarTone;
  thick?: boolean;
}) {
  const width = barWidth(percent);
  return (
    <span
      className={cn(
        "relative block rounded-full bg-line-2",
        thick ? "h-1" : "h-0.75",
      )}
    >
      {width !== null ? (
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full", FILL[tone])}
          style={{ width: `${width}%` }}
        />
      ) : null}
    </span>
  );
}

function StatusBadge({ status }: { status: CrichtonStatus }) {
  return (
    <span
      data-testid="crichton-status"
      data-status={status}
      className="inline-flex items-center gap-1.25 font-mono text-2xs text-muted-foreground"
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", DOT[status])} />
      {STATUS_TEXT[status]}
    </span>
  );
}

/**
 * The sidebar block's crichton half (Vitals artboard): a divider under the
 * Claude section, a "crichton" header with its status, then CPU / GPU / Mem /
 * Disk bars. Offline / signed out show the header alone — no old numbers.
 */
export function CrichtonRows({ data }: { data: HostStatsSnapshot }) {
  const now = useNow(10_000);
  const status = crichtonStatus(data, now);
  if (!status) {
    return null;
  }
  return (
    <span className="block" data-testid="vitals-crichton">
      <span aria-hidden className="mt-2.5 mb-2.25 block h-px bg-line-2" />
      <span className="flex items-center justify-between">
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          crichton
        </span>
        <StatusBadge status={status} />
      </span>
      {data.stats && (status === "ok" || status === "stale") ? (
        <span className="mt-1.75 grid grid-cols-[2.125rem_minmax(0,1fr)_1.875rem] items-center gap-x-2 gap-y-1.5 font-mono text-2xs">
          {vitalRows(data.stats).map((row) => (
            <span
              key={row.key}
              className="contents"
              data-testid={`vitals-row-${row.key}`}
            >
              <span className="text-muted-foreground">{row.label}</span>
              <Bar percent={row.percent} tone={row.tone} />
              <span className="text-right">{row.text}</span>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** The phone Work strip's second column: GPU (PhoneWork artboard). */
export function CrichtonStripColumn({ data }: { data: HostStatsSnapshot }) {
  const now = useNow(10_000);
  const status = crichtonStatus(data, now);
  if (!status) {
    return null;
  }
  const gpu =
    data.stats && status !== "offline" ? data.stats.gpu.percent : null;
  const live = status === "ok" || status === "stale";
  return (
    <span
      className="block min-w-0 border-l border-line-2 pl-3.5"
      data-testid="vitals-strip-gpu"
    >
      <span className="flex justify-between text-muted-foreground">
        <span>{live ? "GPU" : "crichton"}</span>
        <b className="font-semibold text-foreground">
          {live ? formatPercent(gpu) : STATUS_TEXT[status]}
        </b>
      </span>
      {live ? (
        <span className="mt-1.5 block">
          <Bar percent={gpu} tone={barTone(gpu)} />
        </span>
      ) : null}
    </span>
  );
}

function Spark({
  values,
  tone,
}: {
  values: Array<number | null>;
  tone: BarTone;
}) {
  const points = sparkline(values);
  if (!points) {
    return <span aria-hidden className="h-4 w-35" />;
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 140 16" className="block h-4 w-35">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinejoin="round"
        className={
          tone === "ink"
            ? "text-ink-2"
            : tone === "work"
              ? "text-work"
              : "text-need"
        }
      />
    </svg>
  );
}

/**
 * The popover's crichton section (Vitals artboard): uptime, CPU / GPU / Mem
 * with sparklines from this session's samples, every local disk, and the
 * Buzz services line.
 */
export function CrichtonPanel({ data }: { data: HostStatsSnapshot }) {
  const now = useNow(10_000);
  const status = crichtonStatus(data, now);
  if (!status) {
    return null;
  }
  const stats = data.stats;
  const history = data.history;
  const live = stats && (status === "ok" || status === "stale");
  const primary = stats ? primaryDisk(stats) : null;
  const services = stats ? servicesLine(stats, now) : null;
  return (
    <div data-testid="vitals-crichton-panel">
      <div className="h-2 border-y border-border bg-sunk" />
      <div className="px-4.5 pt-3.5 pb-4">
        <div className="flex items-center justify-between">
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            crichton
          </span>
          {live ? (
            <span className="font-mono text-2xs text-muted-foreground">
              {status === "stale" ? "stale · " : ""}
              {uptimeLine(stats.uptimeSec) ?? ""}
            </span>
          ) : (
            <StatusBadge status={status} />
          )}
        </div>
        {live ? (
          <>
            <div className="mt-2.5 grid grid-cols-[3rem_8.75rem_minmax(0,1fr)_2.75rem] items-center gap-x-3 gap-y-2.25 font-mono text-xs max-sm:grid-cols-[3rem_minmax(0,1fr)_2.75rem]">
              <PanelRow
                label="CPU"
                percent={stats.cpu}
                detail={loadLine(stats)}
                spark={
                  <Spark
                    values={history.map((h) => h.cpu)}
                    tone={barTone(stats.cpu)}
                  />
                }
              />
              <PanelRow
                label="GPU"
                percent={stats.gpu.percent}
                detail={
                  stats.gpu.renderer !== null && stats.gpu.tiler !== null
                    ? `renderer ${Math.round(stats.gpu.renderer)}% · tiler ${Math.round(stats.gpu.tiler)}%`
                    : null
                }
                spark={
                  <Spark
                    values={history.map((h) => h.gpu)}
                    tone={barTone(stats.gpu.percent)}
                  />
                }
              />
              <PanelRow
                label="Mem"
                percent={stats.mem?.percent ?? null}
                detail={memoryLine(stats)}
                spark={
                  <Spark
                    values={history.map((h) => h.mem)}
                    tone={barTone(stats.mem?.percent ?? null)}
                  />
                }
              />
              {stats.disks.map((disk) => {
                const tone = barTone(disk.percent);
                const hot = tone !== "ink";
                return (
                  <PanelRow
                    key={disk.mount}
                    label={
                      disk === primary
                        ? "Disk"
                        : disk.kind === "external"
                          ? "Ext"
                          : "Disk"
                    }
                    percent={disk.percent}
                    detail={diskLine(disk)}
                    hot={hot}
                    spark={<Bar percent={disk.percent} tone={tone} thick />}
                  />
                );
              })}
            </div>
            {services ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-ink-2">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.75 rounded-full",
                    services.healthy ? "bg-leaf" : "bg-need",
                  )}
                />
                {services.text}
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {status === "offline"
              ? "hatch isn't answering, so there are no live numbers for crichton."
              : status === "signed-out"
                ? "Sign in to crichton from the Terminal page to see its numbers."
                : "This account isn't allowed to read crichton."}
          </p>
        )}
      </div>
    </div>
  );
}

function PanelRow({
  label,
  percent,
  detail,
  spark,
  hot = false,
}: {
  label: string;
  percent: number | null;
  detail: string | null;
  spark: ReactNode;
  hot?: boolean;
}) {
  return (
    <>
      <span className={hot ? "text-honey-ink" : "text-muted-foreground"}>
        {label}
      </span>
      <span className="max-sm:hidden">{spark}</span>
      <span
        className={cn(
          "truncate",
          hot ? "text-honey-ink" : "text-muted-foreground",
        )}
      >
        {detail ?? ""}
      </span>
      <b className={cn("text-right font-semibold", hot && "text-honey-ink")}>
        {formatPercent(percent)}
      </b>
    </>
  );
}
