import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ConversationActivityStore } from "@/features/activity/conversationActivity.ts";
import {
  isPageAttended,
  usePageAttended,
} from "@/features/activity/pageAttention.ts";
import { loadSeed } from "@/shared/lib/localSeed";
import { loadChannelPrefs } from "@/features/channels/lib/channelPrefs.ts";
import type { Profile } from "@/features/channels/hooks";
import { PROFILE_SEED_KEY } from "@/features/channels/hooks";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { classifyMessage } from "./lib/classifyMessage.ts";
import { notificationCopy } from "./lib/notificationCopy.ts";
import {
  decideNotification,
  type NotificationPermissionState,
  type NotifyDecision,
} from "./lib/notifyDecision.ts";
import {
  getNotificationPermission,
  refreshNotificationPermission,
  subscribeToNotificationPermission,
} from "./lib/permissionStore.ts";
import type { NotificationSettings } from "./lib/settings.ts";
import {
  getNotificationSettings,
  subscribeToNotificationSettings,
} from "./lib/settingsStore.ts";
import { playNotificationSound, soundSlotFor } from "./lib/sound.ts";
import { formatTitleBadge, stripTitleBadge } from "./lib/titleBadge.ts";

// PROFILE_SEED_KEY ("profiles:v1") is imported from channels/hooks — this
// file only reads the seed for notification names, and the storage contract
// (updatedAt/eventId) is owned by useProfiles. A second literal here would
// arm itself the day this file writes a profile.

/** Live per-device settings, shared by the runtime and the settings dialog. */
export function useNotificationSettings(): NotificationSettings {
  return useSyncExternalStore(
    subscribeToNotificationSettings,
    getNotificationSettings,
    getNotificationSettings,
  );
}

/**
 * The browser's permission, re-read whenever the tab regains focus.
 *
 * Permission is changed in browser UI the page never sees, so a value cached
 * at mount goes stale exactly when it matters — the user flips it in site
 * settings and comes back expecting the screen to agree with the browser.
 */
export function useNotificationPermission(): NotificationPermissionState {
  const permission = useSyncExternalStore(
    subscribeToNotificationPermission,
    getNotificationPermission,
    getNotificationPermission,
  );
  useEffect(() => {
    const reread = () => {
      refreshNotificationPermission();
    };
    reread();
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, []);
  return permission;
}

export interface NotificationRuntimeOptions {
  selfPubkey: string | null;
  /** Channel currently open on screen; null when none is selected. */
  activeChannelId: string | null;
  /** Navigate to a channel when a notification is clicked. */
  onOpenChannel?: (channelId: string) => void;
  /**
   * The shell's channel list. Passed in rather than fetched: the runtime needs
   * every non-muted channel to build its h-scoped filter, and subscribing for
   * itself would open a second kind:39000 REQ duplicating the shell's.
   */
  channels: ChannelSummary[];
  /**
   * Live arrivals from the shell's conversation-activity store — the same
   * feed the rows and toasts read (left-nav QA #9: this runtime used to
   * open its own since-now kind-9 REQ, a second definition of "new").
   */
  onArrival: ConversationActivityStore["onArrival"];
}

export interface NotificationRuntimeState {
  /** Messages counted while the tab has been in the background. */
  badgeCount: number;
  /** The most recent decision, for the settings screen's diagnostics row. */
  lastDecision: NotifyDecision | null;
  /** Clear the badge (also happens automatically when the tab is shown). */
  clearBadge: () => void;
}

function readAuthorName(pubkey: string): string {
  const seed = loadSeed(PROFILE_SEED_KEY);
  const profile = seed[pubkey] as Profile | undefined;
  const name = profile?.displayName?.trim() || profile?.name?.trim();
  return name || truncatePubkey(pubkey);
}

export { readAuthorName };

/**
 * The whole browser-side notification job: the OS notification, the sound
 * and the tab-title badge, driven by the conversation-activity store's live
 * arrivals (`onArrival`). The store's REQs are `#h`-scoped (a global `#p`
 * filter never receives a channel event live, `fan_out_scoped` in
 * buzz-relay), its arrivals are already live-only, deduped across
 * reconnect replays and silent during a replay round, and wakes for other
 * members never arrive. "Mentions" mode filters here, from the message's
 * `p` tags.
 */
export function useNotificationRuntime(
  options: NotificationRuntimeOptions,
): NotificationRuntimeState {
  const { selfPubkey, activeChannelId, onOpenChannel, channels, onArrival } =
    options;
  const settings = useNotificationSettings();
  const permission = useNotificationPermission();
  // "Looking at it" is ONE rule (pageAttention.ts): a visible but
  // unfocused window is not being looked at, exactly as for the read
  // marker and the toast (QA #3b).
  const attended = usePageAttended();
  const hidden = !attended;

  const [badgeCount, setBadgeCount] = useState(0);
  const [lastDecision, setLastDecision] = useState<NotifyDecision | null>(null);

  // Everything the event handler reads that must NOT resubscribe the REQ.
  const latest = useRef({
    selfPubkey,
    activeChannelId,
    settings,
    permission,
    hidden,
    onOpenChannel,
    channels,
  });
  latest.current = {
    selfPubkey,
    activeChannelId,
    settings,
    permission,
    hidden,
    onOpenChannel,
    channels,
  };

  const clearBadge = useCallback(() => setBadgeCount(0), []);

  // Coming back to the tab is the "I have seen it" signal for the badge.
  useEffect(() => {
    if (!hidden) {
      setBadgeCount(0);
    }
  }, [hidden]);

  // The badge in the tab title. Restores the bare title on unmount and
  // whenever the badge is switched off, so a stale "(3)" cannot persist.
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    const base = stripTitleBadge(document.title);
    document.title = settings.titleBadgeEnabled
      ? formatTitleBadge(base, badgeCount)
      : base;
    return () => {
      document.title = stripTitleBadge(document.title);
    };
  }, [badgeCount, settings.titleBadgeEnabled]);

  useEffect(
    () =>
      onArrival((entry) => {
        const current = latest.current;
        if (current.settings.mode === "none" || !current.selfPubkey) {
          return;
        }
        const event = {
          id: entry.eventId ?? "",
          kind: 9,
          pubkey: entry.pubkey,
          content: entry.preview,
          created_at: entry.createdAt,
          tags: [
            ["h", entry.channelId],
            ...(entry.mentions ?? []).map((pubkey) => ["p", pubkey]),
          ],
        };
        const prefs = loadChannelPrefs();
        const { channelId, message } = classifyMessage(event, {
          selfPubkey: current.selfPubkey,
          activeChannelId: current.activeChannelId,
          mutedChannelIds: prefs.muted,
          dmChannelIds: current.channels
            .filter((channel) => channel.type === "dm")
            .map((channel) => channel.id),
        });
        if (channelId === null) {
          return;
        }
        const decision = decideNotification(message, {
          mode: current.settings.mode,
          desktopEnabled: current.settings.desktopEnabled,
          permission: current.permission,
          // Read at arrival time, not from the last render.
          documentHidden: !isPageAttended(),
          soundEnabled: current.settings.soundEnabled,
        });
        setLastDecision(decision);

        if (decision.badge) {
          setBadgeCount((count) => count + 1);
        }
        // The sound is independent of the OS notification: it plays for a
        // visible tab, a refused permission, or desktop notifications off.
        if (decision.sound) {
          playNotificationSound(current.settings.sounds[soundSlotFor(message)]);
        }
        if (!decision.notify) {
          return;
        }

        const channel = current.channels.find((c) => c.id === channelId);
        const copy = notificationCopy({
          authorName: readAuthorName(entry.pubkey),
          channelName: channel?.name ?? "",
          isDm: message.isDm,
          content: entry.preview,
          channelId,
        });
        try {
          const notification = new Notification(copy.title, {
            body: copy.body,
            tag: copy.tag,
            icon: "/assets/icons/icon-192.png",
            // Ours is the sound; the OS must not stack its own chime on top.
            silent: true,
          });
          notification.onclick = () => {
            window.focus();
            notification.close();
            latest.current.onOpenChannel?.(channelId);
          };
        } catch {
          // Some browsers throw when constructing a Notification outside a
          // service worker (mobile Chrome). Nothing to recover: the badge
          // has already counted the message.
        }
      }),
    [onArrival],
  );

  return { badgeCount, lastDecision, clearBadge };
}
