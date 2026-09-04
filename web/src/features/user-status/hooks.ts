import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "@/shared/api/relay-session";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  activeStatus,
  buildUserStatusEvent,
  KIND_USER_STATUS,
  reduceStatusEvents,
  USER_STATUS_D_TAG,
  type StatusEventLike,
  type UserStatus,
} from "./lib/statusEvent.ts";

/**
 * How often the map is re-folded so an expiring status disappears on its own.
 * Statuses are a minutes-scale thing; a slower tick would leave a lapsed
 * status on screen, a faster one buys nothing.
 */
const EXPIRY_TICK_MS = 30_000;

/**
 * Statuses the viewer has just published, held until the relay echoes them.
 *
 * kind:30315 is replaceable, so the relay's copy is authoritative the moment
 * it arrives — but a publish plus a round trip is long enough for the profile
 * card to look like the save did nothing. A module store rather than local
 * state, so every reader updates together and a later mount still sees it.
 */
interface OptimisticEntry {
  /** null = the viewer cleared their status. */
  status: UserStatus | null;
  /** `created_at` of the event we published; the relay wins from here on. */
  at: number;
}

const optimistic = new Map<string, OptimisticEntry>();
const optimisticListeners = new Set<() => void>();
let optimisticVersion = 0;

function optimisticSnapshot(): number {
  return optimisticVersion;
}

function subscribeOptimistic(listener: () => void) {
  optimisticListeners.add(listener);
  return () => {
    optimisticListeners.delete(listener);
  };
}

function setOptimistic(pubkey: string, entry: OptimisticEntry | null): void {
  if (entry === null) {
    optimistic.delete(pubkey);
  } else {
    optimistic.set(pubkey, entry);
  }
  optimisticVersion += 1;
  for (const listener of optimisticListeners) {
    listener();
  }
}

/**
 * Overlay the pending local write onto what the relay has told us.
 *
 * The relay wins as soon as its copy is at least as new as ours — that is
 * what makes this an optimistic write rather than a local shadow copy that
 * never yields.
 */
function applyOptimistic(
  folded: Map<string, UserStatus>,
  nowSeconds: number,
): Map<string, UserStatus> {
  for (const [pubkey, entry] of optimistic) {
    const relayCopy = folded.get(pubkey);
    if (relayCopy && relayCopy.updatedAt >= entry.at) {
      continue;
    }
    const current = entry.status
      ? activeStatus(entry.status, nowSeconds)
      : null;
    if (current) {
      folded.set(pubkey, current);
    } else {
      folded.delete(pubkey);
    }
  }
  return folded;
}

/**
 * Live statuses for a set of authors.
 *
 * One REQ per author set: the relay answers with the stored replaceable
 * events, then keeps the subscription open, so this covers both the initial
 * read and live updates without the desktop's second live-only subscription.
 */
export function useUserStatuses(
  pubkeys: readonly (string | null | undefined)[],
): Map<string, UserStatus> {
  const { session } = useRelaySession();
  const authors = useMemo(
    () =>
      Array.from(
        new Set(
          pubkeys.filter(
            (pubkey): pubkey is string =>
              typeof pubkey === "string" && pubkey.length > 0,
          ),
        ),
      ).sort(),
    [pubkeys],
  );
  const authorsKey = authors.join(",");
  const [events, setEvents] = useState<StatusEventLike[]>([]);
  const [tick, setTick] = useState(0);
  const optimisticStamp = useSyncExternalStore(
    subscribeOptimistic,
    optimisticSnapshot,
    optimisticSnapshot,
  );

  useEffect(() => {
    const ids = authorsKey ? authorsKey.split(",") : [];
    if (ids.length === 0) {
      setEvents([]);
      return;
    }
    setEvents([]);
    return session.subscribe(
      {
        kinds: [KIND_USER_STATUS],
        authors: ids,
        "#d": [USER_STATUS_D_TAG],
        limit: ids.length,
      },
      {
        onEvent: (event: SignedNostrEvent) => {
          setEvents((previous) => [...previous, event]);
        },
      },
    );
  }, [session, authorsKey]);

  // Expiry is honoured on read, so the fold has to re-run on a clock as well
  // as on new events — otherwise a status carrying an `expiration` tag sits
  // on screen until something unrelated happens to re-render.
  useEffect(() => {
    const timer = window.setInterval(
      () => setTick((value) => value + 1),
      EXPIRY_TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, []);

  return useMemo(() => {
    void tick;
    void optimisticStamp;
    const now = Math.floor(Date.now() / 1000);
    return applyOptimistic(reduceStatusEvents(events, now), now);
  }, [events, tick, optimisticStamp]);
}

export interface PublishStatusResult {
  ok: boolean;
  message: string;
}

/**
 * Publish the viewer's status. Blank text with a blank emoji clears it —
 * kind:30315 is replaceable and has no delete, so the empty event IS the
 * clear (`crates/buzz-sdk/src/builders.rs:1719-1722`).
 *
 * The local overlay is written before the publish and rolled back if the
 * relay refuses, so a rejected save cannot leave a status showing that the
 * community never received.
 */
export async function publishUserStatus(
  session: RelaySession,
  input: { text: string; emoji: string; selfPubkey: string | null },
): Promise<PublishStatusResult> {
  const body = buildUserStatusEvent(input.text, input.emoji);
  const event = await signNostrEvent(body);
  const self = input.selfPubkey;
  const previous = self ? (optimistic.get(self) ?? null) : null;
  if (self) {
    const emoji = body.tags.find((tag) => tag[0] === "emoji")?.[1] ?? "";
    const cleared = body.content === "" && emoji === "";
    setOptimistic(self, {
      at: event.created_at,
      status: cleared
        ? null
        : {
            text: body.content,
            emoji,
            updatedAt: event.created_at,
            expiresAt: null,
          },
    });
  }
  const result = await session.publish(event);
  if (!result.ok && self) {
    setOptimistic(self, previous);
  }
  return { ok: result.ok, message: result.message };
}
