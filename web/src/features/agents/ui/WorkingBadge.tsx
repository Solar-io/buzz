import { useEffect, useState } from "react";

/** Re-render every second while mounted (drives the elapsed timer). */
export function useTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
}

/** "1m 23s" / "42s" / "1h 02m" — elapsed since a unix-seconds start. */
export function formatElapsed(startedAt: number, nowSeconds: number): string {
  const total = Math.max(0, Math.floor(nowSeconds - startedAt));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

/**
 * "Working · 1m 23s" pill with a pulsing dot — the received-and-working
 * indication Sam asked for (8/30), shown by the agent's name.
 */
export function WorkingBadge({
  startedAt,
  className,
  compact,
}: {
  startedAt: number;
  className?: string;
  /** Sidebar form: timer only, no "Working" word (the dot carries it). */
  compact?: boolean;
}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return (
    <span
      className={
        "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.18] px-2.5 py-0.5 text-xs font-medium tabular-nums text-foreground " +
        (className ?? "")
      }
      data-working-since={startedAt}
    >
      {!compact && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
      )}
      {compact
        ? formatElapsed(startedAt, nowSeconds)
        : `Working · ${formatElapsed(startedAt, nowSeconds)}`}
    </span>
  );
}
