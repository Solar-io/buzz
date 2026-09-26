import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  type ActiveWebAction,
  type ActiveWebState,
  INITIAL_ACTIVE_WEB,
  type WebViewTarget,
  activeWebReducer,
} from "./lib/activeWebView.ts";

/**
 * The single "what's showing" state for the main pane's web layer, held at
 * module scope so every entry point drives the same state: the sidebar's
 * Links and Files rows, the ⌘K palette, and Settings' "Open" on a Files site
 * (which routes back to /repos after setting it). The reducer and its rules
 * live in `lib/activeWebView.ts`.
 */

let state: ActiveWebState = INITIAL_ACTIVE_WEB;
const listeners = new Set<() => void>();

export function dispatchActiveWeb(action: ActiveWebAction): void {
  const next = activeWebReducer(state, action);
  if (next === state) {
    return;
  }
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ActiveWebState {
  return state;
}

/** Show a web target from anywhere (Settings uses this before navigating). */
export function showWebView(target: WebViewTarget): void {
  dispatchActiveWeb({ type: "show", target });
}

export interface ActiveWebView {
  state: ActiveWebState;
  show: (target: WebViewTarget) => void;
  /** Back to the conversation; frames stay alive behind it. */
  hide: () => void;
  setFocus: (focused: boolean) => void;
}

export function useActiveWebView(): ActiveWebView {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const hide = useCallback(() => dispatchActiveWeb({ type: "hide" }), []);
  const setFocus = useCallback(
    (focused: boolean) => dispatchActiveWeb({ type: "focus", focused }),
    [],
  );
  return useMemo(
    () => ({ state: current, show: showWebView, hide, setFocus }),
    [current, hide, setFocus],
  );
}

/** Test seam. */
export function resetActiveWebForTests(): void {
  state = INITIAL_ACTIVE_WEB;
  listeners.clear();
}
