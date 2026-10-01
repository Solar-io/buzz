/**
 * The shell's right pane as a pure function of the route's state.
 *
 * Phase 1 (phase-1.md §3) made the pane a TAB STRIP with Work always first.
 * Phase 2 took the thread out of it: a thread now opens in place, under its
 * message (features/channels/ui/InlineThread), so the strip is Work and —
 * in an agent DM — the agent's Thinking pane. A thread is never a tab.
 *
 * At `lg` the host is a docked column; below it there is no dock — the
 * thinking pane keeps its own full-screen sheet, and Work is the
 * `?view=work` page.
 *
 * Phase 4: Files is a page in the MAIN column (Files artboard), not a cover
 * over the row, so while it shows the dock stays — as the folded Work strip,
 * which the viewer may unfold beside Files. A link page still covers the
 * whole row and hides the pane.
 */

/** What the web layer is showing: nothing, a link over the row, or Files. */
export type WebLayerMode = "none" | "page" | "files";

/** Which surface the shell row is showing. */
export type PaneSurface = "conversation" | "view" | "none";

/** The right pane's tabs, in strip order. */
export type RightTabId = "work" | "activity";

export interface RightPaneInput {
  surface: PaneSurface;
  /** The open conversation is a 1:1 DM with a known agent. */
  agentDm: boolean;
  /** The tab the viewer last chose… */
  active: RightTabId;
  /** …and the one before it (closing a tab returns here). */
  previous: RightTabId;
  /** The agent-DM thinking pane was closed. */
  paneHidden: boolean;
  /** The web layer: a link page hides the pane; Files keeps the Work strip. */
  webLayer: WebLayerMode;
  /** The viewer unfolded Work beside Files (Files only; not persisted). */
  filesWorkOpen: boolean;
  /** Work is a tab (false on `?view=work`, where it is the page itself). */
  workTab: boolean;
  /** The Work rail is folded to its 48 px strip. */
  workCollapsed: boolean;
}

export interface RightPaneLayout {
  /** False: the host renders `display:none` but stays mounted. */
  hostVisible: boolean;
  /** The strip, Work first. A strip of one renders as a plain title. */
  tabs: RightTabId[];
  /** The tab on screen at lg — `active` if it still exists, else a fallback. */
  active: RightTabId | null;
  /** The drag-resize handle (lg), whenever something is docked open. */
  handle: boolean;
  /** Work at lg: open, folded to the strip, or not shown. */
  work: "open" | "collapsed" | null;
  /** Mount the agent's thinking pane (it is the active tab). */
  activity: boolean;
  /**
   * Files covers the conversation: Work's "This channel" has no channel to
   * mean, so it reads as Everywhere (as it does on view pages).
   */
  conversationCovered: boolean;
}

/**
 * The tab on screen: the chosen one while it exists, else the one before it,
 * else the first tab (Work).
 */
export function resolveActiveTab(
  active: RightTabId,
  previous: RightTabId,
  tabs: readonly RightTabId[],
): RightTabId | null {
  if (tabs.includes(active)) {
    return active;
  }
  if (tabs.includes(previous)) {
    return previous;
  }
  return tabs[0] ?? null;
}

/** Work is always first; Thinking joins in an agent DM while it is open. */
export function rightPaneTabs(input: RightPaneInput): RightTabId[] {
  const tabs: RightTabId[] = [];
  if (input.workTab) {
    tabs.push("work");
  }
  // Files covers the conversation, so its Thinking pane is not a tab.
  if (input.webLayer === "files") {
    return tabs;
  }
  if (input.surface === "conversation" && input.agentDm && !input.paneHidden) {
    tabs.push("activity");
  }
  return tabs;
}

/**
 * The strip with the open FILES in it (web redesign Phase 6). File tabs come
 * after the shell's tabs and sit over them: a file that is active is what the
 * pane shows; none active hands it back to `layout.active`.
 */
export interface RightPaneStrip {
  /** The open files' keys, in tab order ([] while the host is hidden). */
  files: string[];
  /** The file on screen, or null when a shell tab is. */
  activeFile: string | null;
  /** Draw the tab strip. */
  visible: boolean;
}

export function rightPaneStrip(
  layout: RightPaneLayout,
  files: readonly string[],
  activeFile: string | null,
): RightPaneStrip {
  if (!layout.hostVisible) {
    return { files: [], activeFile: null, visible: false };
  }
  let active =
    activeFile !== null && files.includes(activeFile) ? activeFile : null;
  // No shell tab to fall back to (`?view=work` is Work itself): a file is on.
  if (active === null && layout.tabs.length === 0 && files.length > 0) {
    active = files[files.length - 1];
  }
  // A folded Work rail is a 48 px strip; tabs cannot live over it, so the
  // strip shows only while a file (or an unfolded shell tab) is on screen.
  const shellOpen = layout.work !== "collapsed";
  return {
    files: [...files],
    activeFile: active,
    visible:
      active !== null ||
      (shellOpen && (files.length > 0 || layout.tabs.length >= 2)),
  };
}

export function rightPaneLayout(input: RightPaneInput): RightPaneLayout {
  const tabs = rightPaneTabs(input);
  const files = input.webLayer === "files";
  const active = files
    ? tabs.includes("work")
      ? "work"
      : null
    : resolveActiveTab(input.active, input.previous, tabs);
  // Beside Files, Work starts folded whatever the conversation preference.
  const folded = files ? !input.filesWorkOpen : input.workCollapsed;
  const work = active === "work" ? (folded ? "collapsed" : "open") : null;
  const activity =
    input.surface === "conversation" && input.agentDm && active === "activity";
  return {
    hostVisible: input.webLayer !== "page",
    tabs,
    active,
    handle: work === "open" || activity,
    work,
    activity,
    conversationCovered: files,
  };
}
