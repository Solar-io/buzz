import { isAppFocused, useAppFocused } from "@/shared/lib/useDocumentVisible";

/**
 * Is somebody actually looking at this window? (left-nav invariant I3:
 * "markers advance only when seen")
 *
 * AUTOMATIC read-marker advances — the open conversation marking each new
 * arrival read, an open thread marking its replies read, Home marking its
 * feed seen — may only happen while the document is visible AND the window
 * has focus. Without this gate a desktop client that merely has a
 * conversation open (the always-on agent host, a window on another Space, a
 * window behind another app) marks every arrival read, and NIP-RS carries
 * that marker to the user's other devices within seconds: the toast fires on
 * the phone/PWA while the row's unread dot is already gone. When attention
 * returns, the gated effect re-runs and marks the open conversation then.
 *
 * Explicit user actions (Mark as read menus, Mark all read, selecting an
 * Inbox item, expanding a thread branch) are NOT gated — the click is the
 * attention.
 *
 * How the Tauri (WKWebView, macOS) window reports this:
 * - Another app frontmost, or the window on another Space: the window is not
 *   key, `blur` fires and `document.hasFocus()` is false.
 * - Minimized, hidden via close-to-hide (`window.hide()` in lib.rs), or fully
 *   occluded: WebKit's window-occlusion detection flips `visibilityState` to
 *   "hidden". `backgroundThrottling: "disabled"` in tauri.conf.json only sets
 *   WKPreferences.inactiveSchedulingPolicy (wry 0.57 wkwebview/mod.rs); it
 *   does not turn occlusion detection off.
 * - Known gap: an unattended Mac where Buzz is still the frontmost, unoccluded
 *   window on an awake display reports visible+focused — no web API can tell
 *   that nobody is in the chair.
 *
 * Regaining focus resolves after the activation event settles
 * (`scheduleAfterForegroundReady`), so the activating click lands first.
 */
export function useReadAttention(): boolean {
  return useAppFocused();
}

/**
 * Live re-check for use inside a gated effect. `useReadAttention` comes from a
 * shared store whose snapshot can be one render stale on first mount; checking
 * the document again at the moment of marking closes that window.
 */
export function isReadAttended(): boolean {
  return isAppFocused();
}
