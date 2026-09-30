import { X } from "lucide-react";
import type { ComponentProps, CSSProperties } from "react";
import { AgentActivityPanel } from "@/features/agents/ui/AgentActivityPanel";
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

type ActivityProps = ComponentProps<typeof AgentActivityPanel>;
type WorkProps = ComponentProps<typeof WorkTab>;

export interface RightPaneHostProps {
  layout: RightPaneLayout;
  /** Pointer handlers for the resize handle (usePointerDrag). */
  drag: ReturnType<typeof usePointerDrag>;
  /** The docked column's width at lg, for the active tab. */
  dockWidth: number;
  onSelectTab: (tab: RightTabId) => void;
  onCloseActivity: () => void;
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
  /** The thinking pane's sheet / collapse controls (useShellRightPane). */
  activityChrome: Pick<
    ActivityProps,
    "mobileOpen" | "onCloseMobile" | "onCloseDesktop"
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
  activity: "Thinking",
};

/**
 * The shell row's right pane: at lg a docked column with a tab strip — Work
 * always first, then the agent's Thinking pane in an agent DM. A strip of
 * one is just the Work rail and its title. (Threads are not here: they open
 * in place under their message — web redesign Phase 2.)
 *
 * Below lg there is no dock: the column is `display: contents`, Work is the
 * `?view=work` page, and the thinking panel falls back to the full-screen
 * sheet it already owns. The whole host is `display: none` (still mounted)
 * while the web layer covers the row.
 */
export function RightPaneHost({
  layout,
  drag,
  dockWidth,
  onSelectTab,
  onCloseActivity,
  activity,
  activityChrome,
  work,
}: RightPaneHostProps) {
  const counts = useWorkCounts();
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
            // Sticky + self-start: on a long view page the ROW scrolls, and
            // the dock must stay in the viewport rather than ride the page.
            "lg:sticky lg:top-0 lg:flex lg:h-full lg:min-h-0 lg:w-[var(--dock-width)] lg:shrink-0 lg:flex-col lg:self-start lg:border-l lg:border-border",
        )}
        style={
          {
            "--dock-width": `${dockWidth}px`,
            // The thinking panel sizes itself from --thread-width; inside the
            // dock that is simply "fill it".
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
              const close = tab === "activity" ? onCloseActivity : null;
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
          {layout.activity && activity && (
            <AgentActivityPanel {...activity} {...activityChrome} />
          )}
        </div>
      </div>
    </div>
  );
}
