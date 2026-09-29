import { type RefObject, useEffect, useRef } from "react";
import type { VListHandle } from "virtua";

/** How long the target's row may take to appear before the jump gives up. */
export const PERMALINK_ROW_WAIT_MS = 1_500;
/** Total budget for landing (and re-anchoring) one permalink jump. */
export const PERMALINK_SETTLE_MAX_MS = 3_000;
/** Poll interval: re-resolve the index, verify, re-jump if needed. */
const POLL_MS = 100;

export interface PermalinkScrollOptions {
  /** Message to bring into view; null/undefined means no jump is active. */
  targetId: string | null | undefined;
  listRef: RefObject<VListHandle | null>;
  /**
   * The target's CURRENT item index, or undefined while it has no row. Read
   * on every pass and never captured: the buffer can grow underneath a jump
   * (see the hook doc), and an index taken before that growth names a
   * different row after it.
   */
  indexOf: (id: string) => number | undefined;
  /** True while something else owns the viewport (a pagination restore). */
  blocked: () => boolean;
  /** Runs before every scroll the jump issues (the timeline disarms follow). */
  onJump: () => void;
  /** The target was verified in view — the caller may now drop `?m=`. */
  onSettled?: (id: string) => void;
  /** Any change re-runs a jump that has not settled yet (loadingOlder). */
  restartKey?: unknown;
}

/**
 * Scroll a virtualized list to a permalink target and CONFIRM it landed.
 *
 * The previous in-component effect resolved the target's item index once,
 * then applied it two animation frames (and 250ms) later. On an in-app
 * navigation into a channel whose buffer is only partly in memory, the
 * first render holds a short in-memory buffer that already contains the
 * target; the full cached history is prepended a frame later. The captured
 * index then named an OLD row — measured live on #general: the list was
 * driven to scrollTop 20984 of 170365 (Sep 22 messages) instead of ~148k,
 * and `?m=` was dropped 800ms later regardless. A full page load never hit
 * it because the buffer there arrives whole.
 *
 * So every pass re-resolves the index, re-jumps when it changed or the row
 * is not in view yet, and reports `onSettled` only once the row the list
 * was sent to is actually inside the viewport. After settling it keeps
 * re-anchoring on index shifts (a late prepend) but never re-jumps merely
 * because the row left the viewport — that is the reader scrolling.
 */
export function usePermalinkScroll(options: PermalinkScrollOptions): void {
  const latest = useRef(options);
  latest.current = options;
  /** The id already settled — a re-render must not jump to it again. */
  const settledRef = useRef<string | null>(null);
  const { targetId, restartKey } = options;
  // biome-ignore lint/correctness/useExhaustiveDependencies: restartKey is the deliberate re-run trigger
  useEffect(() => {
    if (!targetId) {
      // The permalink ended: a later jump to the same id is a new jump.
      settledRef.current = null;
      return;
    }
    if (settledRef.current === targetId || latest.current.blocked()) {
      return;
    }
    const startedAt = Date.now();
    let jumpedIndex: number | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pass = () => {
      timer = null;
      const current = latest.current;
      const list = current.listRef.current;
      const index = current.indexOf(targetId);
      const elapsed = Date.now() - startedAt;
      if (
        index !== undefined &&
        index === jumpedIndex &&
        list &&
        itemInView(list, index)
      ) {
        if (!settled) {
          settled = true;
          settledRef.current = targetId;
          current.onSettled?.(targetId);
        }
      } else if (index !== undefined && !(settled && index === jumpedIndex)) {
        if (elapsed > PERMALINK_SETTLE_MAX_MS) {
          return;
        }
        current.onJump();
        list?.scrollToIndex(index, { align: "center" });
        jumpedIndex = index;
      } else if (
        index === undefined &&
        jumpedIndex === null &&
        elapsed > PERMALINK_ROW_WAIT_MS
      ) {
        // The row never materialized — the target is not in this list.
        return;
      }
      if (elapsed <= PERMALINK_SETTLE_MAX_MS) {
        timer = setTimeout(pass, POLL_MS);
      }
    };
    timer = setTimeout(pass, 0);
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [targetId, restartKey]);
}

/** Does any part of item `index` overlap the list's viewport? */
function itemInView(list: VListHandle, index: number): boolean {
  const top = list.getItemOffset(index);
  const bottom = top + list.getItemSize(index);
  const viewTop = list.scrollOffset;
  return (
    list.viewportSize > 0 &&
    bottom > viewTop &&
    top < viewTop + list.viewportSize
  );
}
