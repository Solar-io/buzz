import { buildReactionEmojiTag } from "@/features/custom-emoji/lib/customEmojiTags";
import type { CustomEmoji } from "@/features/custom-emoji/lib/customEmoji";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RelaySession } from "@/shared/api/relay-session";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";

import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  deleteChannelTags,
  renameChannelTags,
} from "@/features/channels/lib/channelAdmin.ts";
import {
  applyOverlay,
  editTargetFromEvent,
  timelineMessageFromEvent,
  upsertMessage,
  DELETE_KIND,
  type MessageBuffer,
} from "./lib/messageBuffer.ts";
import {
  systemEventFromContent,
  tombstoneTargetId,
  SYSTEM_MESSAGE_KIND,
} from "./lib/systemEvent.ts";
import {
  applyOverlayToCache,
  initialSyncFilters,
  loadTimelineCache,
  mergeCachedMessage,
  dropCachedReaction,
  mergeCachedReaction,
  olderPageFilter,
  OLDER_PAGE,
  saveTimelineCache,
  type TimelineCacheEntry,
} from "./lib/timelineCache.ts";
import {
  mergeRelayThreadSummary,
  relayThreadSummaryFromEvent,
  THREAD_SUMMARY_KIND,
  type RelayThreadSummaryMap,
} from "./lib/threadSummaryEvent.ts";
import {
  reactionFromEvent,
  removeReaction,
  upsertReaction,
  type ReactionIndex,
} from "./lib/reactions.ts";
import { recordTyping, typingFromEvent, type TypingMap } from "./lib/typing.ts";
import { loadSeed, mergeSeed } from "@/shared/lib/localSeed.ts";
import {
  PRESENCE_KIND,
  mergePresence,
  presenceFromEvent,
  type PresenceEntry,
} from "./lib/presence.ts";

/** Live timeline for one channel (kind 9 + channel event kinds, by #h tag). */
export interface ChannelFeed {
  messages: MessageBuffer;
  reactions: ReactionIndex;
  typing: TypingMap;
  /**
   * Relay-materialised thread counters (kind 39005), keyed by thread root.
   * `reply_count` / `descendant_count` come from the relay's own
   * `thread_metadata`, so a root whose replies fall outside this buffer
   * still reports a truthful count. Empty until a reply lands while we are
   * subscribed — the overlay is synthesized at write time, never stored.
   */
  threadSummaries: RelayThreadSummaryMap;
  /** Fetch one older-history page (scroll-up). No-op when exhausted/busy. */
  loadOlder: () => void;
  loadingOlder: boolean;
  /** True once an older page came back short — the channel start is reached. */
  historyExhausted: boolean;
  /**
   * Drop the viewer's own reaction from live state and cache, without waiting
   * for the relay. A reaction removal is a kind-5 targeting the reaction
   * event, which the message-overlay path cannot apply, so the UI has to
   * account for it here.
   */
  forgetOwnReaction: (
    targetId: string,
    emoji: string,
    selfPubkey: string,
  ) => void;
}

/**
 * Cache write-through interval: batching disk writes keeps a busy channel
 * from re-serializing the whole buffer per message.
 */
const CACHE_FLUSH_MS = 1_000;

export function useChannelMessages(channelId: string | null): ChannelFeed {
  const { session } = useRelaySession();
  const [buffer, setBuffer] = useState<MessageBuffer>([]);
  const [reactions, setReactions] = useState<ReactionIndex>(() => new Map());
  const [typing, setTyping] = useState<TypingMap>(() => new Map());
  const [threadSummaries, setThreadSummaries] = useState<RelayThreadSummaryMap>(
    () => new Map(),
  );
  const [historyExhausted, setHistoryExhausted] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** Cache state mirror — updated synchronously with every buffer change. */
  const cacheRef = useRef<TimelineCacheEntry | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingOlderRef = useRef(false);

  const flushCache = useCallback(() => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    if (cacheRef.current && channelId) {
      void saveTimelineCache(channelId, cacheRef.current);
    }
  }, [channelId]);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
    }
    flushTimer.current = setTimeout(flushCache, CACHE_FLUSH_MS);
  }, [flushCache]);

  /**
   * One relay event → buffer state + cache write-through. Shared by the live
   * sync subscription and scroll-up pagination pages so both paths apply
   * overlays, reactions and messages identically.
   */
  const applyEvent = useCallback(
    (event: SignedNostrEvent) => {
      if (event.kind === 40003 || event.kind === 5) {
        const targetId = editTargetFromEvent(event);
        if (targetId) {
          const content = event.kind === 40003 ? event.content : null;
          setBuffer((previous) =>
            applyOverlay(previous, event.kind, targetId, content),
          );
          if (cacheRef.current) {
            cacheRef.current = applyOverlayToCache(
              cacheRef.current,
              event.kind,
              targetId,
              content,
            );
            scheduleFlush();
          }
        }
        return;
      }
      if (event.kind === 7) {
        const reaction = reactionFromEvent(event);
        if (reaction) {
          setReactions((previous) =>
            upsertReaction(previous, reaction, event.pubkey),
          );
          if (cacheRef.current) {
            cacheRef.current = mergeCachedReaction(
              cacheRef.current,
              reaction,
              event.pubkey,
            );
            scheduleFlush();
          }
        }
        return;
      }
      if (event.kind === THREAD_SUMMARY_KIND) {
        // Routed BEFORE the message path on purpose: a 39005 carries an `h`
        // tag, so `timelineMessageFromEvent` would happily build a row out
        // of it and spill `{"reply_count":…}` into the conversation.
        const summary = relayThreadSummaryFromEvent(event);
        if (
          summary &&
          (summary.channelId === null || summary.channelId === channelId)
        ) {
          setThreadSummaries((previous) =>
            mergeRelayThreadSummary(previous, summary),
          );
        }
        return;
      }
      if (event.kind === 20002) {
        const typed = typingFromEvent(event);
        if (typed) {
          setTyping((previous) =>
            recordTyping(previous, typed.channelId, event.pubkey, Date.now()),
          );
        }
        return;
      }
      const message = timelineMessageFromEvent(event);
      if (!message || message.channelId !== channelId) {
        return;
      }
      // A kind-40099 moderation tombstone reports a removal the relay has
      // ALREADY soft-deleted server-side. The removal itself travels as kind
      // 9005, which this client does not subscribe to, so without this the
      // tombstone would render directly above the message it says was
      // removed. Hide the target through the same delete path kind 5 uses so
      // the in-memory buffer and the on-disk cache agree.
      if (message.kind === SYSTEM_MESSAGE_KIND) {
        const removedId = tombstoneTargetId(
          systemEventFromContent(message.content),
        );
        if (removedId) {
          setBuffer((previous) =>
            applyOverlay(previous, DELETE_KIND, removedId, null),
          );
          if (cacheRef.current) {
            cacheRef.current = applyOverlayToCache(
              cacheRef.current,
              DELETE_KIND,
              removedId,
              null,
            );
          }
        }
      }
      setBuffer((previous) => upsertMessage(previous, message));
      if (cacheRef.current) {
        cacheRef.current = mergeCachedMessage(cacheRef.current, message);
        scheduleFlush();
      }
    },
    [channelId, scheduleFlush],
  );

  useEffect(() => {
    setBuffer([]);
    setReactions(new Map());
    setTyping(new Map());
    setThreadSummaries(new Map());
    setHistoryExhausted(false);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    cacheRef.current = null;
    if (!channelId) {
      return;
    }

    let alive = true;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      // Seed from disk first: the cursor decides what the sync REQ must ask
      // for, and a warm cache paints the timeline before the network moves.
      const cached = await loadTimelineCache(channelId);
      if (!alive) {
        return;
      }
      cacheRef.current = cached ?? {
        messages: [],
        reactions: new Map(),
        cursor: 0,
        historyExhausted: false,
      };
      if (cached) {
        setBuffer(cached.messages);
        setReactions(cached.reactions);
        setHistoryExhausted(cached.historyExhausted);
      }
      unsubscribe = session.subscribe(
        initialSyncFilters(channelId, cached ? cached.cursor : null),
        { onEvent: applyEvent },
      );
    })();

    return () => {
      alive = false;
      unsubscribe?.();
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      if (cacheRef.current) {
        void saveTimelineCache(channelId, cacheRef.current);
      }
    };
  }, [session, channelId, applyEvent]);

  const loadOlder = useCallback(() => {
    if (
      !channelId ||
      loadingOlderRef.current ||
      historyExhausted ||
      buffer.length === 0
    ) {
      return;
    }
    const oldest = buffer[0].createdAt;
    if (oldest <= 1) {
      return;
    }
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    let messageCount = 0;
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      loadingOlderRef.current = false;
      setLoadingOlder(false);
      // A short page means the channel's start is inside what we just
      // loaded — stop offering pagination, and persist that in the cache.
      if (messageCount < OLDER_PAGE) {
        setHistoryExhausted(true);
        if (cacheRef.current) {
          cacheRef.current = {
            ...cacheRef.current,
            historyExhausted: true,
          };
          void saveTimelineCache(channelId, cacheRef.current);
        }
      }
    };
    const unsubscribe = session.subscribe(olderPageFilter(channelId, oldest), {
      onEvent: (event: SignedNostrEvent) => {
        if (
          event.kind !== 20002 &&
          event.kind !== 7 &&
          event.kind !== 40003 &&
          event.kind !== 5
        ) {
          messageCount++;
        }
        applyEvent(event);
      },
      onEose: () => {
        finish();
        unsubscribe();
      },
    });
    // Belt and braces: a lost EOSE must not wedge the pagination guard.
    setTimeout(finish, 10_000);
  }, [channelId, historyExhausted, buffer, session, applyEvent]);

  /**
   * Optimistically drop the viewer's own reaction from live state and cache.
   *
   * The relay confirmation cannot do this for us: a reaction removal is a
   * kind-5 whose target is the *reaction* event, and `applyEvent` routes
   * kind-5 to the message overlay path, which no-ops because no message
   * carries that id. Without this the chip would sit there until reload, and
   * `dropCachedReaction` is what stops the reload repainting it from disk.
   */
  const forgetOwnReaction = useCallback(
    (targetId: string, emoji: string, selfPubkey: string) => {
      setReactions((previous) =>
        removeReaction(previous, targetId, emoji, selfPubkey),
      );
      if (cacheRef.current) {
        cacheRef.current = dropCachedReaction(
          cacheRef.current,
          { targetId, emoji },
          selfPubkey,
        );
        scheduleFlush();
      }
    },
    [scheduleFlush],
  );

  return {
    messages: buffer,
    reactions,
    typing,
    threadSummaries,
    loadOlder,
    loadingOlder,
    historyExhausted,
    forgetOwnReaction,
  };
}

/**
 * Forum reads live in `./useForum.ts` — this file hit the repository's
 * 1000-line ceiling. Re-exported so every existing
 * `from "@/features/channels/hooks"` import keeps working.
 */
export {
  useForumPosts,
  useForumThread,
  type ForumPostsFeed,
  type ForumThread,
} from "./useForum.ts";

export interface ChannelMember {
  pubkey: string;
  /** Best display name available: profile name, else truncated key. */
  name: string;
}

/** Channel members from kind 39002 admission events (p tag = member). */
export function useChannelMembers(channelId: string | null): ChannelMember[] {
  const { session } = useRelaySession();
  const [members, setMembers] = useState<ChannelMember[]>([]);

  useEffect(() => {
    setMembers([]);
    if (!channelId) {
      return;
    }
    return session.subscribe(
      { kinds: [39002], "#d": [channelId], limit: 500 },
      {
        onEvent: (event: SignedNostrEvent) => {
          const dTag = event.tags.find((tag) => tag[0] === "d")?.[1];
          if (dTag !== channelId) {
            return;
          }
          setMembers((previous) => {
            const next = new Map(previous.map((m) => [m.pubkey, m]));
            for (const tag of event.tags) {
              if (tag[0] === "p" && typeof tag[1] === "string") {
                if (!next.has(tag[1])) {
                  next.set(tag[1], { pubkey: tag[1], name: shortKey(tag[1]) });
                }
              }
            }
            return Array.from(next.values());
          });
        },
      },
    );
  }, [session, channelId]);

  return members;
}

function shortKey(pubkey: string): string {
  return truncatePubkey(pubkey);
}

export interface Profile {
  name: string;
  displayName: string;
  avatar?: string;
}

/** kind 0 profile metadata for a set of authors, fetched once per author. */
const PROFILE_SEED_KEY = "profiles:v1";

export function useProfiles(pubkeys: string[]): Map<string, Profile> {
  const { session } = useRelaySession();
  // Seed from localStorage first: the sidebar paints names on the first
  // frame while the relay answers.
  const [profiles, setProfiles] = useState<Map<string, Profile>>(() => {
    const seed = new Map<string, Profile>();
    for (const [pubkey, value] of Object.entries(loadSeed(PROFILE_SEED_KEY))) {
      if (
        value &&
        typeof value === "object" &&
        typeof (value as Profile).name === "string"
      ) {
        seed.set(pubkey, value as Profile);
      }
    }
    return seed;
  });
  const key = useMemo(() => Array.from(new Set(pubkeys)).sort(), [pubkeys]);
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (key.length === 0) {
      return;
    }
    return session.subscribe(
      { kinds: [0], authors: key, limit: key.length },
      {
        onEvent: (event: SignedNostrEvent) => {
          let name = "";
          let displayName = "";
          let avatar: string | undefined;
          try {
            const parsed = JSON.parse(event.content) as {
              name?: unknown;
              display_name?: unknown;
              picture?: unknown;
            };
            if (typeof parsed.name === "string") {
              name = parsed.name;
            }
            if (typeof parsed.display_name === "string") {
              displayName = parsed.display_name;
            }
            if (typeof parsed.picture === "string") {
              avatar = parsed.picture;
            }
          } catch {
            // Malformed metadata: fall back to the truncated key.
          }
          const profile: Profile = {
            // Buzz profiles often set only display_name (e.g. Sam's): fall
            // through to it so name-keyed consumers don't render hex keys.
            name: name || displayName || shortKey(event.pubkey),
            displayName: displayName || name || shortKey(event.pubkey),
            avatar,
          };
          setProfiles((previous) => {
            const existing = previous.get(event.pubkey);
            if (existing) {
              return previous;
            }
            const next = new Map(previous);
            next.set(event.pubkey, profile);
            return next;
          });
        },
      },
    );
    // The profiles themselves are replaceable events; latest-wins by created_at
    // would need ordering, but first-seen is acceptable for Phase 1 display.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, key.length, key]);

  // Write-through (merged, so several instances with different author sets
  // enrich the same seed instead of clobbering each other).
  useEffect(() => {
    if (profiles.size === 0) {
      return;
    }
    const timer = setTimeout(() => {
      mergeSeed(PROFILE_SEED_KEY, Object.fromEntries(profiles.entries()));
    }, 1_000);
    return () => clearTimeout(timer);
  }, [profiles]);

  return profiles;
}

export interface SendResult {
  ok: boolean;
  message: string;
}

/** Publish a kind 9 channel message (mirrors buzz-sdk build_message tags). */
export async function sendReaction(
  session: RelaySession,
  options: {
    targetEventId: string;
    emoji: string;
    /**
     * Community palette, when the reaction may be a custom `:shortcode:`.
     * For a shortcode over 64 characters the relay admits the reaction ONLY
     * when a matching NIP-30 emoji tag is present, so the tag is admission
     * rather than decoration — and without it no other client can render it.
     */
    palette?: ReadonlyArray<CustomEmoji>;
  },
): Promise<SendResult> {
  // NIP-25 / buzz-sdk build_reaction shape: kind 7, content = emoji,
  // one e tag naming the target. The relay persists it atomically with its
  // reaction row; a duplicate from the same author is a no-op server-side.
  const emojiTag = options.palette
    ? buildReactionEmojiTag(options.emoji, options.palette)
    : null;
  const event = await signNostrEvent({
    kind: 7,
    tags: emojiTag
      ? [["e", options.targetEventId], emojiTag]
      : [["e", options.targetEventId]],
    content: options.emoji,
  });
  const result = await session.publish(event);
  return { ok: result.ok, message: result.message };
}

export async function sendTypingIndicator(
  session: RelaySession,
  channelId: string,
  threadRef?: { rootId: string; replyToId: string } | null,
): Promise<void> {
  // Ephemeral kind 20002 (HarnessRelay::build_typing_event shape); the relay
  // routes it without storage, so failures are silently ignored.
  const tags: string[][] = [["h", channelId]];
  if (threadRef) {
    if (threadRef.rootId === threadRef.replyToId) {
      tags.push(["e", threadRef.replyToId, "", "reply"]);
    } else {
      tags.push(["e", threadRef.rootId, "", "root"]);
      tags.push(["e", threadRef.replyToId, "", "reply"]);
    }
  }
  try {
    const event = await signNostrEvent({
      kind: 20002,
      tags,
      content: "",
    });
    await session.publish(event);
  } catch {
    // Typing is best-effort; never block the composer on it.
  }
}

export async function editChannelMessage(
  session: RelaySession,
  options: { channelId: string; targetEventId: string; content: string },
): Promise<SendResult> {
  // Desktop build_message_edit shape: kind 40003, h + e(target), new content.
  const event = await signNostrEvent({
    kind: 40003,
    tags: [
      ["h", options.channelId],
      ["e", options.targetEventId],
    ],
    content: options.content,
  });
  const result = await session.publish(event);
  return { ok: result.ok, message: result.message };
}

export async function deleteChannelMessage(
  session: RelaySession,
  options: { channelId: string; targetEventId: string },
): Promise<SendResult> {
  // Desktop build_delete_compat shape: kind 5, h + e(target), empty content.
  const event = await signNostrEvent({
    kind: 5,
    tags: [
      ["h", options.channelId],
      ["e", options.targetEventId],
    ],
    content: "",
  });
  const result = await session.publish(event);
  return { ok: result.ok, message: result.message };
}

export async function sendChannelMessage(
  session: RelaySession,
  options: {
    channelId: string;
    content: string;
    mentionPubkeys: string[];
    threadRef?: { rootId: string; replyToId: string } | null;
    mediaTags?: string[][];
    /**
     * Event kind to publish. Chat messages are kind 9; forum views pass
     * 45001 (top-level post, threadRef null) or 45003 (comment, threadRef
     * set) — desktop's build_forum_post/build_forum_comment tag shapes,
     * which this builder already produces.
     */
    kind?: number;
    /**
     * Called with the signed event after signing but before it reaches the
     * relay. Signing yields the event's real id, so a caller can insert an
     * optimistic row keyed by that id and the relay's echo upserts the same
     * row rather than duplicating it.
     */
    onSigned?: (event: { id: string; created_at: number }) => void;
  },
): Promise<SendResult> {
  const tags: string[][] = [["h", options.channelId]];
  if (options.threadRef) {
    const { rootId, replyToId } = options.threadRef;
    if (rootId === replyToId) {
      tags.push(["e", rootId, "", "reply"]);
    } else {
      tags.push(["e", rootId, "", "root"]);
      tags.push(["e", replyToId, "", "reply"]);
    }
  }
  for (const pubkey of options.mentionPubkeys) {
    tags.push(["p", pubkey]);
  }
  for (const mediaTag of options.mediaTags ?? []) {
    tags.push(mediaTag);
  }

  const event = await signNostrEvent({
    kind: options.kind ?? 9,
    tags,
    content: options.content,
  });
  options.onSigned?.(event);
  return session.publish(event);
}

/** Publish own presence (kind 20001) — the relay keeps it in Redis and
 *  synthesizes snapshot events for author-scoped subscribers. */
export async function sendPresence(
  session: RelaySession,
  status: "online" | "away" | "offline",
): Promise<void> {
  try {
    const event = await signNostrEvent({
      kind: 20001,
      tags: [],
      content: status,
    });
    await session.publish(event);
  } catch {
    // Presence is best-effort.
  }
}

/** NIP-29 leave request (kind 9022, h tag) — the relay drops membership. */
export async function leaveChannel(
  session: RelaySession,
  channelId: string,
): Promise<SendResult> {
  const event = await signNostrEvent({
    kind: 9022,
    tags: [["h", channelId]],
    content: "",
  });
  const result = await session.publish(event);
  return { ok: result.ok, message: result.message };
}

/** NIP-29 edit-metadata rename (kind 9002, h+name tags — build_update_channel). */
export async function renameChannel(
  session: RelaySession,
  channelId: string,
  name: string,
): Promise<SendResult> {
  const event = await signNostrEvent({
    kind: 9002,
    tags: renameChannelTags(channelId, name),
    content: "",
  });
  const result = await session.publish(event);
  return { ok: result.ok, message: result.message };
}

/** NIP-29 delete-group (kind 9008, h tag — build_delete_channel). Owner/admin only. */
export async function deleteChannel(
  session: RelaySession,
  channelId: string,
): Promise<SendResult> {
  const event = await signNostrEvent({
    kind: 9008,
    tags: deleteChannelTags(channelId),
    content: "",
  });
  const result = await session.publish(event);
  return { ok: result.ok, message: result.message };
}

/**
 * Presence for a set of pubkeys: one author-scoped kind-20001 subscription.
 * The relay synthesizes a snapshot on subscribe, so the map is immediately
 * populated; live updates arrive as users re-publish.
 */
export function usePresence(pubkeys: string[]): Map<string, PresenceEntry> {
  const { session } = useRelaySession();
  const [entries, setEntries] = useState<Map<string, PresenceEntry>>(new Map());
  const key = useMemo(() => Array.from(new Set(pubkeys)).sort(), [pubkeys]);
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (key.length === 0) {
      return;
    }
    setEntries(new Map());
    return session.subscribe(
      { kinds: [PRESENCE_KIND], authors: key, limit: key.length },
      {
        onEvent: (event: SignedNostrEvent) => {
          const entry = presenceFromEvent(event);
          if (entry) {
            setEntries((current) => mergePresence(current, entry));
          }
        },
      },
    );
  }, [session, key]);

  return entries;
}
