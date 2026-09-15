/**
 * Timeline zero-height recovery (D-025 height leg). Pure logic, testable
 * without a DOM.
 *
 * Mechanism being survived (2026-09-15 trace, .scratch/d025-ro-trace.json):
 * the timeline's virtualizer rows churn (mass unmount to 0x0 inside one
 * ResizeObserver delivery cycle), which trips WebKit's RO-loop guard; when
 * the VList's own size notification lands in the cycle WebKit drops, the
 * list never learns its bounds and freezes at height 0 — while its wrapper
 * (the shell reserves it) stays at full height. A race you cannot prevent;
 * you can detect it and remount. Remount is safe ONLY in the collapsed
 * state (CO's constraint): below threshold there is no reader position to
 * preserve, while a healthy list's scroll/follow state must never reset.
 */

export interface RecoveryInputs {
  /** Wrapper height in px; 0 when the wrapper is not mounted/measurable. */
  wrapperHeight: number;
  /** VList element height in px. */
  listHeight: number;
  /** Consecutive collapsed samples already seen (state carried in). */
  collapsedBeats: number;
  /** Remounts already performed for this mount lineage. */
  recoveries: number;
}

export interface RecoveryDecision {
  action: "wait" | "recover" | "healthy";
  /** Updated collapsed-beat counter for the caller to carry. */
  collapsedBeats: number;
}

/** Wrapper must be at least this tall before "list is 0" means collapse. */
export const WRAPPER_MIN_HEIGHT = 200;
/** A list at or below this is collapsed (near-zero per the trace: 0). */
export const LIST_COLLAPSED_MAX = 40;
/** Collapsed samples required back-to-back before remounting (250ms each). */
export const COLLAPSED_BEATS_REQUIRED = 2;
/** Never remount more than this many times; a loop means the bug is not ours. */
export const MAX_RECOVERIES = 3;

export function decideTimelineRecovery(i: RecoveryInputs): RecoveryDecision {
  const { wrapperHeight, listHeight, collapsedBeats, recoveries } = i;
  if (wrapperHeight >= WRAPPER_MIN_HEIGHT && listHeight <= LIST_COLLAPSED_MAX) {
    if (
      collapsedBeats + 1 >= COLLAPSED_BEATS_REQUIRED &&
      recoveries < MAX_RECOVERIES
    ) {
      return { action: "recover", collapsedBeats: 0 };
    }
    return { action: "wait", collapsedBeats: collapsedBeats + 1 };
  }
  // Healthy (or wrapper not yet laid out — the 16:18 lesson: never decide
  // before the thing exists). Any non-collapsed sample resets the streak.
  return { action: "healthy", collapsedBeats: 0 };
}
