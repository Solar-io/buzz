import type { NostrFilter } from "@/shared/lib/nostr-client";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { initialSyncFilters } from "./timelineCache.ts";
import { syncCursor, type TimelineStore } from "./timelineStore.ts";

/**
 * Idle prefetch of the few conversations the user is most likely to open
 * next (background-sync plan §4.3). A prefetch is ONE delta REQ since the
 * store entry's cursor — the same filter the timeline itself would send —
 * at background priority, applied in sync mode (it IS contiguous since the
 * cursor, so it may advance it), closed on EOSE. No live subs are kept: the
 * activity feed already keeps kind 9 warm, and extra live subs would add
 * relay-limiter risk for little gain.
 */

/** Conversations considered per prefetch pass. */
export const PREFETCH_TOP_N = 6;
/** Prefetch REQs allowed per rolling minute. */
export const PREFETCH_PER_MINUTE = 12;
const PREFETCH_WINDOW_MS = 60_000;
/** A prefetch whose EOSE never comes is abandoned after this long. */
const PREFETCH_TIMEOUT_MS = 15_000;

/** One conversation's newest known activity (unix seconds). */
export interface RecencySample {
  id: string;
  at: number;
}

/**
 * Pick what to prefetch: the top {@link PREFETCH_TOP_N} conversations by
 * merged recency (channels and DMs together), minus the open one and any
 * whose store entry is already synced through that activity (fresh).
 * A warm-only row does not make an entry fresh — its cursor has not moved,
 * so a delta still has reactions/edits/other kinds to bring.
 */
export function selectPrefetchCandidates(
  samples: RecencySample[],
  store: Pick<TimelineStore, "peek">,
  openId: string | null,
  limit = PREFETCH_TOP_N,
): string[] {
  const newest = new Map<string, number>();
  for (const { id, at } of samples) {
    if (at > 0 && at > (newest.get(id) ?? 0)) {
      newest.set(id, at);
    }
  }
  const ranked = [...newest.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
  return ranked
    .filter(([id, at]) => {
      if (id === openId) {
        return false;
      }
      const entry = store.peek(id);
      return !entry || entry.cursor < at;
    })
    .map(([id]) => id);
}

/** Rolling-window request budget (≤ `max` per `windowMs`). */
export interface PrefetchBudget {
  /** Spend one request if the window allows; false when exhausted. */
  take(): boolean;
}

export function createPrefetchBudget(
  now: () => number = () => Date.now(),
  max = PREFETCH_PER_MINUTE,
  windowMs = PREFETCH_WINDOW_MS,
): PrefetchBudget {
  const spent: number[] = [];
  return {
    take() {
      const t = now();
      while (spent.length > 0 && t - spent[0] >= windowMs) {
        spent.shift();
      }
      if (spent.length >= max) {
        return false;
      }
      spent.push(t);
      return true;
    },
  };
}

/** The slice of RelaySession a prefetch needs. */
export interface PrefetchSession {
  subscribe(
    filters: NostrFilter | NostrFilter[],
    options: {
      onEvent: (event: SignedNostrEvent) => void;
      onEose?: () => void;
      priority?: "critical" | "foreground" | "background";
    },
  ): () => void;
}

const inFlight = new Set<string>();

/**
 * One delta REQ for `channelId` into the store. `priority` is "background"
 * for idle prefetch; the push-tap path uses "foreground" so a cold
 * channel's delta is the first thing on the wire after AUTH. Skips the
 * open (owned) channel — its own sync sub already covers it — and a
 * channel with a prefetch already in flight.
 */
export async function prefetchTimeline(
  store: Pick<TimelineStore, "load" | "apply" | "isOwned">,
  session: PrefetchSession,
  channelId: string,
  priority: "background" | "foreground" = "background",
): Promise<void> {
  if (inFlight.has(channelId) || store.isOwned(channelId)) {
    return;
  }
  inFlight.add(channelId);
  let entry;
  try {
    entry = await store.load(channelId);
  } catch {
    inFlight.delete(channelId);
    return;
  }
  let unsubscribe: (() => void) | null = null;
  let finished = false;
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(timer);
    inFlight.delete(channelId);
    unsubscribe?.();
  };
  const timer = setTimeout(finish, PREFETCH_TIMEOUT_MS);
  unsubscribe = session.subscribe(
    initialSyncFilters(channelId, syncCursor(entry)),
    {
      onEvent: (event) =>
        store.apply(channelId, event, { source: "prefetch" }),
      onEose: finish,
      priority,
    },
  );
  if (finished) {
    // A shared sub replayed its EOSE synchronously.
    unsubscribe();
  }
}
