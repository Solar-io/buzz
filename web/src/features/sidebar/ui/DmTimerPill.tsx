import { formatElapsed } from "@/features/agents/ui/WorkingBadge";
import { cn } from "@/shared/lib/cn";

/** Props for {@link DmTimerPill}. */
export interface DmTimerPillProps {
  /** Turn start in unix seconds — also seeds the pulse phase. */
  startedAt: number;
  /** Current time in unix seconds. */
  now: number;
  /** Inverts the pill on the selected row. */
  selected: boolean;
}

/**
 * DM-list timer pill (dm-list-spec.md §6): 15px fully-rounded pill,
 * ~9% accent background, accent text; the whole element pulses
 * 0.8 → 1.0 → 0.8 with a phase tied to its own countdown (negative
 * animation-delay), and inverts on the selected row.
 */
export function DmTimerPill({ startedAt, now, selected }: DmTimerPillProps) {
  const period = 2.4;
  const elapsed = Math.max(0, now - startedAt);
  return (
    <span
      className={cn("dm-timer-pill", selected && "dm-timer-pill-selected")}
      style={{ animationDelay: `-${(elapsed % period).toFixed(2)}s` }}
    >
      {formatElapsed(startedAt, now)}
    </span>
  );
}
