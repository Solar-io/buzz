/**
 * One module-level settings store, read through `useSyncExternalStore`.
 *
 * A React context would have to wrap both the runtime and the settings
 * dialog; those are mounted from the sidebar profile card today and belong at
 * the app shell tomorrow. A module store makes the move a no-op — every
 * reader sees the same snapshot wherever it is mounted, and there is no
 * provider to forget.
 */

import {
  loadNotificationSettings,
  saveNotificationSettings,
  type NotificationSettings,
} from "./settings.ts";

let snapshot: NotificationSettings | null = null;
const listeners = new Set<() => void>();

export function getNotificationSettings(): NotificationSettings {
  if (snapshot === null) {
    snapshot = loadNotificationSettings();
  }
  return snapshot;
}

export function subscribeToNotificationSettings(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Merge a patch into the settings, persist it, and wake every reader. */
export function updateNotificationSettings(
  patch: Partial<NotificationSettings>,
): NotificationSettings {
  const next = { ...getNotificationSettings(), ...patch };
  snapshot = next;
  saveNotificationSettings(next);
  for (const listener of listeners) {
    listener();
  }
  return next;
}
