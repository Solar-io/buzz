import { useEffect, useState } from "react";

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
  unknownLabel,
} from "@/features/usage/lib/paceFormat";

const REFRESH_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;

const HEADLINE_CLASS: Record<PaceStatus, string> = {
  ok: "text-sidebar-foreground/70",
  warn: "text-amber-400",
  critical: "text-red-400",
  unknown: "text-sidebar-foreground/50",
};

const FILL_CLASS: Record<PaceStatus, string> = {
  ok: "bg-sidebar-foreground/50",
  warn: "bg-amber-400",
  critical: "bg-red-400",
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

function AccountRow({ account, now }: { account: PaceAccount; now: number }) {
  const used =
    account.state === "known" && account.usedFraction !== null
      ? account.usedFraction
      : null;
  // Every account gets its own countdown, known or not, when the hub gave a
  // future reset time (an unknown account still resets on schedule).
  const until =
    account.resetsAt && Date.parse(account.resetsAt) > now
      ? formatCountdown(account.resetsAt, now)
      : "";
  const countdown = until ? ` · resets ${until}` : "";
  return (
    <div data-testid="pace-row" data-account={account.id}>
      <div className="text-2xs text-sidebar-foreground/60">
        {used !== null
          ? `${account.id} ${Math.round(used * 100)}%${countdown}`
          : `${account.id} ${unknownLabel(account)}${countdown}`}
      </div>
      <div
        data-testid="pace-bar"
        className="relative mt-0.5 h-1 w-full rounded-full bg-white/10"
      >
        {used !== null ? (
          <div
            data-testid="pace-fill"
            className={`h-full rounded-full ${FILL_CLASS[account.status]}`}
            style={{ width: `${Math.round(Math.min(1, used) * 100)}%` }}
          />
        ) : null}
        {used !== null && account.elapsedFraction !== null ? (
          <div
            data-testid="pace-tick"
            className="absolute -top-0.5 h-2 w-px bg-sidebar-foreground/80"
            style={{ left: `${(account.elapsedFraction * 100).toFixed(1)}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Prop-driven view; the connector below owns fetching. */
export function ClaudePaceCardView({
  pace,
  asOf,
  stale,
  timeZone,
  now = Date.now(),
}: {
  pace: Pace;
  asOf: number;
  stale: boolean;
  timeZone?: string;
  now?: number;
}) {
  const headroom =
    pace.headroomAccounts !== null
      ? `~${pace.headroomAccounts.toFixed(1)} accounts left${
          pace.headroomPartial ? " +?" : ""
        }`
      : null;
  return (
    <div className="px-3 pb-1">
      <a
        href={USAGE_HUB_URL}
        target="_blank"
        rel="noreferrer"
        data-testid="claude-pace-card"
        className={`block space-y-1 rounded-[8px] px-2 py-1.5 transition-colors hover:bg-white/5 ${
          stale ? "opacity-60" : ""
        }`}
      >
        <div
          data-testid="pace-headline"
          data-status={pace.status}
          className={`text-xs ${HEADLINE_CLASS[pace.status]}`}
        >
          {headlineFor(pace, timeZone, now)}
        </div>
        {pace.accounts.map((account) => (
          <AccountRow key={account.id} account={account} now={now} />
        ))}
        {headroom || stale ? (
          <div
            data-testid="pace-secondary"
            className="text-2xs text-sidebar-foreground/50"
          >
            {headroom}
            {stale
              ? `${headroom ? " · " : ""}as of ${formatClock(asOf, timeZone)}`
              : null}
          </div>
        ) : null}
      </a>
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
