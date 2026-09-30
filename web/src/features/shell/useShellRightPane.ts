import type { CSSProperties } from "react";
import type { OpenThread } from "@/features/channels/lib/openThread.ts";
import { clampThreadWidth } from "@/features/channels/lib/threadPanelWidth.ts";
import { useThreadPaneWidth } from "@/features/channels/lib/useThreadPaneWidth.ts";
import { useDmRightPane } from "@/features/channels/useDmRightPane";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { usePointerDrag } from "@/shared/layout/usePointerDrag.ts";
import { type PaneSurface, rightPaneLayout } from "./rightPaneLayout.ts";
import type { RightPaneHostProps } from "./ui/RightPaneHost.tsx";

/**
 * The shell's right-pane state, lifted out of `routes/repos.tsx` (web
 * redesign Phase 0): the drag-resizable width, the agent-DM pane (thinking
 * sheet / desktop collapse / tab), and the kept-open thread from another
 * channel. The route keeps `useOpenThread` itself — its permalink effect
 * reads `threadRootId` before the pane is involved — and passes it in.
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
  /** Jump to a channel (the detached thread's "in #channel" link). */
  selectChannel: (channelId: string) => void;
}) {
  const { setThreadRootId } = options;
  // Pane width state machine (persist, clamps on mount / channel change /
  // window and row resizes). The row is the AppShell row now; the ref
  // callback attaches the observer whenever it mounts. Rail reservation
  // inactive here — no portrait rail on this surface.
  const { setRowEl, shellRowWidth, threadWidth, setThreadWidth } =
    useThreadPaneWidth(options.channelId, false);
  // Dragging the side panel's left edge rightward shrinks it (touch-safe).
  const drag = usePointerDrag({
    onDrag: (deltaX) =>
      setThreadWidth((previous) =>
        clampThreadWidth(previous - deltaX, shellRowWidth()),
      ),
  });
  // The DM right-pane state plus the two-way 🧠 and Replies toggles (policy
  // in features/channels/lib/dmPaneToggles.ts).
  const {
    thinkingOpen,
    setThinkingOpen,
    dmPaneHidden,
    setDmPaneHidden,
    rightTab,
    setRightTab,
    panes,
  } = useDmRightPane({
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
    rightTab,
    paneHidden: dmPaneHidden,
    webLayerActive: options.webLayerActive,
  });
  const rowStyle = {
    ["--thread-width" as string]: `${threadWidth}px`,
  } as CSSProperties;
  const hostProps: Omit<RightPaneHostProps, "conversation" | "activity"> = {
    layout,
    drag,
    detached,
    onCloseThread: () => setThreadRootId(null),
    activityChrome: {
      mobileOpen: thinkingOpen,
      onCloseMobile: () => setThinkingOpen(false),
      onCloseDesktop: () => setDmPaneHidden(true),
      onSelectThreadTab: threadOpen ? () => setRightTab("thread") : undefined,
    },
  };
  return {
    /** The composer action row's 🧠 + Replies controls. */
    panes,
    /** A timeline "reply" click: open that thread on the thread tab. */
    openThreadTab: (id: string) => {
      setThreadRootId(id);
      setRightTab("thread");
    },
    row: { ref: setRowEl, style: rowStyle },
    hostProps,
  };
}
