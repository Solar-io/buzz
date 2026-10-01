import { useMemo, useState } from "react";

import { cn } from "@/shared/lib/cn";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { formatRunway, percent, vitalsSummary } from "../lib/vitalsMath.ts";
import { refreshHostStats, useHostStats } from "../useHostStats.ts";
import { refreshVitals, useVitals } from "../useVitals.ts";
import {
  CrichtonPanel,
  CrichtonRows,
  CrichtonStripColumn,
} from "./CrichtonVitals";
import { statusFill, VitalsPanel } from "./VitalsPopover";

/**
 * Vitals v1 (phase-1 §4; Main + Vitals artboards): one combined Claude bar in
 * a shaded box at the foot of the sidebar, opening the per-account panel.
 * Phase 7 adds crichton's rows (CPU, GPU, Mem, Disk from hatch) under a
 * divider — only when a hatch URL is configured.
 *
 * `strip` is the phone Work page's one-line form (PhoneWork artboard).
 */
export function VitalsBlock({
  variant = "block",
}: {
  variant?: "block" | "strip";
}) {
  const data = useVitals();
  const host = useHostStats();
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => vitalsSummary(data.pace), [data.pace]);
  const runway = formatRunway(data.runway);
  // Nothing to say before the first answer: no skeleton bar pretending to be
  // a reading.
  if (!data.settled) {
    return null;
  }
  const known = summary.kind === "known";
  const used = known ? percent(summary.used) : 0;
  const free = known ? percent(summary.free) : 0;
  const coverage =
    known && summary.known < summary.total
      ? `${summary.known} of ${summary.total} accounts`
      : summary.total > 0
        ? `${summary.total} account${summary.total === 1 ? "" : "s"}`
        : "";
  const bar = (height: string) => (
    <span className={cn("relative block rounded-full bg-line-2", height)}>
      <span
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          statusFill(summary),
        )}
        style={{ width: `${used}%` }}
      />
    </span>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          refreshVitals();
          refreshHostStats();
        }
      }}
    >
      <PopoverTrigger asChild>
        {variant === "strip" ? (
          <button
            type="button"
            data-testid="vitals-strip"
            aria-label={
              host
                ? "Vitals: Claude usage and crichton"
                : "Vitals: Claude usage"
            }
            className={cn(
              "w-full rounded-xl bg-vit px-3 py-2.5 text-left font-mono text-2xs text-foreground",
              host
                ? "grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-4"
                : "block",
            )}
          >
            <span className="block min-w-0">
              <span className="flex justify-between text-muted-foreground">
                <span>Claude</span>
                <span>
                  {known ? (
                    <>
                      <b className="font-semibold text-foreground">
                        {free}% free
                      </b>
                      {runway ? ` · ${runway}` : ""}
                    </>
                  ) : (
                    "usage unavailable"
                  )}
                </span>
              </span>
              {known && <span className="mt-1.5 block">{bar("h-0.75")}</span>}
            </span>
            {host ? <CrichtonStripColumn data={host} /> : null}
          </button>
        ) : (
          <button
            type="button"
            data-testid="vitals-block"
            aria-label={
              host
                ? "Vitals: Claude usage and crichton"
                : "Vitals: Claude usage"
            }
            className="block w-full rounded-[10px] bg-vit px-2.5 pt-2.5 pb-2.75 text-left text-foreground transition-colors hover:brightness-[0.98]"
          >
            <span className="flex items-center justify-between">
              <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Claude
              </span>
              <span className="font-mono text-2xs text-muted-foreground">
                {coverage}
              </span>
            </span>
            {known ? (
              <>
                <span className="mt-1.75 grid grid-cols-[minmax(0,1fr)_1.875rem] items-center gap-2 font-mono text-2xs">
                  {bar("h-1")}
                  <span className="text-right">{used}%</span>
                </span>
                <span className="mt-1 block font-mono text-2xs text-muted-foreground">
                  {free}% free
                  {runway ? (
                    <>
                      {" · "}
                      <b className="font-semibold text-foreground">{runway}</b>{" "}
                      of active use
                    </>
                  ) : null}
                </span>
              </>
            ) : (
              <span className="mt-1.5 block font-mono text-2xs text-muted-foreground">
                usage unavailable
              </span>
            )}
            {host ? <CrichtonRows data={host} /> : null}
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        side={variant === "strip" ? "bottom" : "right"}
        align={variant === "strip" ? "center" : "end"}
        sideOffset={10}
        collisionPadding={12}
        className="w-[min(35rem,calc(100vw-1.5rem))] overflow-hidden rounded-2xl border border-border bg-popover p-0 shadow-elev"
      >
        <VitalsPanel
          data={data}
          summary={summary}
          onClose={() => setOpen(false)}
        />
        {host ? <CrichtonPanel data={host} /> : null}
      </PopoverContent>
    </Popover>
  );
}
