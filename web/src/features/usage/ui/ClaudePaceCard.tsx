import { ChevronDown, ExternalLink, Gauge, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/shared/lib/cn";
import {
  fetchPace,
  type Pace,
  type PaceAccount,
  type PaceStatus,
  USAGE_HUB_URL,
} from "@/features/usage/lib/usageHub";
import {
  formatClock,
  formatCountdown,
  headlineFor,
  nextResetLabel,
  unknownLabel,
} from "@/features/usage/lib/paceFormat";

const REFRESH_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;

const HEADLINE_CLASS: Record<PaceStatus, string> = {
  ok: "text-sidebar-foreground/80",
  warn: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
  unknown: "text-sidebar-foreground/60",
};

/**
 * Per-account bar fill, from THAT account's status: the warn colour when it
 * is warn or critical, the accent otherwise (the redesign's A-orange /
 * B-blue is just what its sample data's statuses produce).
 */
const FILL_CLASS: Record<PaceStatus, string> = {
  ok: "bg-sidebar-active",
  warn: "bg-amber-500",
  critical: "bg-amber-500",
  unknown: "bg-transparent",
};

type Loaded = { pace: Pace; asOf: number; stale: boolean };

/**
 * Polls usage-hub `/v1/pace`: on mount, every 5 min, and when the tab becomes
 * visible. After one success a failed refresh keeps the last payload, marked
 * stale; before any success there is nothing to show.
 */
function usePace(): Loaded | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const signal =
        typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(TIMEOUT_MS)
          : undefined;
      const pace = await fetchPace(signal);
      if (cancelled) return;
      setLoaded((previous) => {
        if (pace) return { pace, asOf: Date.now(), stale: false };
        return previous ? { ...previous, stale: true } : null;
      });
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return loaded;
}

function usedOf(account: PaceAccount): number | null {
  return account.state === "known" && account.usedFraction !== null
    ? account.usedFraction
    : null;
}

/** One bar row in the strip's `14px 1fr 32px` grid: label, bar, percent. */
function AccountBar({ account }: { account: PaceAccount }) {
  const used = usedOf(account);
  return (
    <div
      data-testid="pace-row"
      data-account={account.id}
      data-status={account.status}
      className="contents"
    >
      <span className="font-semibold">{account.id}</span>
      <div
        data-testid="pace-bar"
        className="relative h-1 rounded-[2px] bg-sidebar-foreground/15"
      >
        {used !== null ? (
          <div
            data-testid="pace-fill"
            className={cn("h-full rounded-[2px]", FILL_CLASS[account.status])}
            style={{ width: `${Math.round(Math.min(1, used) * 100)}%` }}
          />
        ) : null}
        {used !== null && account.elapsedFraction !== null ? (
          <span
            data-testid="pace-tick"
            className="absolute -top-0.5 h-2 w-0.5 rounded-[1px] bg-sidebar-foreground/85"
            style={{ left: `${(account.elapsedFraction * 100).toFixed(1)}%` }}
          />
        ) : null}
      </div>
      {/* Unknown usage is never shown as 0%: a "?" here, the reason in the
          details. */}
      <span
        data-testid="pace-percent"
        className="text-right tabular-nums"
        title={used === null ? unknownLabel(account) : undefined}
      >
        {used !== null ? `${Math.round(used * 100)}%` : "?"}
      </span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2" data-testid="pace-detail">
      <span>{label}</span>
      <span className="truncate text-right">{value}</span>
    </div>
  );
}

/**
 * Prop-driven view; the connector below owns fetching.
 *
 * Left-nav redesign (2026-09-28): a flat strip in the sidebar footer — no
 * card border, no shadow. Collapsed it shows the short headline and one bar
 * per account; clicking it toggles the details (resets, next reset,
 * accounts left) and the link through to usage-hub.
 */
export function ClaudePaceCardView({
  pace,
  asOf,
  stale,
  timeZone,
  now = Date.now(),
  defaultExpanded = false,
}: {
  pace: Pace;
  asOf: number;
  stale: boolean;
  timeZone?: string;
  now?: number;
  /** Test seam; the sidebar always starts collapsed. */
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const warning = pace.status === "warn" || pace.status === "critical";
  const Icon = warning ? TriangleAlert : Gauge;
  const headroom =
    pace.headroomAccounts !== null
      ? `~${pace.headroomAccounts.toFixed(1)}${pace.headroomPartial ? " +?" : ""}`
      : null;
  const nextReset = nextResetLabel(pace, timeZone);
  return (
    <div
      data-testid="claude-pace-card"
      data-expanded={expanded ? "true" : "false"}
      className={cn(
        "flex flex-col gap-2 rounded-[8px] px-2.5 py-2 transition-colors hover:bg-sidebar-foreground/5",
        stale && "opacity-60",
      )}
    >
      <button
        type="button"
        data-testid="pace-toggle"
        aria-expanded={expanded}
        aria-label={`Claude usage: ${headlineFor(pace, now)}. ${expanded ? "Hide" : "Show"} details.`}
        onClick={() => setExpanded((value) => !value)}
        className="flex flex-col gap-2 text-left"
      >
        <span className="flex w-full items-center gap-2 text-xs">
          <Icon
            aria-hidden
            className={cn("size-3.25 shrink-0", HEADLINE_CLASS[pace.status])}
          />
          <span
            data-testid="pace-headline"
            data-status={pace.status}
            className={cn(
              "min-w-0 flex-1 truncate font-semibold",
              HEADLINE_CLASS[pace.status],
            )}
          >
            {headlineFor(pace, now)}
          </span>
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-sidebar-foreground/60 transition-transform duration-150",
              expanded && "rotate-180",
            )}
          />
        </span>
        <span className="grid w-full grid-cols-[14px_1fr_32px] items-center gap-x-2 gap-y-1 text-2xs text-sidebar-foreground/60">
          {pace.accounts.map((account) => (
            <AccountBar key={account.id} account={account} />
          ))}
        </span>
      </button>
      {expanded ? (
        <div
          data-testid="pace-details"
          className="flex flex-col gap-0.75 border-t border-sidebar-border pt-1.5 text-xs text-sidebar-foreground/70"
        >
          {pace.accounts.map((account) => {
            const until =
              account.resetsAt && Date.parse(account.resetsAt) > now
                ? formatCountdown(account.resetsAt, now)
                : "";
            const unknown = usedOf(account) === null;
            const value = [unknown ? unknownLabel(account) : "", until]
              .filter(Boolean)
              .join(" · ");
            return (
              <DetailRow
                key={account.id}
                label={`${account.id} resets`}
                value={value || "unknown"}
              />
            );
          })}
          {nextReset ? (
            <DetailRow label="Next reset" value={nextReset} />
          ) : null}
          {headroom ? (
            <DetailRow label="Accounts left" value={headroom} />
          ) : null}
          {stale ? (
            <DetailRow label="As of" value={formatClock(asOf, timeZone)} />
          ) : null}
          <a
            href={USAGE_HUB_URL}
            target="_blank"
            rel="noreferrer"
            data-testid="pace-hub-link"
            className="mt-0.5 flex items-center gap-1 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:underline"
          >
            Open usage hub
            <ExternalLink aria-hidden className="size-3" />
          </a>
        </div>
      ) : null}
    </div>
  );
}

/** Sidebar pace card; renders nothing until usage-hub answers. */
export function ClaudePaceCard({
  timeZone,
  now,
}: {
  /** Test seams; the sidebar mount passes neither. */
  timeZone?: string;
  now?: number;
} = {}) {
  const loaded = usePace();
  if (!loaded) return null;
  return (
    <ClaudePaceCardView
      pace={loaded.pace}
      asOf={loaded.asOf}
      stale={loaded.stale}
      timeZone={timeZone}
      now={now}
    />
  );
}
