import { useCallback, useEffect, useRef, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  buildHuddleReactionEvent,
  huddleReactionFilter,
  huddleReactionFromEvent,
  type HuddleReaction,
} from "./lib/huddleReactions.ts";

/**
 * Live emoji reactions for one huddle — kind 24810, the desktop's
 * `SmilePlus` burst.
 *
 * Two things about the shape of this hook are forced by the relay rather than
 * chosen:
 *
 *  - The REQ carries `#h`. Scope is resolved PER REQ, so a filter without it
 *    registers the subscription as global and no channel-carrying event is
 *    ever delivered to it. The subscription looks alive and receives nothing.
 *  - 24810 is ephemeral (never stored), so `since` buys no backfill and a
 *    reaction sent while this tab was disconnected is gone. Nothing here
 *    tries to reconcile history, because there is none to reconcile.
 *
 * Own reactions burst locally at click time and are then ignored on the way
 * back, so the sender sees no lag and no double.
 */

/** One reaction on screen. `key` is unique per burst, not per event. */
export interface ActiveHuddleReaction extends HuddleReaction {
  key: number;
}

/** How long one burst stays on screen. */
const REACTION_TTL_MS = 4_000;
/** Hard cap on simultaneous bursts, so a spam run cannot fill the viewport. */
const MAX_ACTIVE_REACTIONS = 12;

export function useHuddleReactions(options: {
  /** The ephemeral huddle channel; null disables the whole hook. */
  channelId: string | null;
  selfPubkey: string | null;
  /** Display name published with each reaction this client sends. */
  senderName: string;
  /** Resolve a `:shortcode:` to its image url, for outgoing reactions. */
  resolveEmojiUrl?: (emoji: string) => string | undefined;
}): {
  active: ActiveHuddleReaction[];
  send: (emoji: string) => void;
  error: string | null;
  clearError: () => void;
} {
  const { session } = useRelaySession();
  const { channelId, selfPubkey, senderName, resolveEmojiUrl } = options;
  const [active, setActive] = useState<ActiveHuddleReaction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const nextKeyRef = useRef(1);
  const timersRef = useRef<number[]>([]);
  // Read through a ref inside the subscription callback: the effect is keyed
  // on the channel, so a name that resolves after mount must not reopen it.
  const senderNameRef = useRef(senderName);
  senderNameRef.current = senderName;

  const push = useCallback((reaction: HuddleReaction) => {
    const key = nextKeyRef.current;
    nextKeyRef.current += 1;
    setActive((previous) =>
      [...previous, { ...reaction, key }].slice(-MAX_ACTIVE_REACTIONS),
    );
    const timer = window.setTimeout(() => {
      setActive((previous) => previous.filter((entry) => entry.key !== key));
      timersRef.current = timersRef.current.filter((id) => id !== timer);
    }, REACTION_TTL_MS);
    timersRef.current.push(timer);
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current) {
        window.clearTimeout(timer);
      }
      timersRef.current = [];
    };
  }, []);

  useEffect(() => {
    setActive([]);
    if (!channelId) {
      return;
    }
    const seen = new Set<string>();
    const since = Math.floor(Date.now() / 1_000);
    return session.subscribe(huddleReactionFilter(channelId, since), {
      onEvent: (event) => {
        if (seen.has(event.id)) {
          return;
        }
        seen.add(event.id);
        // Our own reaction already burst at click time.
        if (selfPubkey && event.pubkey === selfPubkey) {
          return;
        }
        const reaction = huddleReactionFromEvent(
          event,
          (pubkey) => `Participant ${truncatePubkey(pubkey)}`,
        );
        if (reaction) {
          push(reaction);
        }
      },
    });
  }, [session, channelId, selfPubkey, push]);

  const send = useCallback(
    (emoji: string) => {
      if (!channelId) {
        return;
      }
      const emojiUrl = resolveEmojiUrl?.(emoji) ?? null;
      const built = buildHuddleReactionEvent({
        channelId,
        emoji,
        senderName: senderNameRef.current,
        emojiUrl,
      });
      if ("error" in built) {
        setError(built.error);
        return;
      }
      setError(null);
      // Optimistic: the burst is the feedback that the click landed, and a
      // relay round trip is not worth waiting for on a decoration.
      push({
        emoji: built.event.content,
        emojiUrl,
        senderName: senderNameRef.current,
      });
      void (async () => {
        const signed = await signNostrEvent(built.event);
        const result = await session.publish(signed);
        if (!result.ok) {
          setError(result.message || "The relay refused the reaction.");
        }
      })().catch((cause: unknown) => {
        setError(
          cause instanceof Error ? cause.message : "Could not send reaction.",
        );
      });
    },
    [channelId, push, resolveEmojiUrl, session],
  );

  return {
    active,
    send,
    error,
    clearError: useCallback(() => setError(null), []),
  };
}
