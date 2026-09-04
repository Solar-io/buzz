/**
 * The browser's Notification permission, reported honestly.
 *
 * Three facts this module refuses to blur, because blurring them is what
 * makes a notification feature look identical whether it works or is dead:
 *
 *  - a browser with no Notification API is `"unsupported"`, not `"default"`;
 *  - `"denied"` is terminal — `requestPermission()` resolves instantly with
 *    `"denied"` and no prompt is shown, so the UI must say "your browser is
 *    blocking this" rather than offering a button that does nothing;
 *  - permission can change outside the page (site settings), so callers
 *    re-read on focus rather than caching it for the session.
 */

import type { NotificationPermissionState } from "./notifyDecision.ts";

export function notificationsSupported(): boolean {
  return typeof globalThis !== "undefined" && "Notification" in globalThis;
}

/** The browser's current permission, or `"unsupported"`. */
export function readNotificationPermission(): NotificationPermissionState {
  if (!notificationsSupported()) {
    return "unsupported";
  }
  const permission = Notification.permission;
  return permission === "granted" || permission === "denied"
    ? permission
    : "default";
}

/**
 * Ask the browser for permission. MUST be called from a user gesture — every
 * current browser refuses (or silently ignores) a request made on load.
 *
 * Returns the resulting state; `"denied"` after a call that showed no prompt
 * is the normal, expected outcome for a site the user already blocked.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!notificationsSupported()) {
    return "unsupported";
  }
  try {
    const result = await Notification.requestPermission();
    return result === "granted" || result === "denied" ? result : "default";
  } catch {
    // Safari's callback-only signature rejects the promise form in some
    // versions; fall back to whatever the browser now reports.
    return readNotificationPermission();
  }
}
