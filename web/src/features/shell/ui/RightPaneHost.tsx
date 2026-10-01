import { Maximize2, Minimize2, X } from "lucide-react";
import type { ComponentProps, CSSProperties } from "react";
import { AgentActivityPanel } from "@/features/agents/ui/AgentActivityPanel";
import { channelCanvasListed } from "@/features/canvas/lib/channelCanvas.ts";
import { CanvasPane } from "@/features/canvas/ui/CanvasPane";
import { useChannelCanvas } from "@/features/canvas/useChannelCanvas.ts";
import { useFileTabs } from "@/features/shelf/FileTabsProvider";
import {
  CHANNEL_CANVAS_KEY,
  canvasItemKeys,
  clampFileWidth,
} from "@/features/shelf/lib/fileTabs.ts";
import { useDockedPane } from "@/features/shelf/useDockedPane.ts";
import { useWorkCounts } from "@/features/work/useWorkCounts.ts";
import { WorkRailCollapsed } from "@/features/work/ui/WorkRailCollapsed";
import { WorkTab } from "@/features/work/ui/WorkTab";
import {
  PANE_RESIZE_HANDLE_CLASSES,
  usePointerDrag,
} from "@/shared/layout/usePointerDrag.ts";
import { cn } from "@/shared/lib/cn";
import { StateHex } from "@/shared/ui/HexAvatar";
import {
  type PaneTabId,
  type RightPaneLayout,
  type RightTabId,
  rightPaneStrip,
} from "../rightPaneLayout.ts";

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

const TAB_LABEL: Record<PaneTabId, string> = {
  work: "Work",
  canvas: "Canvas",
  activity: "Thinking",
};

const TAB_CLASS =
  "flex h-7 shrink-0 items-center rounded-[7px] text-xs font-semibold transition-colors";
const TAB_ON = "bg-card text-foreground shadow-xs ring-1 ring-border";
const TAB_OFF = "text-muted-foreground hover:text-foreground";

/**
 * The shell row's right pane. At lg it is a docked column whose strip has
 * exactly two top-level tabs — **Work** and **Canvas** (Sam, 2026-09-30) —
 * plus the agent's Thinking pane in an agent DM. Work is the action feed,
 * unchanged. Canvas holds documents: the conversation's channel canvas
 * pinned first, then every file opened from chat or the Shelf, each a
 * closable sub-tab (CanvasPane). Opening a file puts Canvas on screen with
 * that file selected; Canvas has the file pane's own width and can expand
 * over the whole row. (Threads are not here: they open under their message.)
 *
 * Below lg there is no dock: the column is `display: contents`, Work is the
 * `?view=work` page, the thinking panel falls back to its full-screen sheet,
 * and a file is FileTabsProvider's full-screen sheet. The whole host is
 * `display: none` (still mounted) while a link page covers the row; beside
 * Files it is the Work strip.
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
  const files = useFileTabs();
  const docked = useDockedPane();
  const conversationId = layout.conversationCovered ? null : work.channelId;
  const canvasDoc = useChannelCanvas(
    docked && layout.hostVisible && files ? (conversationId ?? null) : null,
  );
  const chosen = files?.state.active ?? null;
  const items = canvasItemKeys(
    files?.state.files.map((file) => file.key) ?? [],
    conversationId != null &&
      channelCanvasListed(canvasDoc.phase, canvasDoc.doc, chosen),
  );
  const strip = rightPaneStrip(layout, {
    items,
    active: chosen,
    open: files?.state.open ?? false,
    docked,
  });
  // Outside FileTabsProvider (component tests) there is no Canvas to show.
  const tabs = files ? strip.tabs : strip.tabs.filter((t) => t !== "canvas");
  const canvasOn = files !== null && strip.active === "canvas";
  const expanded =
    canvasOn && strip.canvasItem !== null && (files?.state.expanded ?? false);
  const fileDrag = usePointerDrag({
    onDrag: (deltaX) =>
      files?.setWidth((width) => clampFileWidth(width - deltaX)),
  });
  const docks = layout.tabs.length > 0 || canvasOn;
  const selectTab = (tab: PaneTabId) => {
    if (tab === "canvas") {
      files?.show(true);
      return;
    }
    files?.show(false);
    onSelectTab(tab);
    if (tab === "work" && layout.work === "collapsed") {
      work.onExpand();
    }
  };

  return (
    <div
      className={layout.hostVisible ? "contents" : "hidden"}
      data-testid="right-pane-host"
      data-active-tab={strip.active ?? "none"}
    >
      {(layout.handle || canvasOn) && !expanded && (
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
          {...(canvasOn ? fileDrag : drag)}
        />
      )}
      <div
        data-testid="right-dock"
        data-expanded={expanded ? "true" : undefined}
        className={cn(
          "buzz-right-dock contents",
          docks &&
            // Sticky + self-start: on a long view page the ROW scrolls, and
            // the dock must stay in the viewport rather than ride the page.
            "lg:sticky lg:top-0 lg:flex lg:h-full lg:min-h-0 lg:w-[var(--dock-width)] lg:shrink-0 lg:flex-col lg:self-start lg:border-l lg:border-border",
          // Expand-to-full: the Canvas covers the conversation and the dock,
          // leaving the sidebar — fixed, so a scrolled view page cannot
          // carry it away.
          expanded &&
            "lg:fixed lg:inset-y-0 lg:right-0 lg:left-[var(--buzz-shell-sidebar-w,0px)] lg:z-40 lg:w-auto lg:bg-background",
        )}
        style={
          {
            "--dock-width": `${canvasOn && files ? files.width : dockWidth}px`,
            // The thinking panel sizes itself from --thread-width; inside the
            // dock that is simply "fill it".
            "--thread-width": "100%",
          } as CSSProperties
        }
      >
        {strip.visible && (
          <div
            role="tablist"
            aria-label="Side panel"
            data-testid="right-pane-tabs"
            className="hidden h-11 shrink-0 items-center gap-1 border-b border-border bg-rail px-2 lg:flex"
          >
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
              {tabs.map((tab) => {
                const selected = tab === strip.active;
                const close = tab === "activity" ? onCloseActivity : null;
                return (
                  <div
                    key={tab}
                    className={cn(TAB_CLASS, selected ? TAB_ON : TAB_OFF)}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      data-testid={`right-pane-tab-${tab}`}
                      onClick={() => selectTab(tab)}
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
                      {tab === "canvas" && items.length > 0 && (
                        <span
                          data-testid="canvas-count"
                          className="font-mono text-2xs font-medium text-muted-foreground"
                        >
                          {items.length}
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
            {canvasOn && strip.canvasItem !== null && files ? (
              <button
                type="button"
                data-testid="file-expand"
                aria-label={
                  expanded ? "Back beside the chat" : "Expand to full width"
                }
                aria-pressed={expanded}
                onClick={() => files.setExpanded(!expanded)}
                className="grid size-7.5 shrink-0 place-items-center rounded-[7px] text-ink-2 hover:bg-accent hover:text-foreground"
              >
                {expanded ? (
                  <Minimize2 aria-hidden className="size-3.75" />
                ) : (
                  <Maximize2 aria-hidden className="size-3.75" />
                )}
              </button>
            ) : null}
          </div>
        )}
        <div className="contents lg:flex lg:min-h-0 lg:flex-1">
          {canvasOn && files ? (
            <div className="hidden min-w-0 flex-1 lg:block">
              <CanvasPane
                items={items}
                selected={strip.canvasItem}
                files={files.state.files}
                channelCanvas={
                  conversationId != null && items.includes(CHANNEL_CANVAS_KEY)
                    ? { channelId: conversationId, doc: canvasDoc.doc }
                    : null
                }
                expanded={expanded}
                onSelect={files.select}
                onClose={(key) => files.close(key, items)}
                onOpenShelf={files.openShelf}
              />
            </div>
          ) : null}
          {layout.work === "open" && !canvasOn && (
            <div className="hidden min-w-0 flex-1 lg:block">
              <WorkTab
                variant="rail"
                channelId={conversationId}
                showTitle={!strip.visible}
                onCollapse={work.onCollapse}
                onOpenMessage={work.onOpenMessage}
                onOpenChannel={work.onOpenChannel}
                onOpenView={work.onOpenView}
              />
            </div>
          )}
          {layout.work === "collapsed" && !canvasOn && (
            <div className="hidden lg:block">
              <WorkRailCollapsed
                needs={counts.needs}
                running={counts.running}
                onExpand={work.onExpand}
                canvas={
                  files
                    ? { count: items.length, onOpen: () => files.show(true) }
                    : undefined
                }
              />
            </div>
          )}
          {layout.activity && activity && !canvasOn && (
            <AgentActivityPanel {...activity} {...activityChrome} />
          )}
        </div>
      </div>
    </div>
  );
}
