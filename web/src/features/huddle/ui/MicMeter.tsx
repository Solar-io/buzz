import { cn } from "@/shared/lib/cn";
import { micMeterFraction } from "../lib/micMeter.ts";

/**
 * The viewer's own input level.
 *
 * Its job is to answer "is my microphone hearing me", which is why it keeps
 * moving while muted — greyed rather than blank, so a muted mic that is
 * still picking you up is visibly different from a dead one.
 */
export function MicMeter({
  levelDbov,
  muted,
}: {
  levelDbov: number;
  muted: boolean;
}) {
  const fraction = micMeterFraction(levelDbov);
  return (
    // biome-ignore lint/a11y/useSemanticElements: <meter> cannot host the two-element fill/track structure this needs, and its native chrome is not themeable
    <span
      data-testid="mic-meter"
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      className="h-1.5 w-16 overflow-hidden rounded-full bg-border"
    >
      <span
        aria-hidden
        className={cn(
          "block h-full rounded-full transition-[width] duration-100",
          muted ? "bg-muted-foreground/50" : "bg-emerald-500",
        )}
        style={{ width: `${Math.round(fraction * 100)}%` }}
      />
    </span>
  );
}
