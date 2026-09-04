import { Clock } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/shared/lib/cn";
import { formatTimeoutRemaining } from "../lib/timeout.ts";

/**
 * A banner docked to the top edge of the composer while the viewer is timed
 * out by community moderators. Shows a live countdown when the relay gave an
 * expiry; otherwise states the block without a timer.
 *
 * The per-second tick lives here rather than in the composer: the countdown is
 * this component's only reason to re-render, and hoisting it would re-render
 * the whole composer (and its draft state) once a second.
 */
export function ComposerTimeoutBanner({
  expiresAtMs,
  className,
}: {
  /** Timeout expiry in epoch ms, or null when the relay gave no timestamp. */
  expiresAtMs: number | null;
  className?: string;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (expiresAtMs === null) {
      return;
    }
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAtMs]);

  const remaining = formatTimeoutRemaining(expiresAtMs, nowMs);

  return (
    <div
      className={cn(
        // `warning.bg` is the purpose-built translucent fill for this token
        // pair; the border reuses the solid `warning` at low opacity so the
        // two stay in step when the runtime theme engine rewrites both.
        "flex items-center gap-2 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2",
        "text-sm leading-5 text-foreground",
        className,
      )}
      data-testid="composer-timeout-banner"
      role="status"
    >
      <Clock aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
      <span className="min-w-0">
        {remaining
          ? `You're timed out by community moderators — ${remaining} left.`
          : "You're timed out by community moderators."}
      </span>
    </div>
  );
}
