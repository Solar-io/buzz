import { cn } from "@/shared/lib/cn";
import {
  progressLabel,
  progressSegments,
  type TaskProgress,
} from "../lib/taskStatus.ts";

/**
 * A turn's `buzz status set --progress` as segments (Main and PhoneChannel
 * artboards): finished steps solid ink, the step in hand amber and pulsing
 * while the turn is live, the rest faint. Null when the total is too long to
 * draw — the caller writes "n of m" in its text instead.
 */
export function ProgressSegments({
  progress,
  live,
  size = "rail",
}: {
  progress: TaskProgress;
  /** Only a live turn pulses its current step; a quiet one holds still. */
  live: boolean;
  /** "rail" = 10 px segments; "bar" = the phone strip's 14 px. */
  size?: "rail" | "bar";
}) {
  const segments = progressSegments(progress);
  if (!segments) {
    return null;
  }
  return (
    <span
      role="img"
      aria-label={progressLabel(progress)}
      data-testid="progress-segments"
      data-progress={`${progress.done}/${progress.total}`}
      className="flex shrink-0 gap-0.5"
    >
      {segments.map((segment, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          key={index}
          data-segment={segment}
          className={cn(
            "h-1 rounded-full",
            size === "bar" ? "w-3.5" : "w-2.5",
            segment === "done" && "bg-ink-2",
            segment === "current" &&
              (live ? "bg-work motion-safe:animate-pulse" : "bg-line-2"),
            segment === "todo" && "bg-line-2",
          )}
        />
      ))}
    </span>
  );
}
