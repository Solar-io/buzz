/**
 * Auto-tail follow semantics for scrollable panes (the thinking panel first).
 *
 * Pure geometry: "following" simply means the scroller sits at (or within a
 * rounding tolerance of) the bottom. That single rule implements the whole
 * pause/resume contract without distinguishing user scrolls from our own
 * programmatic tail scrolls — both just move the scroller, and the next
 * position decides whether tailing continues:
 *
 * - New content streams while following → the tail effect keeps pinning the
 *   scroller to the bottom.
 * - The user scrolls up to read → distance from the bottom exceeds the
 *   tolerance → tailing pauses (no scroll event from streaming content can
 *   fire, because growing scrollHeight below the viewport moves nothing).
 * - The user scrolls back down to the bottom → within tolerance again →
 *   tailing resumes exactly as before.
 */

/**
 * Distance from the bottom (px) that still counts as "caught up". Covers
 * sub-pixel/rounding drift from fractional scroll metrics on hidpi screens.
 */
export const FOLLOW_EDGE_PX = 32;

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
