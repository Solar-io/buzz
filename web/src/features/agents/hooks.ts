import { useEffect, useMemo, useState } from "react";
import * as nip44 from "nostr-tools/nip44";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { getUnlockedSecretKey, hasUnlockedKey } from "@/shared/lib/key-store";
import type { ObserverFeed, ObserverFrame } from "./lib/observerEvents";

const MAX_FRAMES = 150;

function decodeFrame(
  event: SignedNostrEvent,
  secretKey: Uint8Array,
): ObserverFrame | null {
  try {
    const conversationKey = nip44.v2.utils.getConversationKey(
      secretKey,
      event.pubkey,
    );
    const plaintext = nip44.v2.decrypt(event.content, conversationKey);
    const parsed = JSON.parse(plaintext) as {
      seq?: unknown;
      timestamp?: unknown;
      kind?: unknown;
      channel_id?: unknown;
      payload?: unknown;
    };
    return {
      id: event.id,
      createdAt: event.created_at,
      seq: typeof parsed.seq === "number" ? parsed.seq : 0,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
      kind: typeof parsed.kind === "string" ? parsed.kind : "event",
      channelId:
        typeof parsed.channel_id === "string" ? parsed.channel_id : null,
      payload: parsed.payload ?? null,
    };
  } catch {
    // Wrong key (not the owner) or malformed payload — counted as locked.
    return null;
  }
}

/**
 * Live tail of an agent's kind:24200 observer frames addressed to the local
 * user (the owner). The desktop's ManagedAgentSessionPanel equivalent; frames
 * are ephemeral on the relay, so this is what is retained plus whatever the
 * relay replays on subscribe.
 */
export function useObserverEvents(agentPubkey: string | null): ObserverFeed {
  const { session } = useRelaySession();
  const [events, setEvents] = useState<SignedNostrEvent[]>([]);

  useEffect(() => {
    if (!agentPubkey) {
      setEvents([]);
      return;
    }
    setEvents([]);
    let cancelled = false;
    let started = false;
    const start = (ownerPubkey: string) => {
      if (cancelled || started) {
        return;
      }
      started = true;
      return session.subscribe(
        {
          kinds: [24200],
          authors: [agentPubkey],
          "#p": [ownerPubkey],
          limit: MAX_FRAMES,
        },
        {
          onEvent: (event) => {
            setEvents((previous) => [...previous, event]);
          },
        },
      );
    };
    if (hasUnlockedKey()) {
      const secretKey = getUnlockedSecretKey();
      if (secretKey) {
        import("nostr-tools").then(({ getPublicKey }) => {
          start(getPublicKey(secretKey));
        });
      }
    } else if (typeof window !== "undefined" && window.nostr) {
      void window.nostr.getPublicKey().then((pubkey) => start(pubkey));
    }
    return () => {
      cancelled = true;
    };
  }, [session, agentPubkey]);

  return useMemo(() => {
    if (!hasUnlockedKey()) {
      return { frames: [], lockedCount: events.length };
    }
    const secretKey = getUnlockedSecretKey();
    if (!secretKey) {
      return { frames: [], lockedCount: events.length };
    }
    const frames: ObserverFrame[] = [];
    let lockedCount = 0;
    for (const event of events) {
      const frame = decodeFrame(event, secretKey);
      if (frame) {
        frames.push(frame);
      } else {
        lockedCount += 1;
      }
    }
    frames.sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
    return { frames: frames.slice(-MAX_FRAMES), lockedCount };
  }, [events]);
}
