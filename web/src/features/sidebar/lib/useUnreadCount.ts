import { useEffect, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/**
 * Unread count for a DM row: one bounded one-shot REQ counting the other
 * party's messages newer than the read marker. The relay is the only honest
 * source — a closed DM's timeline cache is stale by definition, so counting
 * from it would miss exactly the messages that make the row unread.
 * Module-level in-flight map keeps one REQ per (channel, marker) even as
 * rows re-render.
 */
const unreadCountInFlight = new Set<string>();

/**
 * Safety valve for the in-flight guard: a REQ that dies before its EOSE
 * (socket dropped mid-query) must not leave its key in the set forever — a
 * leaked key makes every future run for the same (channel, marker) skip
 * re-subscribing, freezing the badge at its last value until a full page
 * reload (live incident 2026-09-11: days-old backgrounded PWA, badges
 * frozen though the socket showed Connected).
 */
const IN_FLIGHT_TIMEOUT_MS = 15_000;

/**
 * Count the peer's unseen messages in one DM.
 *
 * @param channelId - DM channel to count in; null skips the REQ.
 * @param lastSeenAt - Read marker in unix seconds; null skips the REQ.
 * @param selfPubkey - Viewer's key — their own messages never count.
 * @returns The running count, or null while nothing has been counted yet.
 */
export function useUnreadCount(
  channelId: string | null,
  lastSeenAt: number | null,
  selfPubkey: string | null,
): number | null {
  const { session } = useRelaySession();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!channelId || !lastSeenAt) {
      setCount(null);
      return;
    }
    const key = `${channelId}:${lastSeenAt}`;
    if (unreadCountInFlight.has(key)) {
      return;
    }
    unreadCountInFlight.add(key);
    let seen = 0;
    const leakValve = setTimeout(
      () => unreadCountInFlight.delete(key),
      IN_FLIGHT_TIMEOUT_MS,
    );
    const unsubscribe = session.subscribe(
      { kinds: [9], "#h": [channelId], since: lastSeenAt, limit: 200 },
      {
        onEvent: (event: SignedNostrEvent) => {
          if (event.pubkey !== selfPubkey) {
            seen += 1;
            setCount(seen);
          }
        },
        onEose: () => {
          clearTimeout(leakValve);
          unreadCountInFlight.delete(key);
          unsubscribe();
        },
      },
    );
    return () => {
      // The key MUST go too: after unsubscribe, EOSE can never fire, so the
      // only other cleanup path (onEose) will not run — a leaked key here
      // reproduces the frozen-badge bug this commit fixes (systematically
      // under StrictMode's double-invoke, narrowly in prod on fast unmount).
      clearTimeout(leakValve);
      unreadCountInFlight.delete(key);
      unsubscribe();
    };
  }, [channelId, lastSeenAt, selfPubkey, session]);
  return count;
}
