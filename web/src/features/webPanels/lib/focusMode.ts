import { useCallback, useState } from "react";

/**
 * Dock focus mode (Sam, 2026-09-24): on an iPad-width browser the Files dock
 * shares the screen with the channel sidebar and its own tab bar, which left
 * an embedded spreadsheet too small to read. Focus mode hides both so the
 * iframe gets the whole viewport. Remembered per browser so reopening Files
 * on the iPad lands straight back in it.
 */
export const DOCK_FOCUS_KEY = "buzz.files-dock-focus.v1";

export function loadDockFocus(): boolean {
  try {
    return globalThis.localStorage?.getItem(DOCK_FOCUS_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveDockFocus(focused: boolean): void {
  try {
    if (focused) {
      globalThis.localStorage?.setItem(DOCK_FOCUS_KEY, "1");
    } else {
      globalThis.localStorage?.removeItem(DOCK_FOCUS_KEY);
    }
  } catch {
    // Storage can throw (private mode, quota); focus still works this session.
  }
}

export function useDockFocusMode(): [boolean, (focused: boolean) => void] {
  const [focused, setFocused] = useState(loadDockFocus);
  const set = useCallback((next: boolean) => {
    saveDockFocus(next);
    setFocused(next);
  }, []);
  return [focused, set];
}
