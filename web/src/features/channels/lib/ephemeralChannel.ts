/**
 * Ephemeral-channel expiry, for the header's countdown badge.
 *
 * The relay puts both halves on the kind-39000: `ttl` (seconds granted) and
 * `ttl_deadline` (an RFC-3339 instant). The deadline is the one that matters
 * — `ttl` alone cannot say when the clock started — and it is what the
 * relay's own sweeper archives against, so a badge derived from it agrees
 * with what the server will actually do.
 *
 * Pure, and clock-injected, so "expires in 3 minutes" is testable without
 * waiting three minutes.
 */

export type EphemeralUrgency = "normal" | "soon" | "expired";

export interface EphemeralDisplay {
  /** Short badge text: "3m left", "1h 5m left", "expired", "ended". */
  label: string;
  /** Full sentence for the title/aria attribute. */
  title: string;
  /** Seconds until the deadline; 0 once it has passed. */
  secondsRemaining: number;
  urgency: EphemeralUrgency;
}

/** Under this many seconds remaining the badge escalates to "soon". */
export const EPHEMERAL_SOON_SECONDS = 5 * 60;

/** Parse the relay's RFC-3339 `ttl_deadline` into unix seconds, or null. */
export function parseTtlDeadline(
  value: string | null | undefined,
): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function humanize(seconds: number): string {
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m`;
  }
  return `${Math.max(0, seconds)}s`;
}

/**
 * The badge for a channel, or null when it is permanent.
 *
 * A channel with a `ttl` but no parsable deadline still gets a badge — it IS
 * ephemeral, and saying so without a countdown beats saying nothing.
 *
 * An ARCHIVED channel never shows a countdown: the relay has already ended
 * it, and "57m left" on a dead huddle is exactly the stale-room lie the
 * reload-survival work exists to kill (VOICE_E2E_2026-09-17 V1b). The
 * deadline is moot once `archived_at` is set.
 */
export function ephemeralDisplay(
  channel: {
    ttlSeconds: number | null;
    ttlDeadline: string | null;
    archived?: boolean;
  },
  nowSeconds: number = Date.now() / 1000,
): EphemeralDisplay | null {
  if (channel.ttlSeconds === null) {
    return null;
  }
  if (channel.archived) {
    return {
      label: "ended",
      title: "This channel has ended — the relay archived it.",
      secondsRemaining: 0,
      urgency: "expired",
    };
  }
  const deadline = parseTtlDeadline(channel.ttlDeadline);
  if (deadline === null) {
    return {
      label: "temporary",
      title: "This channel is temporary and will be archived automatically.",
      secondsRemaining: channel.ttlSeconds,
      urgency: "normal",
    };
  }
  const remaining = Math.floor(deadline - nowSeconds);
  if (remaining <= 0) {
    return {
      label: "expired",
      title: "This channel's time is up — the relay will archive it.",
      secondsRemaining: 0,
      urgency: "expired",
    };
  }
  return {
    label: `${humanize(remaining)} left`,
    title: `This channel is archived automatically in ${humanize(remaining)}.`,
    secondsRemaining: remaining,
    urgency: remaining <= EPHEMERAL_SOON_SECONDS ? "soon" : "normal",
  };
}
