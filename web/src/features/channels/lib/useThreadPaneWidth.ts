import { useCallback, useEffect, useState } from "react";
import {
  THREAD_WIDTH_DEFAULT,
  THREAD_WIDTH_STORAGE_KEY,
  clampThreadWidth,
  parseStoredThreadWidth,
  portraitRailWidth,
} from "./threadPanelWidth.ts";

/**
 * The right pane's (thread / agent activity) drag-resizable width, plus the
 * viewport height, the derived portrait-rail width, and the row clamps.
 *
 * Extracted from repos.tsx for the file-size ratchet: the shell route was
 * at its 1000-line cap and this state machine is self-contained. The DRAG
 * handler stays with the caller (it owns the pointer events); everything
 * that reacts — mount, channel change, window resizes — clamps here.
 *
 * Width policy lives in `threadPanelWidth.ts`; the persisted key is
 * `buzz.thread-width.v1`. The ceiling is relative to the LAYOUT ROW (the
 * flex row holding timeline + drag handle + pane, i.e. the window minus the
 * app sidebar) so the pane can take nearly the whole row without starving
 * the timeline while the sidebar is open; a width persisted on a big window
 * re-clamps on a smaller one.
 */
export function useThreadPaneWidth(channelId: string, railVisible: boolean) {
  // The row element arrives via ref callback (not a ref object) so its
  // appearance is STATE: the observer effect below re-runs when the row
  // comes into existence, whatever the navigation path — cold first visit,
  // or landing on files/workflows/inbox and then opening a channel all
  // mount the row AFTER this hook. A plain ref would stay null-invisible
  // to the effect and the observer would never attach (QA 2026-09-14).
  const [rowEl, setRowEl] = useState<HTMLDivElement | null>(null);
  const shellRowWidth = useCallback(
    () => rowEl?.clientWidth ?? globalThis.innerWidth,
    [rowEl],
  );
  const [threadWidth, setThreadWidth] = useState<number>(() => {
    const stored = parseStoredThreadWidth(
      globalThis.localStorage?.getItem(THREAD_WIDTH_STORAGE_KEY) ?? null,
    );
    // `railVisible` is THIS render's DM-pane visibility, and it is real at
    // first render: the channel list seeds synchronously from localStorage
    // (useChannels), so a warm reload straight into a DM has the pane — and
    // the rail — up already. The initializer reserves exactly like every
    // other clamp site.
    return stored === null
      ? THREAD_WIDTH_DEFAULT
      : clampThreadWidth(
          stored,
          globalThis.innerWidth,
          railVisible ? portraitRailWidth(stored, globalThis.innerHeight) : 0,
        );
  });
  // Tracks the window height for `portraitRailWidth` (the rail's 3:4 frame
  // must fit the viewport); fed by the clamp below.
  const [viewportHeight, setViewportHeight] = useState(
    () => globalThis.innerHeight,
  );
  useEffect(() => {
    globalThis.localStorage?.setItem(
      THREAD_WIDTH_STORAGE_KEY,
      String(Math.round(threadWidth)),
    );
  }, [threadWidth]);
  // THE clamp: against the live row width; while the DM rail is up it
  // reserves the rail's own computed width for the candidate being clamped,
  // so the pane + rail pair cannot drag the channel column below its floor.
  // The same call keeps viewportHeight fresh for the rail math
  // (--portrait-rail-w).
  const clampToRow = useCallback(() => {
    setViewportHeight(globalThis.innerHeight);
    setThreadWidth((previous) =>
      clampThreadWidth(
        previous,
        shellRowWidth(),
        railVisible ? portraitRailWidth(previous, globalThis.innerHeight) : 0,
      ),
    );
  }, [railVisible, shellRowWidth]);
  // Clamp on mount, channel change (the row mounts per channel), and window
  // resizes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId is the re-run trigger (the row mounts per channel) — read nowhere in the effect
  useEffect(() => {
    clampToRow();
    globalThis.addEventListener("resize", clampToRow);
    return () => globalThis.removeEventListener("resize", clampToRow);
  }, [channelId, clampToRow]);
  // Re-clamp when the ROW itself resizes. The window listener cannot see
  // this: the app sidebar's width is AppShell local state (draggable
  // 232→480), and a sidebar drag shrinks the row without any window resize —
  // a wide pane would quietly starve the timeline. PRE-EXISTING breach (it
  // predates the portrait rail); the observer is here because this hook owns
  // the row. Same clamp, cheap and idempotent — no debounce. Keyed on the
  // row ELEMENT, not just the callback: the row mounts after this hook on
  // several real navigation paths, and the observer must attach whenever it
  // appears.
  useEffect(() => {
    if (!rowEl || typeof globalThis.ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(clampToRow);
    observer.observe(rowEl);
    return () => observer.disconnect();
  }, [clampToRow, rowEl]);
  return {
    setRowEl,
    shellRowWidth,
    threadWidth,
    setThreadWidth,
    viewportHeight,
  };
}
