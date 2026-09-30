/**
 * Pure show/hide decisions for the composer's 🧠 and Replies toggles (Sam,
 * 2026-09-22: both are two-way toggles), on the right pane's TAB model
 * (web redesign phase-1.md §3: Work | Thread | Thinking, Work always first).
 *
 * The route owns the state; this file owns the policy. It is import-free so
 * `node --test` loads it directly, and every rule the two buttons encode is
 * asserted in `dmPaneToggles.test.mjs`:
 *
 *  - The 🧠 toggles the thinking tab against the tab before it: showing makes
 *    it the active tab (un-hiding it and raising the phone sheet), hiding
 *    closes it and returns to where the viewer was.
 *  - Replies does the same for the thread tab. Hiding returns to the previous
 *    tab and KEEPS the thread (it stays a tab; its own ✕ closes it), so the
 *    button is its own inverse. Showing needs a root — the live one, or the
 *    last one the route ever opened, which is why the route tracks
 *    `lastThreadRootId`.
 */

/** The right pane's tabs (mirrors `features/shell/rightPaneLayout.ts`). */
export type RightTabId = "work" | "thread" | "activity";

/** Snapshot of the pane state the toggles decide over. */
export interface DmPaneState {
  /** An agent DM is open: the thinking tab can exist. */
  agentDm: boolean;
  /** The thinking tab was closed (its ✕ / the 🧠 hide). */
  paneHidden: boolean;
  /** The phone thinking sheet is open (`thinkingOpen` in the route). */
  mobileOpen: boolean;
  /** Below the lg breakpoint — panes are sheets there, not docked tabs. */
  mobile: boolean;
  threadRootId: string | null;
  /** The tab on screen… */
  active: RightTabId;
  /** …and the one before it. */
  previous: RightTabId;
  /** Newest thread root the route has ever opened (hide/show restore). */
  lastThreadRootId: string | null;
}

/** The subset of {@link DmPaneState} a toggle may change. */
export interface DmPanePatch {
  paneHidden?: boolean;
  mobileOpen?: boolean;
  threadRootId?: string | null;
  active?: RightTabId;
  previous?: RightTabId;
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

/** Where closing `leaving` lands: the previous tab, unless it IS `leaving`. */
function backFrom(state: DmPaneState, leaving: RightTabId): RightTabId {
  return state.previous !== leaving ? state.previous : "work";
}

/** Make `tab` active, remembering where the viewer came from. */
function activate(state: DmPaneState, tab: RightTabId): DmPanePatch {
  return {
    active: tab,
    previous: state.active === tab ? state.previous : state.active,
  };
}

/**
 * Is the thinking pane on screen? At lg it is the active tab; below lg the
 * same tab is only on screen while its sheet is open.
 */
export function thinkingPaneVisible(state: DmPaneState): boolean {
  if (!state.agentDm || state.paneHidden || state.active !== "activity") {
    return false;
  }
  return !state.mobile || state.mobileOpen;
}

/**
 * The 🧠's next state: the exact inverse of visibility. Hiding closes the
 * tab on BOTH form factors (sheet and dock are one gesture) and returns to
 * the previous tab; showing selects it, un-hides it and raises the sheet.
 */
export function toggleThinkingPatch(state: DmPaneState): DmPanePatch {
  return thinkingPaneVisible(state)
    ? {
        paneHidden: true,
        mobileOpen: false,
        active: backFrom(state, "activity"),
      }
    : {
        ...activate(state, "activity"),
        paneHidden: false,
        mobileOpen: true,
      };
}

/** Is the thread the tab on screen? */
export function threadPaneVisible(state: DmPaneState): boolean {
  return state.threadRootId !== null && state.active === "thread";
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
    return { active: backFrom(state, "thread") };
  }
  const root = state.threadRootId ?? state.lastThreadRootId;
  if (root === null) {
    return null;
  }
  return { threadRootId: root, ...activate(state, "thread") };
}
