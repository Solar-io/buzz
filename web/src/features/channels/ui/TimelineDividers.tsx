import { cn } from "@/shared/lib/cn";

/**
 * Day separator, in the desktop's shape (`desktop/.../DayDivider.tsx`): a
 * bordered pill on the app background, centered, rather than a hairline with
 * a bare label.
 *
 * `pinned` renders the same pill as a floating overlay above the list. That
 * overlay is how "sticky" is achieved here at all: `virtua` gives every item
 * `position: absolute`, so a `position: sticky` child inside a row can only
 * stick within that row's own box — it does nothing. The desktop hits the
 * same wall and solves it the same way, with a separately positioned pinned
 * divider over its virtualized list.
 */
export function DayDivider({
  label,
  pinned = false,
}: {
  label: string;
  pinned?: boolean;
}) {
  return (
    <section
      aria-label={label}
      data-day-label={label}
      data-testid={
        pinned ? "timeline-sticky-day-divider" : "timeline-day-divider"
      }
      className={cn(
        "pointer-events-none flex justify-center",
        pinned ? "px-2 py-2" : "px-2 py-2",
      )}
    >
      <p
        className={cn(
          "shrink-0 rounded-full border border-border/70 bg-background px-2.5 py-1",
          "text-2xs font-medium tracking-[0.02em] text-muted-foreground",
          pinned && "shadow-xs",
        )}
      >
        {label}
      </p>
    </section>
  );
}

export function UnreadDivider() {
  return (
    <div className="flex items-center gap-3 px-2 py-1">
      <span className="h-px flex-1 bg-border" />
      <span className="rounded-full bg-emerald-600/20 px-2 py-0.5 text-xs font-semibold text-emerald-500">
        New
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
