/**
 * Neutral placeholder while the landing conversation is still being decided
 * (plan item 5): a restore being validated, or D-025 waiting on DM sampling.
 * It replaces the "Pick a channel to get started" flash, which now appears
 * only when there is genuinely nothing to land in.
 */
export function LandingSkeleton() {
  return (
    <output
      aria-busy="true"
      aria-label="Loading conversation"
      className="flex h-full flex-col justify-end gap-4 p-6"
      data-testid="landing-skeleton"
    >
      {[72, 48, 64].map((width) => (
        <div className="flex items-start gap-3" key={width}>
          <div className="size-8 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-24 animate-pulse rounded bg-muted" />
            <div
              className="h-3 animate-pulse rounded bg-muted"
              style={{ width: `${width}%` }}
            />
          </div>
        </div>
      ))}
    </output>
  );
}
