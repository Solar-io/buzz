import { useEffect, useMemo, useRef, useState } from "react";
import type { RelaySession } from "@/shared/api/relay-session";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";

import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  TIMELINE_KINDS,
  timelineMessageFromEvent,
  upsertMessage,
  type MessageBuffer,
} from "./lib/messageBuffer.ts";

/** Live timeline for one channel (kind 9 + channel event kinds, by #h tag). */
export function useChannelMessages(channelId: string | null): MessageBuffer {
  const { session } = useRelaySession();
  const [buffer, setBuffer] = useState<MessageBuffer>([]);

  useEffect(() => {
    setBuffer([]);
    if (!channelId) {
      return;
    }
    return session.subscribe(
      { kinds: [...TIMELINE_KINDS], "#h": [channelId], limit: 200 },
      {
        onEvent: (event: SignedNostrEvent) => {
          const message = timelineMessageFromEvent(event);
          if (!message || message.channelId !== channelId) {
            return;
          }
          setBuffer((previous) => upsertMessage(previous, message));
        },
      },
    );
  }, [session, channelId]);

  return buffer;
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
            name: name || shortKey(event.pubkey),
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

  const event = await signNostrEvent({
    kind: 9,
    tags,
    content: options.content,
  });
  return session.publish(event);
}
