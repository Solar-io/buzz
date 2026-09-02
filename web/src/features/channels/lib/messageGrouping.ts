/**
 * Message grouping window — the desktop's MESSAGE_GROUPING_WINDOW_SECONDS
 * rule (desktop/src/features/messages/lib/messageGrouping.ts), mirrored for
 * the web. The packages do not share source; keep the two files in sync.
 */

/**
 * Max gap (seconds) between two same-author messages for the later one to
 * still render as a continuation (no avatar/header, no own timestamp).
 * Beyond this the message reads as a new thought and gets its own header
 * with a timestamp — a same-author message from "earlier in the day" must
 * never render merged into a prior block (live incident 2026-09-01: an
 * evening message appeared glued to a morning message with no time of its
 * own, because the web grouped on author-adjacency alone).
 */
export const MESSAGE_GROUPING_WINDOW_SECONDS = 10 * 60;

/**
 * Whether `current` falls within {@link MESSAGE_GROUPING_WINDOW_SECONDS} of
 * `previous`. Both timestamps are Unix seconds. A missing previous timestamp
 * (or one in the future — out-of-order arrival) is treated as out of window.
 */
export function isWithinGroupingWindow(
  previousCreatedAt: number | null | undefined,
  currentCreatedAt: number | null | undefined,
): boolean {
  if (
    typeof previousCreatedAt !== "number" ||
    typeof currentCreatedAt !== "number"
  ) {
    return false;
  }
  const gap = currentCreatedAt - previousCreatedAt;
  return gap >= 0 && gap <= MESSAGE_GROUPING_WINDOW_SECONDS;
}
