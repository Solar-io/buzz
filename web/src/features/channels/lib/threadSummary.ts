/**
 * Thread header facts: who is in the conversation, how many replies there
 * are, and when the last one landed.
 *
 * Ported from the desktop's `MessageThreadSummaryRow` (the overlapping
 * participant avatars) and `formatThreadSummaryLastReplyTime` in
 * `desktop/src/features/messages/lib/dateFormatters.ts` (the relative ladder).
 * Pure functions so the header's strings are testable without a DOM.
 */

import type { TimelineMessage } from "./messageBuffer.ts";

/** Default number of avatars the stack renders before the "+N" chip. */
export const PARTICIPANT_STACK_LIMIT = 4;

export interface ThreadParticipants {
  /** Pubkeys to draw, root author first, then repliers by first appearance. */
  shown: string[];
  /** How many further distinct participants exist beyond `shown`. */
  overflow: number;
  /** Total distinct participants, including the root author. */
  total: number;
}

/**
 * Distinct participants in a thread, in the order they first spoke.
 *
 * The root author leads — the thread is their message — and repliers follow in
 * chronological order, deduped. `replies` is expected oldest-first, which is
 * what `threadRepliesOf` returns.
 */
export function threadParticipants(
  root: TimelineMessage,
  replies: readonly TimelineMessage[],
  limit: number = PARTICIPANT_STACK_LIMIT,
): ThreadParticipants {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (pubkey: string) => {
    if (pubkey && !seen.has(pubkey)) {
      seen.add(pubkey);
      ordered.push(pubkey);
    }
  };
  add(root.authorPubkey);
  for (const reply of replies) {
    add(reply.authorPubkey);
  }
  const capped = Math.max(0, limit);
  return {
    shown: ordered.slice(0, capped),
    overflow: Math.max(0, ordered.length - capped),
    total: ordered.length,
  };
}

const SHORT_MONTH_DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

function ago(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
}

/**
 * "just now" / "5 minutes ago" / "3 hours ago" / "2 days ago" / "on Aug 28".
 *
 * The desktop's ladder, thresholds included: under a minute, under an hour,
 * under a day, under a week, then an absolute short date.
 */
export function formatLastReplyTime(
  unixSeconds: number,
  nowSeconds: number = Date.now() / 1000,
): string {
  const diff = Math.max(0, nowSeconds - unixSeconds);
  if (diff < 60) {
    return "just now";
  }
  if (diff < 3600) {
    return ago(Math.floor(diff / 60), "minute");
  }
  if (diff < 86_400) {
    return ago(Math.floor(diff / 3600), "hour");
  }
  if (diff < 604_800) {
    return ago(Math.floor(diff / 86_400), "day");
  }
  return `on ${SHORT_MONTH_DAY.format(new Date(unixSeconds * 1000))}`;
}

/**
 * The header's summary line: "3 replies · last reply 5 minutes ago".
 *
 * Returns just the count when there is nothing to date (no replies yet).
 */
export function threadSummaryLine(
  replyCount: number,
  lastReplyAt: number | null,
  nowSeconds?: number,
): string {
  const label = `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`;
  if (replyCount === 0 || lastReplyAt === null) {
    return label;
  }
  return `${label} · last reply ${formatLastReplyTime(lastReplyAt, nowSeconds)}`;
}
