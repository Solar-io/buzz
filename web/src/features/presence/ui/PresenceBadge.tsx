import type { HTMLAttributes } from "react";

import { cn } from "@/shared/lib/cn";

import {
  presenceChipClass,
  presenceDotClass,
  presenceLabel,
  type ObservedPresenceStatus,
} from "../lib/presenceStatus.ts";

/**
 * The 8px status disc. `aria-hidden` by default: on its own a coloured dot
 * says nothing to a screen reader, so every caller either pairs it with the
 * label ({@link PresenceBadge}) or puts the status in the host control's
 * accessible name.
 */
export function PresenceDot({
  status,
  className,
  ...props
}: {
  status: ObservedPresenceStatus;
  className?: string;
} & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-2 shrink-0 rounded-full",
        presenceDotClass(status),
        className,
      )}
      data-presence={status}
      title={presenceLabel(status)}
      {...props}
    />
  );
}

/**
 * A dot over an avatar: the same disc, ringed in the surface colour so it
 * reads as a badge rather than a smudge on the picture.
 */
export function PresenceAvatarDot({
  status,
  className,
}: {
  status: ObservedPresenceStatus;
  className?: string;
}) {
  return (
    <PresenceDot
      className={cn(
        "absolute -bottom-0.5 -right-0.5 ring-2 ring-card",
        className,
      )}
      status={status}
    />
  );
}

/** Dot plus label, for surfaces with room to spell it out. */
export function PresenceBadge({
  status,
  className,
  label,
}: {
  status: ObservedPresenceStatus;
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-2xs font-medium text-muted-foreground",
        className,
      )}
      data-presence={status}
      data-testid="presence-badge"
    >
      <PresenceDot status={status} />
      <span>{label ?? presenceLabel(status)}</span>
    </span>
  );
}

/** Filled pill — colour-only, for dense rows where a border is noise. */
export function PresenceChip({
  status,
  className,
}: {
  status: ObservedPresenceStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium",
        presenceChipClass(status),
        className,
      )}
      data-presence={status}
    >
      {presenceLabel(status)}
    </span>
  );
}
