/**
 * Per-device notification settings.
 *
 * Deliberately local (localStorage), not a relay event: "does THIS browser
 * pop an OS notification" is a property of the device you are sitting at, and
 * syncing it would switch notifications on for a machine whose owner never
 * granted permission there.
 */

import type { NotificationMode } from "./notifyDecision.ts";

const SETTINGS_KEY = "buzz.notifications.v1";

export interface NotificationSettings {
  /**
   * Master switch for OS notifications. Off by default: turning it on is the
   * user gesture that permission may be requested from, and a page that asks
   * on load gets refused by the browser (and resented by the user).
   */
  desktopEnabled: boolean;
  /** Show the unread count in the tab title. */
  titleBadgeEnabled: boolean;
  /** What counts as worth alerting about — governs badge and notification. */
  mode: NotificationMode;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  desktopEnabled: false,
  titleBadgeEnabled: true,
  mode: "mentions",
};

function isMode(value: unknown): value is NotificationMode {
  return value === "all" || value === "mentions" || value === "none";
}

/**
 * Parse stored JSON into settings, field by field.
 *
 * Anything missing or malformed falls back to its default rather than
 * discarding the whole record: a settings blob written by an older build
 * should keep the fields it does have.
 */
export function parseNotificationSettings(
  raw: string | null,
): NotificationSettings {
  if (!raw) {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
  const record = parsed as Record<string, unknown>;
  return {
    desktopEnabled:
      typeof record.desktopEnabled === "boolean"
        ? record.desktopEnabled
        : DEFAULT_NOTIFICATION_SETTINGS.desktopEnabled,
    titleBadgeEnabled:
      typeof record.titleBadgeEnabled === "boolean"
        ? record.titleBadgeEnabled
        : DEFAULT_NOTIFICATION_SETTINGS.titleBadgeEnabled,
    mode: isMode(record.mode)
      ? record.mode
      : DEFAULT_NOTIFICATION_SETTINGS.mode,
  };
}

export function serializeNotificationSettings(
  settings: NotificationSettings,
): string {
  return JSON.stringify(settings);
}

export function loadNotificationSettings(): NotificationSettings {
  try {
    return parseNotificationSettings(
      globalThis.localStorage?.getItem(SETTINGS_KEY) ?? null,
    );
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
}

export function saveNotificationSettings(settings: NotificationSettings): void {
  try {
    globalThis.localStorage?.setItem(
      SETTINGS_KEY,
      serializeNotificationSettings(settings),
    );
  } catch {
    // Storage blocked (private window, quota): settings stay session-local.
  }
}
