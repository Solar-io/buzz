import { formatElapsed } from "@/features/agents/ui/WorkingBadge";
import { cn } from "@/shared/lib/cn";

/** Props for {@link DmTimerPill}. */
export interface DmTimerPillProps {
  /** Turn start in unix seconds. */
  startedAt: number;
  /** Current time in unix seconds. */
  now: number;
  /** Selected rows inherit the active row's colour, muted by opacity. */
  selected?: boolean;
}

/**
 * The DM row's working time. Left-nav redesign (2026-09-28): plain grey 11px
 * text, no pill, no pulse — the row was too loud with a tinted pill beside
 * the accent unread badge. The name is kept so the call sites and the
 * dm-list-spec references still line up.
 */
export function DmTimerPill({ startedAt, now, selected }: DmTimerPillProps) {
  return (
    <span
      data-testid="dm-row-time"
      className={cn(
        "shrink-0 text-2xs font-normal tabular-nums",
        selected ? "opacity-60" : "text-sidebar-foreground/50",
      )}
    >
      {formatElapsed(startedAt, now)}
    </span>
  );
}
