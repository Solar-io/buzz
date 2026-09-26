/**
 * "What's showing" in the main pane's web layer, as one pure reducer
 * (plan items 3 + 4, 2026-09-26).
 *
 * Before this, the shell kept `filesOpen` and `shortcutOverlay` as two
 * independent flags rendered through a ternary, and the dock kept its own
 * tab session. That produced four bugs: a second link click was ignored (the
 * dock's `openedOnce` ref never reset), Files hid a clicked agent or link,
 * a 6-tab cap refused silently, and every close/switch destroyed the frames
 * so nothing was ever instant. One state replaces all of it:
 *
 * - `active` is what the web layer shows, or null (the conversation shows).
 *   Any link / Files click sets it, from ANY state; any conversation click
 *   clears it. Nothing ever refuses.
 * - `mounted` is the keep-alive LRU of frames (least recent first). Only
 *   frames that have been shown are mounted, and past {@link KEEP_ALIVE}
 *   the least recently used one is evicted — never the one showing.
 * - `focus` (full screen) belongs to one open: it resets whenever `active`
 *   changes, so full screen never leaks into the next navigation and hides
 *   the sidebar by surprise.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

/** Live iframes kept mounted at once. */
export const KEEP_ALIVE = 4;

export type WebViewKind = "files" | "link";

export interface WebViewTarget {
  kind: WebViewKind;
  panelId: string;
}

export interface ActiveWebState {
  active: WebViewTarget | null;
  /** Frame keys ({@link webViewKey}), least recently used first. */
  mounted: string[];
  focus: boolean;
}

export type ActiveWebAction =
  | { type: "show"; target: WebViewTarget }
  | { type: "hide" }
  | { type: "focus"; focused: boolean }
  /** Drop frames whose panel no longer exists (a removed link or site). */
  | { type: "prune"; validKeys: ReadonlySet<string> };

export const INITIAL_ACTIVE_WEB: ActiveWebState = {
  active: null,
  mounted: [],
  focus: false,
};

/**
 * Which Files site the sidebar's Files row opens: the most recently shown one
 * that still exists, else the first configured one, else the built-in id
 * (which resolves to nothing, so the layer shows the Files setup form).
 */
export function pickFilesPanel(
  filesPanelIds: readonly string[],
  mounted: readonly string[],
): string {
  for (let i = mounted.length - 1; i >= 0; i--) {
    const key = mounted[i];
    if (key.startsWith("files:")) {
      const id = key.slice("files:".length);
      if (filesPanelIds.includes(id)) {
        return id;
      }
    }
  }
  return filesPanelIds[0] ?? "files";
}

/** Frame key: Files sites and links live in separate id spaces. */
export function webViewKey(target: WebViewTarget): string {
  return `${target.kind}:${target.panelId}`;
}

function sameTarget(a: WebViewTarget | null, b: WebViewTarget | null) {
  return (
    a !== null && b !== null && a.kind === b.kind && a.panelId === b.panelId
  );
}

export function activeWebReducer(
  state: ActiveWebState,
  action: ActiveWebAction,
): ActiveWebState {
  switch (action.type) {
    case "show": {
      const key = webViewKey(action.target);
      const mounted = [...state.mounted.filter((k) => k !== key), key];
      while (mounted.length > KEEP_ALIVE) {
        mounted.shift();
      }
      return {
        active: action.target,
        mounted,
        focus: sameTarget(state.active, action.target) ? state.focus : false,
      };
    }
    case "hide":
      if (state.active === null && !state.focus) {
        return state;
      }
      // Frames stay mounted: coming back is instant, with no reload.
      return { ...state, active: null, focus: false };
    case "focus":
      if (state.active === null || state.focus === action.focused) {
        return state;
      }
      return { ...state, focus: action.focused };
    case "prune": {
      const mounted = state.mounted.filter((k) => action.validKeys.has(k));
      const activeGone =
        state.active !== null &&
        !action.validKeys.has(webViewKey(state.active));
      if (mounted.length === state.mounted.length && !activeGone) {
        return state;
      }
      return activeGone
        ? { active: null, mounted, focus: false }
        : { ...state, mounted };
    }
  }
}
