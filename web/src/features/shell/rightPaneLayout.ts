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
 */

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
  /** Links/Files cover the row. */
  webLayerActive: boolean;
  /** Work is a tab (false on `?view=work`, where it is the page itself). */
  workTab: boolean;
  /** The Work rail is folded to its 44 px strip. */
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
  if (
    input.surface === "conversation" &&
    input.agentDm &&
    !input.paneHidden
  ) {
    tabs.push("activity");
  }
  return tabs;
}

export function rightPaneLayout(input: RightPaneInput): RightPaneLayout {
  const tabs = rightPaneTabs(input);
  const active = resolveActiveTab(input.active, input.previous, tabs);
  const work =
    active === "work" ? (input.workCollapsed ? "collapsed" : "open") : null;
  const activity =
    input.surface === "conversation" && input.agentDm && active === "activity";
  return {
    hostVisible: !input.webLayerActive,
    tabs,
    active,
    handle: work === "open" || activity,
    work,
    activity,
  };
}
