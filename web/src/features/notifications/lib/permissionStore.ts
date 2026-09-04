/**
 * The browser's Notification permission as an external store, so every
 * mounted reader (the runtime and the settings screen) agrees on it.
 *
 * Permission changes in three ways and only one of them is a promise the page
 * awaits: the user answers our prompt, the user changes it in site settings
 * while the tab is backgrounded, or a different tab of the same origin
 * prompts. The last two are invisible to JavaScript, so the store re-reads on
 * focus and on visibility change rather than trusting a value cached at
 * mount — a settings screen that says "not asked yet" while the browser says
 * "blocked" is exactly the dishonesty this feature has to avoid.
 */

import type { NotificationPermissionState } from "./notifyDecision.ts";
import {
  readNotificationPermission,
  requestNotificationPermission,
} from "./permission.ts";

let snapshot: NotificationPermissionState | null = null;
const listeners = new Set<() => void>();

export function getNotificationPermission(): NotificationPermissionState {
  if (snapshot === null) {
    snapshot = readNotificationPermission();
  }
  return snapshot;
}

export function subscribeToNotificationPermission(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-read from the browser; wakes readers only when it actually moved. */
export function refreshNotificationPermission(): NotificationPermissionState {
  const next = readNotificationPermission();
  if (next !== snapshot) {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  }
  return next;
}

/**
 * Prompt, then publish the answer. Call only from a user gesture — see
 * {@link requestNotificationPermission}.
 */
export async function promptForNotificationPermission(): Promise<NotificationPermissionState> {
  const result = await requestNotificationPermission();
  if (result !== snapshot) {
    snapshot = result;
    for (const listener of listeners) {
      listener();
    }
  }
  return result;
}
