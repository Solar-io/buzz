/**
 * The shell's right pane as a pure function of the route's state.
 *
 * Phase 0 moved the rules out of `routes/repos.tsx` unchanged; Phase 1
 * (phase-1.md §3) turns the pane into a TAB STRIP: Work is always tab 1,
 * the open thread and the agent's thinking pane join as tabs while they
 * exist. At `lg` the host is a docked column; below it there is no dock —
 * the thread and thinking panes keep their own full-screen sheets, and Work
 * is the `?view=work` page.
 */

/** Which surface the shell row is showing. */
export type PaneSurface = "conversation" | "view" | "none";

/** The right pane's tabs, in strip order. */
export type RightTabId = "work" | "thread" | "activity";

export interface RightPaneInput {
  surface: PaneSurface;
  /** A thread in the OPEN channel resolved to a root message. */
  threadRoot: boolean;
  /** A thread kept open from another channel (DetachedThreadPanel). */
  detached: boolean;
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
  /** Thread layout "split": a thread is a tab. "focus" keeps it an overlay. */
  threadIsTab: boolean;
  /** The Work rail is folded to its 44 px strip. */
  workCollapsed: boolean;
}

export interface RightPaneLayout {
  /** False: the host renders `display:none` but stays mounted (drafts survive). */
  hostVisible: boolean;
  /** The strip, Work first. A strip of one renders as a plain title. */
  tabs: RightTabId[];
  /** The tab on screen at lg — `active` if it still exists, else a fallback. */
  active: RightTabId | null;
  /** The drag-resize handle (lg), whenever something is docked open. */
  handle: boolean;
  /** Work at lg: open, folded to the strip, or not shown. */
  work: "open" | "collapsed" | null;
  /** Mount the open channel's ThreadPanel (a sheet below lg). */
  thread: boolean;
  /** …and it is the docked tab at lg (else lg-hidden, still mounted). */
  threadDocked: boolean;
  /** …or it is a focus-layout overlay, on screen at every width. */
  threadFocus: boolean;
  /** Mount the kept-open thread from another channel. */
  detached: boolean;
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

/** Work is always first; thread and thinking join while they exist. */
export function rightPaneTabs(input: RightPaneInput): RightTabId[] {
  const tabs: RightTabId[] = [];
  if (input.workTab) {
    tabs.push("work");
  }
  const conversation = input.surface === "conversation";
  const threadOpen =
    (conversation && input.threadRoot) ||
    (input.surface !== "none" && input.detached);
  if (input.threadIsTab && threadOpen) {
    tabs.push("thread");
  }
  if (conversation && input.agentDm && !input.paneHidden) {
    tabs.push("activity");
  }
  return tabs;
}

export function rightPaneLayout(input: RightPaneInput): RightPaneLayout {
  const tabs = rightPaneTabs(input);
  const active = resolveActiveTab(input.active, input.previous, tabs);
  const conversation = input.surface === "conversation";
  const thread = conversation && input.threadRoot;
  const threadDocked = thread && input.threadIsTab && active === "thread";
  // A focus-layout thread is a full-screen overlay at every width, so it
  // never needs to be the active tab to show.
  const detached =
    input.surface !== "none" &&
    input.detached &&
    (!input.threadIsTab || active === "thread");
  const work =
    active === "work" ? (input.workCollapsed ? "collapsed" : "open") : null;
  const activity = conversation && input.agentDm && active === "activity";
  return {
    hostVisible: !input.webLayerActive,
    tabs,
    active,
    handle:
      work === "open" ||
      threadDocked ||
      (detached && input.threadIsTab) ||
      activity,
    work,
    thread,
    threadDocked,
    threadFocus: thread && !input.threadIsTab,
    detached,
    activity,
  };
}
