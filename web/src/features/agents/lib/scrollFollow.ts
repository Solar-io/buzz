/**
 * Auto-tail follow semantics for scrollable panes (thinking panel, channel
 * timeline, thread panels — one contract everywhere).
 *
 * "Following" means the scroller sits at (or within a rounding tolerance of)
 * the bottom. Two signals drive it — position AND direction:
 *
 * - New content streams while following → the tail effect keeps pinning the
 *   scroller to the bottom.
 * - The user scrolls up to read → tailing pauses on ANY upward movement,
 *   not only beyond the bottom tolerance: during a fast stream the tail
 *   effect re-pins the bottom between the reader's small upward deltas, so
 *   a position-only rule erases each delta before it adds up to an escape
 *   (observed live: "it stops for a second, and then it just keeps
 *   scrolling on by" — Sam, 2026-09-13).
 * - The user scrolls back down to the very bottom → within tolerance again
 *   → tailing resumes exactly as before.
 *
 * Position stays the resume rule; direction only sharpens the pause. No
 * user-vs-programmatic disambiguation beyond that — both just move the
 * scroller, and where it ends up (plus which way it went) decides.
 */

/**
 * Distance from the bottom (px) that still counts as "caught up". Covers
 * sub-pixel/rounding drift from fractional scroll metrics on hidpi screens.
 */
export const FOLLOW_EDGE_PX = 32;

/**
 * Upward movement of at most this many px is sub-pixel/rounding noise, not
 * reader intent, and does not pause tailing.
 */
export const FOLLOW_UPWARD_PX = 1;

/**
 * Whether a scroller with these metrics is at the bottom. Any non-positive
 * or tiny content height counts as at-bottom (nothing to scroll).
 */
export function isScrolledToBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  edge = FOLLOW_EDGE_PX,
): boolean {
  const distance = scrollHeight - clientHeight - scrollTop;
  return distance <= edge;
}

/**
 * The follow state after one scroll event (user or programmatic — the
 * caller does not need to know which).
 *
 * - At the bottom → following (the resume rule).
 * - Moved up beyond noise → paused, whatever the distance from the bottom
 *   (the pause rule; see the module doc for why position alone is not
 *   enough under a fast stream).
 * - Otherwise (moved down but not to the bottom — momentum settling, a
 *   pagination restore) → the current state carries over.
 */
export function nextFollowState(
  current: boolean,
  prevScrollTop: number,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  edge = FOLLOW_EDGE_PX,
  upward = FOLLOW_UPWARD_PX,
): boolean {
  // Upward intent outranks the tolerance: a small scroll-up that lands
  // inside the at-bottom band must still pause (the band exists for
  // programmatic-tail drift, not for reader intent).
  if (scrollTop < prevScrollTop - upward) {
    return false;
  }
  if (isScrolledToBottom(scrollTop, scrollHeight, clientHeight, edge)) {
    return true;
  }
  return current;
}
