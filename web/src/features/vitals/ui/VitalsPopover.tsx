import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { USAGE_HUB_URL } from "@/features/usage/lib/usageHub.ts";
import { cn } from "@/shared/lib/cn";
import {
  type AccountVitals,
  formatRunway,
  paceLine,
  percent,
  type RunDry,
  runDryNote,
  runwayMethod,
  updatedAgo,
  type VitalsSummary,
} from "../lib/vitalsMath.ts";
import type { VitalsSnapshot } from "../useVitals.ts";

/** "4:58 PM" today; "Tue 8:00 AM" on another day (weekly windows). */
export function clock(iso: string | null): string {
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
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
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

/** The pace intelligence `/v1/pace` supports today (phase-1 §4). */
function accountLines(accounts: readonly AccountVitals[]): Line[] {
  const lines: Line[] = [];
  for (const account of accounts) {
    const pace = paceLine(account);
    if (account.fillsAt) {
      lines.push({
        key: `${account.id}-fills`,
        tone: "need",
        strong: pace ?? `${account.id} fills around ${clock(account.fillsAt)}`,
        rest: pace ? ` and fills around ${clock(account.fillsAt)}.` : ".",
      });
    } else if (pace) {
      lines.push({
        key: `${account.id}-pace`,
        tone: "honey",
        strong: pace,
        rest: ".",
      });
    } else if (account.unusedAtReset !== null) {
      lines.push({
        key: `${account.id}-unused`,
        tone: "leaf",
        strong: `${account.id} resets with ~${account.unusedAtReset}% unused`,
        rest: account.resetsAt ? `, ${clock(account.resetsAt)}.` : ".",
      });
    }
  }
  return lines;
}

/** The runway against the next reset (Vitals artboard), first in the list. */
function runDryLine(note: RunDry | null): Line | null {
  if (!note) {
    return null;
  }
  const when = clock(note.resetsAt);
  return note.kind === "safe"
    ? {
        key: "run-dry",
        tone: "leaf",
        strong: "You won't run dry.",
        rest: ` Account ${note.account} resets ${when}, ${note.well ? "well " : ""}inside the runway.`,
      }
    : {
        key: "run-dry",
        tone: "honey",
        strong: "The runway ends before the next reset",
        rest: ` if you work without a break — Account ${note.account} resets ${when}.`,
      };
}

const DOT: Record<Line["tone"], string> = {
  leaf: "bg-leaf",
  honey: "bg-work",
  need: "bg-need",
};

/** The Vitals panel (Vitals.dc.html): Claude only until crichton lands (Phase 7). */
export function VitalsPanel({
  data,
  summary,
  onClose,
}: {
  data: VitalsSnapshot;
  summary: VitalsSummary;
  onClose: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const runway = formatRunway(data.runway);
  const method = runwayMethod(data.runway);
  const runDry = runDryLine(
    runDryNote(data.runway, data.pace?.nextReset ?? null, now),
  );
  const lines =
    summary.kind === "known"
      ? [...(runDry ? [runDry] : []), ...accountLines(summary.accounts)]
      : [];
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
              {runway ? (
                <span className="text-sm text-ink-2">
                  about{" "}
                  <b className="font-semibold text-foreground">
                    {runway.slice(1)}
                  </b>{" "}
                  of active work at your usual pace
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
            <div className="mt-3.5 grid grid-cols-[5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 border-t border-dashed border-input pt-3 text-xs">
              {summary.accounts.map((account) => (
                <AccountRow key={account.id} account={account} />
              ))}
            </div>
            <p className="mt-1.5 font-mono text-2xs text-muted-foreground">
              tick = how much of each account's window has passed
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function AccountRow({ account }: { account: AccountVitals }) {
  const hot = account.status === "warn" || account.status === "critical";
  return (
    <>
      <span
        className={cn(hot && "text-coral-ink", account.parked && "opacity-60")}
      >
        Account {account.id}
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
      <span className="whitespace-nowrap text-right font-mono text-2xs text-muted-foreground">
        {account.used !== null
          ? `${percent(account.used)}%${account.resetsAt ? ` · resets ${clock(account.resetsAt)}` : ""}`
          : unknownText(account.state)}
      </span>
    </>
  );
}
