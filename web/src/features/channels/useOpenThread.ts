import { useCallback, useEffect, useRef, useState } from "react";
import { useThreadLayout } from "@/features/settings/lib/appearanceStore.ts";
import {
  retargetThread,
  threadAfterNavigation,
  threadPaneSource,
  type OpenThread,
} from "./lib/openThread.ts";

/** The lg breakpoint the thread pane docks at (ThreadPanel's lg: classes). */
const DOCK_QUERY = "(min-width: 1024px)";

function useWideViewport(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia(DOCK_QUERY).matches
      : true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(DOCK_QUERY);
    const onChange = () => setWide(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return wide;
}

/**
 * The right pane's open thread, kept across conversation and view switches
 * while the pane is docked (policy and rationale: lib/openThread.ts).
 */
export function useOpenThread(selectedId: string | undefined) {
  const [openThread, setOpenThread] = useState<OpenThread | null>(null);
  const layout = useThreadLayout();
  const wide = useWideViewport();
  const docked = wide && layout === "split";
  // Read at navigation time: the switch, not a later resize, decides.
  const dockedRef = useRef(docked);
  dockedRef.current = docked;

  useEffect(() => {
    setOpenThread((previous) =>
      threadAfterNavigation(previous, {
        selectedId,
        docked: dockedRef.current,
      }),
    );
  }, [selectedId]);

  // Stable identity (the route's permalink effect depends on it); the open
  // conversation is read when the setter is CALLED, not when it was made.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const setThreadRootId = useCallback((rootId: string | null) => {
    const channelId = selectedRef.current;
    setOpenThread((previous) => retargetThread(previous, rootId, channelId));
  }, []);

  return {
    openThread,
    threadRootId: openThread?.rootId ?? null,
    setThreadRootId,
    source: threadPaneSource(openThread, selectedId),
  };
}
