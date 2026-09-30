import type { ComponentProps } from "react";
import { AgentActivityPanel } from "@/features/agents/ui/AgentActivityPanel";
import { DetachedThreadPanel } from "@/features/channels/ui/DetachedThreadPanel";
import { ThreadPanel } from "@/features/channels/ui/ThreadPanel";
import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import {
  PANE_RESIZE_HANDLE_CLASSES,
  type usePointerDrag,
} from "@/shared/layout/usePointerDrag.ts";
import type { RightPaneLayout } from "../rightPaneLayout.ts";

type ThreadProps = ComponentProps<typeof ThreadPanel>;
type ActivityProps = ComponentProps<typeof AgentActivityPanel>;

export interface RightPaneHostProps {
  layout: RightPaneLayout;
  /** Pointer handlers for the resize handle (usePointerDrag). */
  drag: ReturnType<typeof usePointerDrag>;
  /** The kept-open thread from another channel, when there is one. */
  detached: {
    channel: ChannelSummary;
    rootId: string;
    onOpenChannel: () => void;
  } | null;
  onCloseThread: () => void;
  /** The open channel's thread and the props its panel reads. */
  conversation: {
    root: TimelineMessage | null;
    buffer: ThreadProps["buffer"];
    members: ThreadProps["members"];
    profiles: ThreadProps["profiles"];
    agentPubkeys: ReadonlySet<string>;
    strictMentions: boolean;
    selfPubkey: string | null;
    permalinkMessageId: string | null;
    onPermalinkSettled: ThreadProps["onPermalinkSettled"];
    send: ThreadProps["send"];
  };
  /** The agent-DM thinking pane's data; null outside an agent DM. */
  activity: Pick<
    ActivityProps,
    | "agentPubkey"
    | "agentName"
    | "profile"
    | "frames"
    | "lockedCount"
    | "connected"
    | "working"
  > | null;
  /** The thinking pane's sheet / collapse / tab controls (useShellRightPane). */
  activityChrome: Pick<
    ActivityProps,
    "mobileOpen" | "onCloseMobile" | "onCloseDesktop" | "onSelectThreadTab"
  >;
}

/**
 * The shell row's right pane: resize handle, docked thread, kept-open thread,
 * phone-only thread overlay and the agent's thinking pane, in that DOM order.
 * Which of them render is `rightPaneLayout()`; the panels own their own dock
 * and overlay chrome. The wrapper is `display: contents` so the panes stay
 * flex children of the AppShell row, and `display: none` (still mounted, so a
 * thread draft survives) while the web layer covers the row.
 */
export function RightPaneHost({
  layout,
  drag,
  detached,
  onCloseThread,
  conversation,
  activity,
  activityChrome,
}: RightPaneHostProps) {
  const { root } = conversation;
  return (
    <div
      className={layout.hostVisible ? "contents" : "hidden"}
      data-testid="right-pane-host"
    >
      {layout.handle && (
        // biome-ignore lint/a11y/useFocusableInteractive: pointer-only resize handle; keyboard resize is not implemented
        // biome-ignore lint/a11y/useSemanticElements: pointer-only resize handle; keyboard resize is not implemented
        <div
          aria-label="Resize side panel"
          // biome-ignore lint/a11y/useAriaPropsForRole: drag handle is not a value slider; aria-valuenow would be meaningless
          role="separator"
          aria-orientation="vertical"
          // No border of its own: the pane's border-l is the one divider (a
          // second 1px border read as "two scrollbars and a sliver").
          className={`buzz-side-panel-resize-handle relative z-10 hidden w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-white/15 active:bg-white/25 lg:block lg:-ml-px ${PANE_RESIZE_HANDLE_CLASSES}`}
          {...drag}
        />
      )}
      {layout.threadDocked && root && (
        <ThreadPanel
          root={root}
          buffer={conversation.buffer}
          members={conversation.members}
          profiles={conversation.profiles}
          agentPubkeys={conversation.agentPubkeys}
          strictMentions={conversation.strictMentions}
          selfPubkey={conversation.selfPubkey}
          permalinkMessageId={conversation.permalinkMessageId}
          onPermalinkSettled={conversation.onPermalinkSettled}
          onClose={onCloseThread}
          send={conversation.send}
        />
      )}
      {layout.detached && detached && (
        <DetachedThreadPanel
          channel={detached.channel}
          rootId={detached.rootId}
          selfPubkey={conversation.selfPubkey}
          agentPubkeys={conversation.agentPubkeys}
          onClose={onCloseThread}
          onOpenChannel={detached.onOpenChannel}
        />
      )}
      {layout.threadMobileOnly && root && (
        <ThreadPanel
          root={root}
          buffer={conversation.buffer}
          members={conversation.members}
          profiles={conversation.profiles}
          agentPubkeys={conversation.agentPubkeys}
          strictMentions={conversation.strictMentions}
          selfPubkey={conversation.selfPubkey}
          onClose={onCloseThread}
          send={conversation.send}
          mobileOnly
        />
      )}
      {layout.activity && activity && (
        <AgentActivityPanel {...activity} {...activityChrome} />
      )}
    </div>
  );
}
