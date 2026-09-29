import { useCallback, useEffect, useState } from "react";
import type { useNavigate } from "@tanstack/react-router";

/** Flash time left on the landed row before `?m=` (and its highlight) goes. */
export const PERMALINK_CLEAR_AFTER_SETTLE_MS = 800;
/** No settle within this long of the last progress → drop the dead `?m=`. */
export const PERMALINK_FALLBACK_MS = 4000;

/**
 * Drop `?m=` from the URL once the permalink jump has LANDED.
 *
 * Returns the `onSettled` callback the timeline (or, for a reply, the thread
 * panel) calls once the target row is verified in view — see
 * `usePermalinkScroll`. Clearing `m` ends the jump (the timeline's target
 * prop derives from it), so it must not happen earlier: it used to fire
 * 800ms after the target merely ENTERED the buffer, which cancelled — and
 * then masked — a jump that had been sent to a stale row.
 *
 * - 800ms AFTER the settle: the row has scrolled and flashed; `m` leaves the
 *   URL so later arrivals don't fight the auto-tail.
 * - 4s FALLBACK without a settle, restarted when the target enters the
 *   buffer: a permalink older than the fetch window never loads, and a jump
 *   that cannot land gives up — the URL must not carry a dead `m` forever.
 */
export function usePermalinkCleanup(options: {
  permalinkMessageId: string | null | undefined;
  permalinkReady: boolean;
  selectedId: string | undefined;
  navigate: ReturnType<typeof useNavigate>;
}): (id: string) => void {
  const { permalinkMessageId, permalinkReady, selectedId, navigate } = options;
  const [settledId, setSettledId] = useState<string | null>(null);
  const settled = settledId != null && settledId === permalinkMessageId;
  useEffect(() => {
    if (permalinkMessageId == null) {
      // A later permalink to the same id is a new jump, not already settled.
      setSettledId(null);
    }
  }, [permalinkMessageId]);
  const clear = useCallback(() => {
    void navigate({ to: "/repos", search: { c: selectedId }, replace: true });
  }, [navigate, selectedId]);
  useEffect(() => {
    if (!settled) {
      return;
    }
    const timer = window.setTimeout(clear, PERMALINK_CLEAR_AFTER_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [settled, clear]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: permalinkReady restarts the fallback window
  useEffect(() => {
    if (permalinkMessageId == null || settled) {
      return;
    }
    const timer = window.setTimeout(clear, PERMALINK_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [permalinkMessageId, permalinkReady, settled, clear]);
  return setSettledId;
}
