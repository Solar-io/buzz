import { type CSSProperties, useEffect, useState } from "react";
import type { OpenThread } from "@/features/channels/lib/openThread.ts";
import { clampThreadWidth } from "@/features/channels/lib/threadPanelWidth.ts";
import { useThreadPaneWidth } from "@/features/channels/lib/useThreadPaneWidth.ts";
import { useDmRightPane } from "@/features/channels/useDmRightPane";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { useThreadLayout } from "@/features/settings/lib/appearanceStore.ts";
import {
  clampWorkWidth,
  loadRailCollapsed,
  loadWorkWidth,
  saveRailCollapsed,
  saveWorkWidth,
  WORK_RAIL_COLLAPSED_WIDTH,
} from "@/features/work/lib/workPrefs.ts";
import { usePointerDrag } from "@/shared/layout/usePointerDrag.ts";
import { type PaneSurface, rightPaneLayout } from "./rightPaneLayout.ts";
import type { RightPaneHostProps } from "./ui/RightPaneHost.tsx";

/**
 * The shell's right-pane state (web redesign phase-1 §3): which tab is on
 * screen (Work | Thread | Thinking), the two widths (the Work rail's own
 * 380, and the thread/thinking pane's shared drag-resizable width — decision
 * D1), the rail's fold, and the kept-open thread from another channel. The
 * route keeps `useOpenThread` itself — its permalink effect reads
 * `threadRootId` before the pane is involved — and passes it in.
 */
export function useShellRightPane(options: {
  surface: PaneSurface;
  /** The open conversation's id ("" for none) — the width clamp's trigger. */
  channelId: string;
  /** `?c=` as routed — the DM pane forgets a remembered root when it moves. */
  selectedId: string | undefined;
  channels: ChannelSummary[];
  openThread: OpenThread | null;
  source: "none" | "current" | "other";
  threadRootId: string | null;
  setThreadRootId: (id: string | null) => void;
  /** A thread in the OPEN channel resolved to a root message. */
  threadRootResolved: boolean;
  dmAgentPubkey: string | null;
  selfPubkey: string | null;
  webLayerActive: boolean;
  /** `?view=work`: Work is the page, so it is not also a rail. */
  workIsPage: boolean;
  /** Jump to a channel (the detached thread's "in #channel" link). */
  selectChannel: (channelId: string) => void;
}) {
  const { setThreadRootId } = options;
  // Thread / thinking width state machine (persist, clamps on mount /
  // channel change / window and row resizes). The row is the AppShell row;
  // the ref callback attaches the observer whenever it mounts.
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
  const pane = useDmRightPane({
    agentDm: options.dmAgentPubkey !== null,
    channelId: options.selectedId,
    threadRootId: options.threadRootId,
    setThreadRootId,
    ownerPubkey: options.selfPubkey,
  });
  const { openThread } = options;
  const threadChannel =
    options.source === "other" && openThread
      ? options.channels.find((c) => c.id === openThread.channelId)
      : undefined;
  const detached =
    openThread && threadChannel
      ? {
          channel: threadChannel,
          rootId: openThread.rootId,
          onOpenChannel: () => options.selectChannel(threadChannel.id),
        }
      : null;
  const threadOpen = options.threadRootResolved || detached !== null;
  const layout = rightPaneLayout({
    surface: options.surface,
    threadRoot: options.threadRootResolved,
    detached: detached !== null,
    agentDm: options.dmAgentPubkey !== null,
    active: pane.active,
    previous: pane.previous,
    paneHidden: pane.dmPaneHidden,
    webLayerActive: options.webLayerActive,
    workTab: !options.workIsPage,
    threadIsTab: useThreadLayout() === "split",
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
  useEffect(() => saveWorkWidth(workWidth), [workWidth]);
  const rowStyle = {
    ["--thread-width" as string]: `${threadWidth}px`,
  } as CSSProperties;
  const hostProps: Omit<
    RightPaneHostProps,
    "conversation" | "activity" | "work"
  > = {
    layout,
    drag,
    dockWidth:
      layout.work === "collapsed"
        ? WORK_RAIL_COLLAPSED_WIDTH
        : onWork
          ? workWidth
          : threadWidth,
    detached,
    onSelectTab: pane.selectTab,
    onCloseThread: pane.closeThread,
    onCloseActivity: pane.closeThinking,
    activityChrome: {
      mobileOpen: pane.thinkingOpen,
      onCloseMobile: () => pane.setThinkingOpen(false),
      onCloseDesktop: pane.closeThinking,
      onSelectThreadTab: threadOpen
        ? () => pane.selectTab("thread")
        : undefined,
    },
  };
  return {
    /** The composer action row's 🧠 + Replies controls. */
    panes: pane.panes,
    /** A timeline "reply" click: open that thread on the thread tab. */
    openThreadTab: pane.openThreadTab,
    row: { ref: setRowEl, style: rowStyle },
    hostProps,
    /** The Work rail's fold, for the host's `work` prop. */
    workFold: {
      onCollapse: () => setWorkCollapsed(true),
      onExpand: () => setWorkCollapsed(false),
    },
  };
}
