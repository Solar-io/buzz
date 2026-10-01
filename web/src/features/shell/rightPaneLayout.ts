/**
 * The shell's right pane as a pure function of the route's state.
 *
 * Phase 1 (phase-1.md §3) made the pane a TAB STRIP with Work always first.
 * Phase 2 took the thread out of it: a thread now opens in place, under its
 * message (features/channels/ui/InlineThread), so the strip is Work and —
 * in an agent DM — the agent's Thinking pane. A thread is never a tab.
 * Canvas (Sam, 2026-09-30) is the second top-level tab: documents live
 * under it, never beside Work (`rightPaneStrip`).
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

import { resolveCanvasItem } from "@/features/shelf/lib/fileTabs.ts";

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
 * The strip as drawn (Sam, 2026-09-30): exactly two top-level tabs, **Work**
 * and **Canvas**, plus the agent's Thinking pane in an agent DM. Canvas holds
 * documents — the channel canvas, then every file opened from chat or the
 * Shelf — as its own sub-tabs; a file is never a top-level tab.
 *
 * Canvas sits over the shell's tabs: while it is on screen the pane is the
 * selected document; picking Work or Thinking hands the pane back to
 * `layout.active`, and Canvas keeps its selection for the way back.
 */
export type PaneTabId = RightTabId | "canvas";

export interface CanvasInput {
  /** The Canvas documents' keys in sub-tab order (channel canvas first). */
  items: readonly string[];
  /** The document last chosen (null, or gone: the first). */
  active: string | null;
  /** The viewer put Canvas on screen (opened a file, or picked the tab). */
  open: boolean;
  /**
   * The pane docks (lg). Below it Canvas is not a tab — a file is a
   * full-screen sheet — so nothing here may mount a second copy.
   */
  docked: boolean;
}

export interface RightPaneStrip {
  /** Top-level tabs in order: Work, Canvas, then Thinking. */
  tabs: PaneTabId[];
  /** The top-level tab on screen, or null when nothing is docked open. */
  active: PaneTabId | null;
  /** The Canvas document on screen (null: Canvas is hidden, or empty). */
  canvasItem: string | null;
  /** Draw the tab strip. */
  visible: boolean;
}

/** Canvas follows Work, or leads when Work is the page itself. */
export function paneTabs(layout: RightPaneLayout): PaneTabId[] {
  const tabs: PaneTabId[] = [];
  for (const tab of layout.tabs) {
    tabs.push(tab);
    if (tab === "work") {
      tabs.push("canvas");
    }
  }
  return tabs.includes("canvas") ? tabs : ["canvas", ...tabs];
}

export function rightPaneStrip(
  layout: RightPaneLayout,
  canvas: CanvasInput,
): RightPaneStrip {
  if (!layout.hostVisible) {
    return { tabs: [], active: null, canvasItem: null, visible: false };
  }
  // No shell tab to fall back to (`?view=work` is Work itself): Canvas is
  // the pane whenever it holds anything.
  const pageCanvas = layout.tabs.length === 0 && canvas.items.length > 0;
  const canvasOn = canvas.docked && (canvas.open || pageCanvas);
  const active: PaneTabId | null = canvasOn ? "canvas" : layout.active;
  return {
    tabs: paneTabs(layout),
    active,
    canvasItem: canvasOn
      ? resolveCanvasItem(canvas.items, canvas.active)
      : null,
    // A folded Work rail is a 48 px strip; tabs cannot live over it, so the
    // strip shows while Canvas or an unfolded shell tab is on screen.
    visible:
      active === "canvas" || (active !== null && layout.work !== "collapsed"),
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
