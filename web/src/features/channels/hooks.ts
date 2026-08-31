import { useEffect, useMemo, useRef, useState } from "react";
import type { RelaySession } from "@/shared/api/relay-session";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";

import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  applyOverlay,
  editTargetFromEvent,
  TIMELINE_KINDS,
  timelineMessageFromEvent,
  upsertMessage,
  type MessageBuffer,
} from "./lib/messageBuffer.ts";
import {
  reactionFromEvent,
  upsertReaction,
  type ReactionIndex,
} from "./lib/reactions.ts";
import { recordTyping, typingFromEvent, type TypingMap } from "./lib/typing.ts";
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
}

export function useChannelMessages(channelId: string | null): ChannelFeed {
  const { session } = useRelaySession();
  const [buffer, setBuffer] = useState<MessageBuffer>([]);
  const [reactions, setReactions] = useState<ReactionIndex>(() => new Map());
  const [typing, setTyping] = useState<TypingMap>(() => new Map());

  useEffect(() => {
    setBuffer([]);
    setReactions(new Map());
    setTyping(new Map());
    if (!channelId) {
      return;
    }
    return session.subscribe(
      {
        kinds: [...TIMELINE_KINDS, 7, 20002, 40003, 5],
        "#h": [channelId],
        limit: 200,
      },
      {
        onEvent: (event: SignedNostrEvent) => {
          if (event.kind === 40003 || event.kind === 5) {
            const targetId = editTargetFromEvent(event);
            if (targetId) {
              setBuffer((previous) =>
                applyOverlay(
                  previous,
                  event.kind,
                  targetId,
                  event.kind === 40003 ? event.content : null,
                ),
              );
            }
            return;
          }
          if (event.kind === 7) {
            const reaction = reactionFromEvent(event);
            if (reaction) {
              setReactions((previous) =>
                upsertReaction(previous, reaction, event.pubkey),
              );
            }
            return;
          }
          if (event.kind === 20002) {
            const typed = typingFromEvent(event);
            if (typed) {
              setTyping((previous) =>
                recordTyping(
                  previous,
                  typed.channelId,
                  event.pubkey,
                  Date.now(),
                ),
              );
            }
            return;
          }
          const message = timelineMessageFromEvent(event);
          if (!message || message.channelId !== channelId) {
            return;
          }
          setBuffer((previous) => upsertMessage(previous, message));
        },
      },
    );
  }, [session, channelId]);

  return { messages: buffer, reactions, typing };
}

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
export function useProfiles(pubkeys: string[]): Map<string, Profile> {
  const { session } = useRelaySession();
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
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

  return profiles;
}

export interface SendResult {
  ok: boolean;
  message: string;
}

/** Publish a kind 9 channel message (mirrors buzz-sdk build_message tags). */
export async function sendReaction(
  session: RelaySession,
  options: { targetEventId: string; emoji: string },
): Promise<SendResult> {
  // NIP-25 / buzz-sdk build_reaction shape: kind 7, content = emoji,
  // one e tag naming the target. The relay persists it atomically with its
  // reaction row; a duplicate from the same author is a no-op server-side.
  const event = await signNostrEvent({
    kind: 7,
    tags: [["e", options.targetEventId]],
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
    kind: 9,
    tags,
    content: options.content,
  });
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
