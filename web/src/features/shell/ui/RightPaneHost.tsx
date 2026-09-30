import { X } from "lucide-react";
import type { ComponentProps, CSSProperties } from "react";
import { AgentActivityPanel } from "@/features/agents/ui/AgentActivityPanel";
import { DetachedThreadPanel } from "@/features/channels/ui/DetachedThreadPanel";
import { ThreadPanel } from "@/features/channels/ui/ThreadPanel";
import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { useWorkCounts } from "@/features/work/useWorkCounts.ts";
import { WorkRailCollapsed } from "@/features/work/ui/WorkRailCollapsed";
import { WorkTab } from "@/features/work/ui/WorkTab";
import {
  PANE_RESIZE_HANDLE_CLASSES,
  type usePointerDrag,
} from "@/shared/layout/usePointerDrag.ts";
import { cn } from "@/shared/lib/cn";
import { StateHex } from "@/shared/ui/HexAvatar";
import type { RightPaneLayout, RightTabId } from "../rightPaneLayout.ts";

type ThreadProps = ComponentProps<typeof ThreadPanel>;
type ActivityProps = ComponentProps<typeof AgentActivityPanel>;
type WorkProps = ComponentProps<typeof WorkTab>;

export interface RightPaneHostProps {
  layout: RightPaneLayout;
  /** Pointer handlers for the resize handle (usePointerDrag). */
  drag: ReturnType<typeof usePointerDrag>;
  /** The docked column's width at lg, for the active tab. */
  dockWidth: number;
  /** The kept-open thread from another channel, when there is one. */
  detached: {
    channel: ChannelSummary;
    rootId: string;
    onOpenChannel: () => void;
  } | null;
  onSelectTab: (tab: RightTabId) => void;
  onCloseThread: () => void;
  onCloseActivity: () => void;
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
  /** The Work tab's inputs and the rail's fold. */
  work: Pick<
    WorkProps,
    "channelId" | "onOpenMessage" | "onOpenChannel" | "onOpenView"
  > & {
    onCollapse: () => void;
    onExpand: () => void;
  };
}

const TAB_LABEL: Record<RightTabId, string> = {
  work: "Work",
  thread: "Thread",
  activity: "Thinking",
};

/**
 * The shell row's right pane (phase-1 §3): at lg a docked column with a tab
 * strip — Work always first, then the open thread and the agent's thinking
 * pane while they exist. A strip of one is just the Work rail and its title.
 *
 * Below lg there is no dock: the column is `display: contents`, Work is the
 * `?view=work` page, and the thread and thinking panels fall back to the
 * full-screen sheets they already own. The panels stay MOUNTED while another
 * tab is on screen (lg-hidden), so a thread draft survives a tab switch; the
 * whole host is `display: none` (still mounted) while the web layer covers
 * the row.
 */
export function RightPaneHost({
  layout,
  drag,
  dockWidth,
  detached,
  onSelectTab,
  onCloseThread,
  onCloseActivity,
  conversation,
  activity,
  activityChrome,
  work,
}: RightPaneHostProps) {
  const { root } = conversation;
  const counts = useWorkCounts();
  const threadWrap =
    layout.threadDocked || layout.threadFocus
      ? "contents"
      : "contents lg:hidden";
  return (
    <div
      className={layout.hostVisible ? "contents" : "hidden"}
      data-testid="right-pane-host"
      data-active-tab={layout.active ?? "none"}
    >
      {layout.handle && (
        // biome-ignore lint/a11y/useFocusableInteractive: pointer-only resize handle; keyboard resize is not implemented
        // biome-ignore lint/a11y/useSemanticElements: pointer-only resize handle; keyboard resize is not implemented
        <div
          aria-label="Resize side panel"
          // biome-ignore lint/a11y/useAriaPropsForRole: drag handle is not a value slider; aria-valuenow would be meaningless
          role="separator"
          aria-orientation="vertical"
          // No border of its own: the dock's border-l is the one divider (a
          // second 1px border read as "two scrollbars and a sliver").
          className={`buzz-side-panel-resize-handle relative z-10 hidden w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-foreground/10 active:bg-foreground/20 lg:block lg:-ml-px ${PANE_RESIZE_HANDLE_CLASSES}`}
          {...drag}
        />
      )}
      <div
        className={cn(
          "buzz-right-dock contents",
          layout.tabs.length > 0 &&
            "lg:flex lg:min-h-0 lg:w-[var(--dock-width)] lg:shrink-0 lg:flex-col lg:border-l lg:border-border",
        )}
        style={
          {
            "--dock-width": `${dockWidth}px`,
            // The thread and thinking panels size themselves from
            // --thread-width; inside the dock that is simply "fill it".
            "--thread-width": "100%",
          } as CSSProperties
        }
      >
        {layout.tabs.length >= 2 && layout.work !== "collapsed" && (
          <div
            role="tablist"
            aria-label="Side panel"
            data-testid="right-pane-tabs"
            className="hidden h-11 shrink-0 items-center gap-1 border-b border-border bg-rail px-2 lg:flex"
          >
            {layout.tabs.map((tab) => {
              const selected = tab === layout.active;
              const close =
                tab === "thread"
                  ? onCloseThread
                  : tab === "activity"
                    ? onCloseActivity
                    : null;
              return (
                <div
                  key={tab}
                  className={cn(
                    "flex h-7 items-center rounded-[7px] text-xs font-semibold transition-colors",
                    selected
                      ? "bg-card text-foreground shadow-xs ring-1 ring-border"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => onSelectTab(tab)}
                    className={cn(
                      "flex h-full items-center gap-1.5 pl-2.5",
                      close ? "pr-1" : "pr-2.5",
                    )}
                  >
                    {TAB_LABEL[tab]}
                    {tab === "work" && counts.needs > 0 && (
                      <span className="flex items-center gap-1 font-mono text-2xs text-coral-ink">
                        <StateHex tone="need" size={8} />
                        {counts.needs}
                      </span>
                    )}
                  </button>
                  {close && (
                    <button
                      type="button"
                      aria-label={`Close ${TAB_LABEL[tab]}`}
                      onClick={close}
                      className="mr-1 grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <X aria-hidden className="size-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="contents lg:flex lg:min-h-0 lg:flex-1">
          {layout.work === "open" && (
            <div className="hidden min-w-0 flex-1 lg:block">
              <WorkTab
                variant="rail"
                channelId={work.channelId}
                showTitle={layout.tabs.length < 2}
                onCollapse={work.onCollapse}
                onOpenMessage={work.onOpenMessage}
                onOpenChannel={work.onOpenChannel}
                onOpenView={work.onOpenView}
              />
            </div>
          )}
          {layout.work === "collapsed" && (
            <div className="hidden lg:block">
              <WorkRailCollapsed
                needs={counts.needs}
                running={counts.running}
                onExpand={work.onExpand}
              />
            </div>
          )}
          {layout.thread && root && (
            <div className={threadWrap}>
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
            </div>
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
          {layout.activity && activity && (
            <AgentActivityPanel {...activity} {...activityChrome} />
          )}
        </div>
      </div>
    </div>
  );
}
