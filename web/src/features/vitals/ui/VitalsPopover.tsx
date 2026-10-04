import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { USAGE_HUB_URL } from "@/features/usage/lib/usageHub.ts";
import { cn } from "@/shared/lib/cn";
import {
  type AccountVitals,
  accountDryText,
  accountRowText,
  type CombinedRunway,
  combinedHeadline,
  combinedRunway,
  combinedShort,
  paceLine,
  percent,
  type Runway,
  runwayMethod,
  updatedAgo,
  type VitalsSummary,
} from "../lib/vitalsMath.ts";
import type { VitalsSnapshot } from "../useVitals.ts";
import { CodexPanel } from "./CodexVitals";

/**
 * "4:58 PM" today; "Tue 8:00 AM" within the week; "Next Sun 6:54 PM" a week
 * or more out, so it never reads as today's weekday (Sam, 2026-10-04);
 * "Oct 18 6:54 PM" two weeks or more out.
 */
export function clock(iso: string | null, now: Date = new Date()): string {
  if (!iso) {
    return "";
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return "";
  }
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const midnight = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(date) - midnight(now)) / 86_400_000);
  if (days === 0) {
    return time;
  }
  const weekday = date.toLocaleDateString([], { weekday: "short" });
  if (days >= 14) {
    return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
  }
  return days >= 7 ? `Next ${weekday} ${time}` : `${weekday} ${time}`;
}

/** Why an account has no number — never "0%". */
function unknownText(state: AccountVitals["state"]): string {
  switch (state) {
    case "logged-out":
      return "logged out";
    case "reset-pending":
      return "reset pending";
    case "missing":
      return "no data";
    default:
      return "stale";
  }
}

/** Status colour for the combined bar: ink when fine, honey/coral when not. */
export function statusFill(summary: VitalsSummary): string {
  if (summary.kind !== "known") {
    return "bg-foreground";
  }
  return summary.status === "critical"
    ? "bg-need"
    : summary.status === "warn"
      ? "bg-honey-ink"
      : "bg-foreground";
}

interface Line {
  key: string;
  tone: "leaf" | "honey" | "need";
  strong: string;
  rest: string;
}

/**
 * One line per account from the combined simulation, including handoffs.
 * Without a simulated account, preserve the hub/pace fallback.
 */
export function accountLines(
  accounts: readonly AccountVitals[],
  combined: CombinedRunway | null = null,
  formatClock: (iso: string) => string = clock,
): Line[] {
  const lines: Line[] = [];
  for (const account of accounts) {
    const projection = combined?.projections.find(
      (row) => row.id === account.id,
    );
    const resetsAt = projection?.resetsAt ?? account.resetsAt;
    const reset = resetsAt ? formatClock(resetsAt) : "";
    const dryAt = projection
      ? projection.beforeReset
        ? projection.dryAt
        : null
      : account.dryAt;
    const projectedAtReset = projection
      ? projection.projectedAtReset
      : account.projectedAtReset;
    const takeover = projection?.takeover;
    if (
      account.used !== null &&
      account.used >= 1 &&
      (!projection || projection.beforeReset)
    ) {
      lines.push({
        key: `${account.id}-out`,
        tone: "need",
        strong: `${account.id} is out`,
        rest: reset ? ` until it resets ${reset}.` : ".",
      });
    } else if (dryAt) {
      lines.push({
        key: `${account.id}-dry`,
        tone: "need",
        strong: takeover
          ? `${account.id} takes over when ${takeover.account} runs dry (${formatClock(takeover.at)})`
          : `${account.id} runs dry around ${formatClock(dryAt)}`,
        rest: `${takeover ? ` and runs dry around ${formatClock(dryAt)}` : ""}${reset ? `, before it resets ${reset}.` : "."}`,
      });
    } else if (projectedAtReset !== null) {
      lines.push({
        key: `${account.id}-safe`,
        tone: "leaf",
        strong: `${account.id} won't run dry`,
        rest: ` — about ${percent(projectedAtReset)}% used when it resets${reset ? ` ${reset}` : ""}.`,
      });
    } else {
      const pace = paceLine(account);
      if (pace) {
        lines.push({
          key: `${account.id}-pace`,
          tone: "honey",
          strong: pace,
          rest: ".",
        });
      }
    }
  }
  return lines;
}

/**
 * The combined all-accounts runway, simulated from the hub's own reading time
 * so the sidebar, headline and account lines share one forecast time.
 */
export function combinedOutlook(
  summary: VitalsSummary,
  runway: Runway | null,
): CombinedRunway | null {
  if (summary.kind !== "known") {
    return null;
  }
  return combinedRunway(summary, runway, summary.computedAt ?? Date.now());
}

/** The sidebar's short form: "both dry Sat 9:07 AM · +4 days" / "lasts 2+ wks". */
export function outlookShort(combined: CombinedRunway | null): string | null {
  return combinedShort(combined, clock);
}

const DOT: Record<Line["tone"], string> = {
  leaf: "bg-leaf",
  honey: "bg-work",
  need: "bg-need",
};

/** Usage details: the combined Claude panel followed by Codex. */
export function VitalsPanel({
  data,
  summary,
  combined = combinedOutlook(summary, data.runway),
  onClose,
}: {
  data: VitalsSnapshot;
  summary: VitalsSummary;
  combined?: CombinedRunway | null;
  onClose: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const headline = combined ? combinedHeadline(combined, clock) : null;
  const method = runwayMethod(data.runway);
  const lines =
    summary.kind === "known" ? accountLines(summary.accounts, combined) : [];
  return (
    <div data-testid="vitals-popover" className="text-foreground">
      <div className="flex h-12.5 items-center gap-2.5 border-b border-border px-4.5">
        <b className="text-base font-bold">Vitals</b>
        {summary.kind === "known" && summary.computedAt !== null ? (
          <span className="font-mono text-2xs text-muted-foreground">
            updated {updatedAgo(summary.computedAt, now)}
          </span>
        ) : null}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <div className="px-4.5 pt-4 pb-3.5">
        <div className="flex items-center justify-between">
          <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {summary.kind === "known" && summary.total > 1
              ? summary.known === summary.total
                ? "Claude · all accounts"
                : `Claude · ${summary.known} of ${summary.total} accounts`
              : "Claude"}
          </span>
          <a
            href={USAGE_HUB_URL}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-semibold text-info-ink hover:text-foreground"
          >
            Usage hub ↗
          </a>
        </div>
        {summary.kind === "known" ? (
          <>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
              <span className="text-3xl font-bold leading-none tracking-tight">
                {percent(summary.free)}% free
              </span>
              {headline ? (
                <span
                  data-testid="vitals-outlook"
                  className="text-sm text-ink-2"
                >
                  {headline.lead}
                  <b className="font-semibold text-foreground">
                    {headline.strong}
                  </b>
                  {headline.rest}
                </span>
              ) : null}
            </div>
            <div className="relative mt-3 h-1.5 rounded-full bg-border">
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  statusFill(summary),
                )}
                style={{ width: `${percent(summary.used)}%` }}
              />
            </div>
            {method ? (
              <p
                data-testid="vitals-runway-method"
                className="mt-1.5 font-mono text-2xs text-muted-foreground"
                title={
                  data.runway?.basis
                    ? `Measured on the ${data.runway.basis} quota window`
                    : undefined
                }
              >
                {method}
              </p>
            ) : null}
            {lines.length > 0 && (
              <ul className="mt-3.5 flex flex-col gap-2 text-sidebar-meta leading-snug">
                {lines.map((line) => (
                  <li key={line.key} className="flex gap-2.25">
                    <span
                      aria-hidden
                      className={cn(
                        "mt-1.75 size-1.5 shrink-0 rounded-full",
                        DOT[line.tone],
                      )}
                    />
                    <span>
                      <b className="font-semibold">{line.strong}</b>
                      {line.rest}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            Usage unavailable — the usage hub did not answer, or has no fresh
            numbers for any account.
          </p>
        )}
        {summary.accounts.length > 0 && (
          <>
            <div className="mt-3.5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 border-t border-dashed border-input pt-3 text-xs">
              {summary.accounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  combined={combined}
                />
              ))}
            </div>
            <p className="mt-1.5 font-mono text-2xs text-muted-foreground">
              tick = how much of each account's window has passed
            </p>
          </>
        )}
      </div>
      <CodexPanel data={data.codex} />
    </div>
  );
}

function AccountRow({
  account,
  combined,
}: {
  account: AccountVitals;
  combined: CombinedRunway | null;
}) {
  const hot = account.status === "warn" || account.status === "critical";
  const dry = accountDryText(account, clock, combined);
  return (
    <>
      <span
        data-testid={`vitals-account-${account.id}`}
        className={cn(
          "flex items-center gap-1.5 whitespace-nowrap",
          hot && "text-coral-ink",
          account.parked && "opacity-60",
        )}
        title={
          account.active ? "Active: new sessions use this account" : undefined
        }
      >
        Account {account.id}
        {account.active && (
          <span
            data-testid="vitals-account-active"
            className="inline-flex items-center gap-1 font-mono text-2xs text-muted-foreground"
          >
            <span aria-hidden className="size-1.5 rounded-full bg-leaf" />
            active
          </span>
        )}
      </span>
      <span className="relative h-1 rounded-full bg-border">
        {account.used !== null && (
          <span
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              hot ? "bg-need" : "bg-ink-2",
            )}
            style={{ width: `${percent(account.used)}%` }}
          />
        )}
        {account.elapsed !== null && (
          <span
            aria-hidden
            className="absolute -top-0.75 -ml-px h-2.5 w-0.5 bg-muted-foreground"
            style={{ left: `${percent(account.elapsed)}%` }}
          />
        )}
      </span>
      <span className="flex flex-col items-end whitespace-nowrap text-right font-mono text-2xs text-muted-foreground">
        <span>
          {accountRowText(account, clock, unknownText(account.state))}
        </span>
        {dry && (
          <span data-testid="vitals-account-dry" className="text-need">
            {dry}
          </span>
        )}
      </span>
    </>
  );
}
