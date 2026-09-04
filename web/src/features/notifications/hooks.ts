import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { loadSeed } from "@/shared/lib/localSeed";
import { loadChannelPrefs } from "@/features/channels/lib/channelPrefs.ts";
import type { Profile } from "@/features/channels/hooks";
import { useChannels } from "@/features/channels/useChannels";
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
import { formatTitleBadge, stripTitleBadge } from "./lib/titleBadge.ts";

/** Chat messages. Reactions, typing and system rows never notify. */
const KIND_CHAT_MESSAGE = 9;

/** Profile display names for the notification title; written by `useProfiles`. */
const PROFILE_SEED_KEY = "profiles:v1";

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

/** True while the tab is backgrounded. */
export function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(
    () =>
      typeof document !== "undefined" && document.visibilityState === "hidden",
  );
  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === "hidden");
    onChange();
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
}

export interface NotificationRuntimeOptions {
  selfPubkey: string | null;
  /** Channel currently open on screen; null when none is selected. */
  activeChannelId: string | null;
  /** Navigate to a channel when a notification is clicked. */
  onOpenChannel?: (channelId: string) => void;
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

/**
 * The whole browser-side notification job: one live kind:9 subscription, the
 * OS notification, and the tab-title badge.
 *
 * ## Why the subscription is scoped by `#h`
 *
 * The obvious filter for "notify me about mentions and DMs" is
 * `{kinds:[9], "#p":[self]}` — no channel list needed, and the relay answers
 * it correctly for STORED events. It is nonetheless wrong, and wrong in the
 * silent way: it returns history and then never delivers another message.
 *
 * `SubscriptionRegistry::fan_out_scoped`
 * (`crates/buzz-relay/src/subscription.rs:387`) branches on the event's
 * channel: an event WITH a channel id is matched only against the
 * channel-keyed indexes, and the global `(kind, #p)` index is consulted only
 * for channel-less events — "Channel-scoped subscriptions are never in these
 * indexes, preserving the scoping invariant". A kind:9 always carries `h`, so
 * a globally-scoped subscription is never a live fan-out candidate for one.
 * Measured against the dev relay: the `#p`-only filter received EOSE and then
 * nothing when a matching message was published; adding `#h` delivered it.
 *
 * So the filter carries `#h` for every channel worth alerting about, and adds
 * `#p` on top in "mentions" mode — which keeps the relay doing the mention
 * filtering while staying inside the channel index.
 *
 * `since: now` makes it live-only: no backfill, so opening the app never
 * fires a burst of notifications for messages already read. A reconnect
 * replays the REQ with that same `since` and can redeliver, so seen event ids
 * are remembered (capped) and repeats are dropped.
 */
export function useNotificationRuntime(
  options: NotificationRuntimeOptions,
): NotificationRuntimeState {
  const { selfPubkey, activeChannelId, onOpenChannel } = options;
  const { session } = useRelaySession();
  const settings = useNotificationSettings();
  const permission = useNotificationPermission();
  const hidden = useDocumentHidden();
  // The runtime's own channel list. Mounted inside the shell this duplicates
  // the shell's kind:39000 subscription; the fix is to hoist the runtime and
  // pass the list down, not to read a cache that misses new channels.
  const { channels } = useChannels();

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

  const seenIds = useRef<Set<string>>(new Set());

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

  const mode = settings.mode;
  // Channels worth watching: everything the viewer has not muted. Muted ids
  // are left out of the REQ so the relay never sends them, and the decision
  // re-checks prefs on arrival so un-muting mid-session still works.
  const watchedIds = useMemo(() => {
    const muted = new Set(loadChannelPrefs().muted);
    return channels
      .filter((channel) => !channel.archived && !muted.has(channel.id))
      .map((channel) => channel.id)
      .sort();
  }, [channels]);
  // Channel ids are UUIDs, so a joined string is a lossless set key: the REQ
  // reopens when the SET changes, not on every channel-list re-render.
  const watchedKey = watchedIds.join(",");

  useEffect(() => {
    const ids = watchedKey ? watchedKey.split(",") : [];
    if (mode === "none" || !selfPubkey || ids.length === 0) {
      return;
    }
    const since = Math.floor(Date.now() / 1000);
    const filter =
      mode === "mentions"
        ? {
            kinds: [KIND_CHAT_MESSAGE],
            "#h": ids,
            "#p": [selfPubkey],
            since,
          }
        : { kinds: [KIND_CHAT_MESSAGE], "#h": ids, since };

    return session.subscribe(filter, {
      onEvent: (event: SignedNostrEvent) => {
        if (seenIds.current.has(event.id)) {
          return;
        }
        seenIds.current.add(event.id);
        if (seenIds.current.size > 500) {
          // Cheapest possible bound: the set only exists to survive a
          // reconnect replay, so dropping the oldest half is harmless.
          seenIds.current = new Set(Array.from(seenIds.current).slice(-250));
        }

        const current = latest.current;
        const prefs = loadChannelPrefs();
        const { channelId, message } = classifyMessage(event, {
          selfPubkey: current.selfPubkey,
          activeChannelId: current.activeChannelId,
          mutedChannelIds: prefs.muted,
          dmChannelIds: current.channels
            .filter((channel) => channel.type === "dm")
            .map((channel) => channel.id),
        });
        const decision = decideNotification(message, {
          mode: current.settings.mode,
          desktopEnabled: current.settings.desktopEnabled,
          permission: current.permission,
          documentHidden: current.hidden,
        });
        setLastDecision(decision);

        if (decision.badge) {
          setBadgeCount((count) => count + 1);
        }
        if (!decision.notify || channelId === null) {
          return;
        }

        const entry = current.channels.find(
          (channel) => channel.id === channelId,
        );
        const copy = notificationCopy({
          authorName: readAuthorName(event.pubkey),
          channelName: entry?.name ?? "",
          isDm: message.isDm,
          content: event.content,
          channelId,
        });
        try {
          const notification = new Notification(copy.title, {
            body: copy.body,
            tag: copy.tag,
            icon: "/assets/icons/icon-192.png",
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
      },
    });
  }, [session, mode, selfPubkey, watchedKey]);

  return { badgeCount, lastDecision, clearBadge };
}
