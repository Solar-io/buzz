/**
 * Pure show/hide decisions for the DM right-pane toggles (Sam, 2026-09-22:
 * the composer's 🧠 and the new Replies button both become two-way toggles).
 *
 * The route owns the state; this file owns the policy. It is import-free so
 * `node --test` loads it directly, and every rule the two buttons encode is
 * asserted in `dmPaneToggles.test.mjs`:
 *
 *  - The 🧠 shows the thinking pane when it is off-screen (collapsed, on the
 *    Replies tab, or below lg with the sheet closed) and hides it when it is
 *    on screen — the exact inverse of `thinkingPaneVisible`.
 *  - The Replies button does the same for the thread pane. Hiding in an agent
 *    DM flips the tab back to Thinking (the thread root is kept, so the
 *    button can flip forward again); everywhere else it closes the pane
 *    exactly like the pane's own ✕. Showing needs a root — the live one, or
 *    the last one the route ever opened, which is why the route tracks
 *    `lastThreadRootId`.
 */

/** Which right-pane content an agent DM is showing. */
export type RightTab = "thinking" | "thread";

/** Snapshot of the pane state the toggles decide over. */
export interface DmPaneState {
  /** An agent DM is open: both tabs exist and `rightTab` picks the pane. */
  agentDm: boolean;
  /** Desktop collapse of the DM right pane (the pane's ✕ / 🧠 hide). */
  paneHidden: boolean;
  /** The mobile thinking sheet is open (`thinkingOpen` in the route). */
  mobileOpen: boolean;
  /** Below the lg breakpoint — panes are overlays/sheets there, not docks. */
  mobile: boolean;
  threadRootId: string | null;
  rightTab: RightTab;
  /** Newest thread root the route has ever opened (hide/show restore). */
  lastThreadRootId: string | null;
}

/** The subset of {@link DmPaneState} a toggle may change. */
export interface DmPanePatch {
  paneHidden?: boolean;
  mobileOpen?: boolean;
  threadRootId?: string | null;
  rightTab?: RightTab;
}

/**
 * The two-way panel controls the composer's action row renders — what
 * `useDmRightPane` derives, grouped so the row takes one prop instead of
 * five and the pair cannot be half-wired.
 */
export interface PaneToggles {
  thinkingVisible: boolean;
  toggleThinking: () => void;
  threadsVisible: boolean;
  threadsAvailable: boolean;
  toggleThreads: () => void;
}

/**
 * Is the thinking pane on screen?
 *
 * The render condition the route already uses (`dmAgentPubkey && !dmPaneHidden
 * && (!threadRoot || rightTab === "thinking")`) is the desktop truth; below lg
 * the mounted pane is only on screen while the sheet (`mobileOpen`) is open,
 * because the same route condition keeps it out of the DOM otherwise.
 */
export function thinkingPaneVisible(state: DmPaneState): boolean {
  if (!state.agentDm) {
    return false;
  }
  if (state.mobile && !state.mobileOpen) {
    return false;
  }
  return (
    !state.paneHidden &&
    (state.threadRootId === null || state.rightTab === "thinking")
  );
}

/**
 * The 🧠's next state: the exact inverse of visibility. Hiding collapses the
 * pane on BOTH form factors (the sheet close and the desktop collapse are the
 * same gesture now); showing selects the thinking tab, un-collapses, and
 * raises the sheet — the trio the old open-only button did.
 */
export function toggleThinkingPatch(state: DmPaneState): DmPanePatch {
  return thinkingPaneVisible(state)
    ? { paneHidden: true, mobileOpen: false }
    : { rightTab: "thinking", paneHidden: false, mobileOpen: true };
}

/**
 * Is the Replies pane the active right-pane content?
 *
 * In a non-DM channel the thread pane has no tab to share — it is visible
 * whenever a root is open. In an agent DM the tab decides.
 */
export function threadPaneVisible(state: DmPaneState): boolean {
  if (state.threadRootId === null) {
    return false;
  }
  return !state.agentDm || state.rightTab === "thread";
}

/**
 * Can the Replies toggle show anything at all? With no live root and no
 * remembered one there is no thread to render — the button renders disabled
 * rather than dead.
 */
export function threadToggleAvailable(state: DmPaneState): boolean {
  return state.threadRootId !== null || state.lastThreadRootId !== null;
}

/**
 * The Replies button's next state, or null when there is nothing to show
 * (the caller leaves the button disabled in that case, so null is
 * unreachable from the UI and exists for the policy's own honesty).
 */
export function toggleThreadPatch(state: DmPaneState): DmPanePatch | null {
  if (threadPaneVisible(state)) {
    return state.agentDm ? { rightTab: "thinking" } : { threadRootId: null };
  }
  const root = state.threadRootId ?? state.lastThreadRootId;
  if (root === null) {
    return null;
  }
  return { threadRootId: root, rightTab: "thread", paneHidden: false };
}
