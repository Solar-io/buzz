/**
 * Subscription sharing for {@link RelaySession} (plan item 2.2, 2026-09-26).
 *
 * Twenty-odd call sites open their own REQ for the same filter (the kind-0
 * profile batch was measured at ~40 identical REQs in 4 s), and every one of
 * them queues behind the boot replay. A group is one wire subscription with a
 * listener fan-out: identical filters (canonical JSON) share it, and a
 * listener that joins late is replayed the events the group has already
 * received before it goes live.
 *
 * Sharing is open only until the group's first EOSE. A join before EOSE sees
 * exactly what its own fresh REQ would have (the stored set, then EOSE, then
 * live). After EOSE it would not: several kinds have no live fan-out (kind
 * 39000, `#p`-only filters), and callers re-subscribe on purpose to re-read
 * them — `useChannels`' refresh after creating a channel is the canonical
 * case. So an identical subscribe after EOSE opens its own wire sub, as it
 * always did, and the group drops its buffer.
 *
 * The buffer is also bounded. A group that outgrows it before EOSE stops
 * being shareable, so a huge initial push cannot pin memory for a
 * hypothetical late joiner.
 *
 * Pure and framework-free, so `node --test` loads it directly.
 */

import type { SignedNostrEvent } from "../lib/nostr-signer.ts";

/** Events a group buffers for late joiners before it stops being shareable. */
export const SHARE_BUFFER_MAX = 500;

export interface ShareListener {
  onEvent: (event: SignedNostrEvent) => void;
  onEose?: () => void;
}

interface ListenerEntry {
  listener: ShareListener;
  /** False until a late joiner's buffered replay has run. */
  live: boolean;
}

/**
 * Canonical key for a filter (or OR'd filter list): object keys sorted,
 * primitive arrays sorted (filter arrays are sets — `authors`, `kinds`,
 * `#h` — so order never changes what the relay returns).
 */
export function canonicalFilterKey(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonicalize);
    const primitive = items.every(
      (item) => item === null || typeof item !== "object",
    );
    if (primitive) {
      return [...items].sort((a, b) =>
        String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0,
      );
    }
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export class SharedSubscription {
  readonly key: string;
  private readonly entries = new Set<ListenerEntry>();
  private buffer: SignedNostrEvent[] = [];
  private seen = new Set<string>();
  private eosed = false;
  private overflowed = false;

  constructor(key: string) {
    this.key = key;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Joinable: no EOSE yet, and the buffer never overflowed. */
  get shareable(): boolean {
    return !this.eosed && !this.overflowed;
  }

  /** The founding listener: live at once (the wire REQ has not gone out). */
  found(listener: ShareListener): () => boolean {
    const entry: ListenerEntry = { listener, live: true };
    this.entries.add(entry);
    return () => this.entries.delete(entry);
  }

  /**
   * Add a late joiner. Its replay runs on a microtask: the caller has not
   * even received its unsubscribe handle yet, and no socket message can be
   * processed between here and the microtask, so replay-then-go-live is
   * gap-free and never double-delivers.
   *
   * Returns the entry's remover.
   */
  join(listener: ShareListener): () => boolean {
    const entry: ListenerEntry = { listener, live: false };
    this.entries.add(entry);
    queueMicrotask(() => {
      if (!this.entries.has(entry)) {
        return;
      }
      for (const event of this.buffer) {
        listener.onEvent(event);
      }
      entry.live = true;
    });
    return () => this.entries.delete(entry);
  }

  /** Fan-out target for the wire subscription's events. */
  readonly onEvent = (event: SignedNostrEvent): void => {
    if (this.shareable && !this.seen.has(event.id)) {
      if (this.buffer.length >= SHARE_BUFFER_MAX) {
        this.overflowed = true;
        this.dropBuffer();
      } else {
        this.seen.add(event.id);
        this.buffer.push(event);
      }
    }
    for (const entry of [...this.entries]) {
      if (entry.live) {
        entry.listener.onEvent(event);
      }
    }
  };

  /** Fan-out target for the wire subscription's EOSE. */
  readonly onEose = (): void => {
    this.eosed = true;
    this.dropBuffer();
    for (const entry of [...this.entries]) {
      if (entry.live) {
        entry.listener.onEose?.();
      }
    }
  };

  private dropBuffer(): void {
    this.buffer = [];
    this.seen = new Set();
  }
}
