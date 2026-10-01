import { type CSSProperties, useEffect, useState } from "react";
import { clampThreadWidth } from "@/features/channels/lib/threadPanelWidth.ts";
import { useThreadPaneWidth } from "@/features/channels/lib/useThreadPaneWidth.ts";
import { useDmRightPane } from "@/features/channels/useDmRightPane";
import {
  clampWorkWidth,
  loadRailCollapsed,
  loadWorkWidth,
  saveRailCollapsed,
  saveWorkWidth,
  WORK_RAIL_COLLAPSED_WIDTH,
} from "@/features/work/lib/workPrefs.ts";
import { usePointerDrag } from "@/shared/layout/usePointerDrag.ts";
import {
  type PaneSurface,
  rightPaneLayout,
  type WebLayerMode,
} from "./rightPaneLayout.ts";
import type { RightPaneHostProps } from "./ui/RightPaneHost.tsx";

/**
 * The shell's right-pane state: which tab is on screen (Work | Thinking),
 * the two widths (the Work rail's own 380, and the thinking pane's
 * drag-resizable width — decision D1) and the rail's fold.
 *
 * Threads left this hook in Phase 2: they open inline under their message,
 * so there is no thread tab, no kept-open thread and no thread width.
 */
export function useShellRightPane(options: {
  surface: PaneSurface;
  /** The open conversation's id ("" for none) — the width clamp's trigger. */
  channelId: string;
  /** `?c=` as routed — entering an agent DM selects Thinking. */
  selectedId: string | undefined;
  dmAgentPubkey: string | null;
  selfPubkey: string | null;
  /** `webLayerMode(web.state)`: Files keeps the Work strip beside it. */
  webLayer: WebLayerMode;
  /** `?view=work`: Work is the page, so it is not also a rail. */
  workIsPage: boolean;
}) {
  // Thinking-pane width state machine (persist, clamps on mount / channel
  // change / window and row resizes). The row is the AppShell row; the ref
  // callback attaches the observer whenever it mounts.
  const { setRowEl, shellRowWidth, threadWidth, setThreadWidth } =
    useThreadPaneWidth(options.channelId, false);
  const [workWidth, setWorkWidth] = useState(() => loadWorkWidth());
  const [workCollapsed, setWorkCollapsedState] = useState(() =>
    loadRailCollapsed(),
  );
  const setWorkCollapsed = (collapsed: boolean) => {
    saveRailCollapsed(collapsed);
    setWorkCollapsedState(collapsed);
  };
  // Beside Files, Work opens folded every time; unfolding it there is a
  // per-visit choice that never rewrites the conversation preference.
  const files = options.webLayer === "files";
  const [filesWorkOpen, setFilesWorkOpen] = useState(false);
  useEffect(() => {
    if (!files) {
      setFilesWorkOpen(false);
    }
  }, [files]);
  const pane = useDmRightPane({
    agentDm: options.dmAgentPubkey !== null,
    channelId: options.selectedId,
    ownerPubkey: options.selfPubkey,
  });
  const layout = rightPaneLayout({
    surface: options.surface,
    agentDm: options.dmAgentPubkey !== null,
    active: pane.active,
    previous: pane.previous,
    paneHidden: pane.dmPaneHidden,
    webLayer: options.webLayer,
    filesWorkOpen,
    workTab: !options.workIsPage,
    workCollapsed,
  });
  const onWork = layout.active === "work";
  // Dragging the dock's left edge rightward shrinks it (touch-safe). The
  // handle sizes whichever tab is on screen.
  const drag = usePointerDrag({
    onDrag: (deltaX) => {
      if (onWork) {
        setWorkWidth((previous) => clampWorkWidth(previous - deltaX));
      } else {
        setThreadWidth((previous) =>
          clampThreadWidth(previous - deltaX, shellRowWidth()),
        );
      }
    },
  });
  // Canvas shares Work's width (Sam, 2026-10-01): its handle always resizes it.
  const workDrag = usePointerDrag({
    onDrag: (deltaX) =>
      setWorkWidth((previous) => clampWorkWidth(previous - deltaX)),
  });
  useEffect(() => saveWorkWidth(workWidth), [workWidth]);
  const rowStyle = {
    ["--thread-width" as string]: `${threadWidth}px`,
  } as CSSProperties;
  const hostProps: Omit<RightPaneHostProps, "activity" | "work"> = {
    layout,
    drag,
    dockWidth:
      layout.work === "collapsed"
        ? WORK_RAIL_COLLAPSED_WIDTH
        : onWork
          ? workWidth
          : threadWidth,
    workWidth,
    workDrag,
    onSelectTab: pane.selectTab,
    onCloseActivity: pane.closeThinking,
    activityChrome: {
      mobileOpen: pane.thinkingOpen,
      onCloseMobile: () => pane.setThinkingOpen(false),
      onCloseDesktop: pane.closeThinking,
    },
  };
  return {
    /** The composer action row's 🧠 control. */
    panes: pane.panes,
    row: { ref: setRowEl, style: rowStyle },
    hostProps,
    /** The Work rail's fold, for the host's `work` prop. */
    workFold: {
      onCollapse: () =>
        files ? setFilesWorkOpen(false) : setWorkCollapsed(true),
      onExpand: () =>
        files ? setFilesWorkOpen(true) : setWorkCollapsed(false),
    },
    /** `/status`: bring the Work rail up (unfold it, select its tab). */
    showWork: () => {
      if (files) {
        setFilesWorkOpen(true);
        return;
      }
      setWorkCollapsed(false);
      pane.selectTab("work");
    },
  };
}
