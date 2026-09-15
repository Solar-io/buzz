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

/**
 * Input-armed follow (the desktop's `useVirtualizedBottomSettle` semantics,
 * ported 2026-09-14 for the virtualized timeline).
 *
 * The delta-paused engine above cannot tell a reader's upward drag from the
 * upward corrections a virtualizer emits while converging on a programmatic
 * `scrollToIndex` — on iOS WKWebView those corrections arrive as ordinary
 * scroll events seconds apart from the jump that caused them, so the tail's
 * own settling pauses the tail (live incident: every send after that lands
 * below the fold, Sam 2026-09-14). The desktop solved it by keying the pause
 * on READER INPUT, not on scroll deltas:
 *
 * - A touch/wheel/scroll-key/scrollbar input ARMS intent for a short window.
 * - An armed input followed by upward movement pauses tailing (the 9/13
 *   "it keeps scrolling on by" fix, preserved).
 * - Unarmed upward movement — the virtualizer correcting itself — never
 *   pauses anything.
 * - Reaching the bottom resumes tailing, whatever armed it (position stays
 *   the resume rule).
 *
 * The engine is a plain mutable record so refs in the component stay cheap
 * and the semantics stay unit-testable without a DOM.
 */

/** How long an input keeps intent armed, waiting for its scroll to land. */
export const FOLLOW_INPUT_ARM_MS = 600;

export interface InputFollowState {
  follow: boolean;
  /** An input that could scroll has been seen; its scroll may not have landed yet. */
  armed: boolean;
  /** performance.now() of the arm; stale arms expire instead of pausing later. */
  armedAt: number;
  prevScrollTop: number;
}

export function createInputFollowState(follow = true): InputFollowState {
  return { follow, armed: false, armedAt: 0, prevScrollTop: 0 };
}

/**
 * A reader input that could scroll the pane: touchmove, wheel, a scrollbar
 * drag / direct scroller pointerdown, or a scroll-intent keypress. Arms
 * intent; `applyInputFollowScroll` decides whether it actually pauses.
 */
export function armFollowInput(state: InputFollowState, now: number): void {
  state.armed = true;
  state.armedAt = now;
}

/**
 * Force tailing back on regardless of position — the reader's own send is
 * the deliberate exception (desktop `prepareForOwnMessage`: "the user's own
 * send … arms the next-append bottom pin"). A send is the clearest possible
 * "show me the bottom" signal, even if the reader had scrolled up to read.
 */
export function forceInputFollow(state: InputFollowState): void {
  state.follow = true;
}

/**
 * Apply one scroll event. Returns the follow state after the event.
 *
 * - Armed + upward movement → paused (reader intent outranks the band).
 * - At the bottom → following (the resume rule — position, whatever armed it).
 * - Otherwise (unarmed movement in any direction — virtualizer corrections,
 *   downward pinning) → the current state carries over.
 */
export function applyInputFollowScroll(
  state: InputFollowState,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  now: number,
  edge = FOLLOW_EDGE_PX,
  upward = FOLLOW_UPWARD_PX,
): boolean {
  const armed = state.armed && now - state.armedAt <= FOLLOW_INPUT_ARM_MS;
  const movedUp = scrollTop < state.prevScrollTop - upward;
  if (armed && movedUp) {
    state.armed = false;
    state.follow = false;
  } else if (isScrolledToBottom(scrollTop, scrollHeight, clientHeight, edge)) {
    // Reaching the bottom consumes any pending arm — the reader came back.
    state.armed = false;
    state.follow = true;
  }
  // Any movement at all retires a stale arm so an unconsumed horizontal
  // swipe cannot pause a later programmatic settle.
  if (Math.abs(scrollTop - state.prevScrollTop) > 0) {
    state.armed = false;
  }
  state.prevScrollTop = scrollTop;
  return state.follow;
}
