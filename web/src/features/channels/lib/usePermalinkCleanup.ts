import { useEffect } from "react";
import type { useNavigate } from "@tanstack/react-router";

/**
 * Drop `?m=` from the URL once the permalink jump has had its effect.
 *
 * Two timers, extracted verbatim from `repos.tsx` (they pair with the shell's
 * permalinkJump derivation, which stays there — it needs the channel buffer):
 *
 * - 800ms AFTER the target row exists: the row has scrolled and flashed; a
 *   later arrival must not fight the auto-tail scroll, so `m` leaves the URL.
 * - 4s FALLBACK when the target never enters the buffer: a permalink to a
 *   message older than the fetch window will never load it — the URL would
 *   otherwise carry a dead `m` forever.
 */
export function usePermalinkCleanup(options: {
  permalinkMessageId: string | null | undefined;
  permalinkReady: boolean;
  selectedId: string | undefined;
  navigate: ReturnType<typeof useNavigate>;
}): void {
  const { permalinkMessageId, permalinkReady, selectedId, navigate } = options;
  useEffect(() => {
    if (!permalinkReady) {
      return;
    }
    const timer = window.setTimeout(() => {
      void navigate({
        to: "/repos",
        search: { c: selectedId },
        replace: true,
      });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [permalinkReady, navigate, selectedId]);
  useEffect(() => {
    if (permalinkMessageId == null || permalinkReady) {
      return;
    }
    const timer = window.setTimeout(() => {
      void navigate({
        to: "/repos",
        search: { c: selectedId },
        replace: true,
      });
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [permalinkMessageId, permalinkReady, navigate, selectedId]);
}
