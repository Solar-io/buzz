import { Maximize2, Minimize2, X } from "lucide-react";
import type { ComponentProps, CSSProperties } from "react";
import { AgentActivityPanel } from "@/features/agents/ui/AgentActivityPanel";
import { useFileTabs } from "@/features/shelf/FileTabsProvider";
import { clampFileWidth } from "@/features/shelf/lib/fileTabs.ts";
import { FilePreview } from "@/features/shelf/ui/FilePreview";
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

const TAB_LABEL: Record<RightTabId, string> = {
  work: "Work",
  activity: "Thinking",
};

const TAB_CLASS =
  "flex h-7 shrink-0 items-center rounded-[7px] text-xs font-semibold transition-colors";
const TAB_ON = "bg-card text-foreground shadow-xs ring-1 ring-border";
const TAB_OFF = "text-muted-foreground hover:text-foreground";

/**
 * The shell row's right pane: at lg a docked column with a tab strip — Work
 * always first, then the agent's Thinking pane in an agent DM, then any open
 * FILES (web redesign Phase 6). A strip of one is just the Work rail and its
 * title. (Threads are not here: they open in place under their message.)
 *
 * A file tab sits over the shell's tabs: while it is active the pane is its
 * preview, at the file pane's own width, and it can expand over the whole
 * row; picking Work or Thinking hands the pane back.
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
  const strip = rightPaneStrip(
    layout,
    files?.state.files.map((file) => file.key) ?? [],
    docked ? (files?.state.active ?? null) : null,
  );
  const activeFile =
    strip.activeFile === null
      ? null
      : (files?.state.files.find((file) => file.key === strip.activeFile) ??
        null);
  const expanded = activeFile !== null && (files?.state.expanded ?? false);
  const fileDrag = usePointerDrag({
    onDrag: (deltaX) =>
      files?.setWidth((width) => clampFileWidth(width - deltaX)),
  });
  const docks = layout.tabs.length > 0 || activeFile !== null;
  const selectShellTab = (tab: RightTabId) => {
    files?.select(null);
    onSelectTab(tab);
    if (tab === "work" && layout.work === "collapsed") {
      work.onExpand();
    }
  };

  return (
    <div
      className={layout.hostVisible ? "contents" : "hidden"}
      data-testid="right-pane-host"
      data-active-tab={activeFile ? "file" : (layout.active ?? "none")}
    >
      {(layout.handle || activeFile !== null) && !expanded && (
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
          {...(activeFile ? fileDrag : drag)}
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
          // Expand-to-full: the file covers the conversation and the dock,
          // leaving the sidebar — fixed, so a scrolled view page cannot
          // carry it away.
          expanded &&
            "lg:fixed lg:inset-y-0 lg:right-0 lg:left-[var(--buzz-shell-sidebar-w,0px)] lg:z-40 lg:w-auto lg:bg-background",
        )}
        style={
          {
            "--dock-width": `${activeFile && files ? files.width : dockWidth}px`,
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
              {layout.tabs.map((tab) => {
                const selected = tab === layout.active && activeFile === null;
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
                      onClick={() => selectShellTab(tab)}
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
              {files?.state.files.map((file) => {
                const selected = file.key === activeFile?.key;
                return (
                  <div
                    key={file.key}
                    data-testid="file-tab"
                    className={cn(
                      TAB_CLASS,
                      "group/tab max-w-52",
                      selected ? TAB_ON : TAB_OFF,
                    )}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      title={file.filename}
                      onClick={() => files.select(file.key)}
                      className="flex h-full min-w-0 items-center pr-1 pl-2.5 font-mono"
                    >
                      <span className="truncate">{file.filename}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${file.filename}`}
                      onClick={() => files.close(file.key)}
                      className={cn(
                        "mr-1 grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:opacity-100",
                        selected
                          ? "opacity-100"
                          : "opacity-0 group-hover/tab:opacity-100",
                      )}
                    >
                      <X aria-hidden className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
            {activeFile && files ? (
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
          {activeFile ? (
            <div className="hidden min-w-0 flex-1 lg:block">
              <FilePreview
                key={activeFile.key}
                file={activeFile}
                variant={expanded ? "expanded" : "dock"}
              />
            </div>
          ) : null}
          {layout.work === "open" && activeFile === null && (
            <div className="hidden min-w-0 flex-1 lg:block">
              <WorkTab
                variant="rail"
                channelId={layout.conversationCovered ? null : work.channelId}
                showTitle={!strip.visible}
                onCollapse={work.onCollapse}
                onOpenMessage={work.onOpenMessage}
                onOpenChannel={work.onOpenChannel}
                onOpenView={work.onOpenView}
              />
            </div>
          )}
          {layout.work === "collapsed" && activeFile === null && (
            <div className="hidden lg:block">
              <WorkRailCollapsed
                needs={counts.needs}
                running={counts.running}
                onExpand={work.onExpand}
              />
            </div>
          )}
          {layout.activity && activity && activeFile === null && (
            <AgentActivityPanel {...activity} {...activityChrome} />
          )}
        </div>
      </div>
    </div>
  );
}
