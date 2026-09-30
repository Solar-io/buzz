/**
 * What the shell's right pane shows, as a pure function of the route's state.
 *
 * Moved out of `routes/repos.tsx` (web redesign Phase 0) without changing a
 * rule: the conversation row's JSX conditions and the view pages' old
 * `WithThreadPane` behaviour, made table-testable. Phase 1 extends this file
 * into the tab model.
 */

/** Which surface the shell row is showing. */
export type PaneSurface = "conversation" | "view" | "none";

export interface RightPaneInput {
  surface: PaneSurface;
  /** A thread in the OPEN channel resolved to a root message. */
  threadRoot: boolean;
  /** A thread kept open from another channel (DetachedThreadPanel). */
  detached: boolean;
  /** The open conversation is a 1:1 DM with a known agent. */
  agentDm: boolean;
  rightTab: "thinking" | "thread";
  /** The agent-DM thinking pane was closed on desktop. */
  paneHidden: boolean;
  /** Links/Files cover the row. */
  webLayerActive: boolean;
}

export interface RightPaneLayout {
  /** False: the host renders `display:none` but stays mounted (drafts survive). */
  hostVisible: boolean;
  /** The drag-resize handle between the conversation and the pane. */
  handle: boolean;
  /** The open channel's thread, docked at lg (overlay below). */
  threadDocked: boolean;
  /** The kept-open thread from another channel. */
  detached: boolean;
  /** The open channel's thread as a phone overlay only (thinking tab at lg). */
  threadMobileOnly: boolean;
  /** The agent's thinking (activity) pane. */
  activity: boolean;
}

const NOTHING: Omit<RightPaneLayout, "hostVisible"> = {
  handle: false,
  threadDocked: false,
  detached: false,
  threadMobileOnly: false,
  activity: false,
};

export function rightPaneLayout(input: RightPaneInput): RightPaneLayout {
  const hostVisible = !input.webLayerActive;
  if (input.surface === "view") {
    // The old WithThreadPane: a kept-open thread docks beside the view, with
    // no resize handle (it never had one there).
    return { ...NOTHING, hostVisible, detached: input.detached };
  }
  if (input.surface === "none") {
    return { ...NOTHING, hostVisible };
  }
  const { threadRoot, detached, agentDm, rightTab, paneHidden } = input;
  const threadOpen = threadRoot || detached;
  const threadTab = !agentDm || rightTab === "thread";
  return {
    hostVisible,
    // Kept quirk: an agent DM with its pane hidden and no thread still gets
    // the handle, though nothing is docked beside it.
    handle: threadOpen || agentDm,
    threadDocked: threadRoot && threadTab,
    detached: detached && threadTab,
    threadMobileOnly: threadRoot && agentDm && rightTab === "thinking",
    activity:
      agentDm && !paneHidden && (!threadOpen || rightTab === "thinking"),
  };
}
