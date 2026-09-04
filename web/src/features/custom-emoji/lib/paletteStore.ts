/**
 * The community custom-emoji palette, as one process-wide store.
 *
 * Every render site needs the palette — the picker, the message body, the
 * reaction chips — and there is exactly one palette per relay. A per-consumer
 * hook would open one REQ per mounted message, so this holds a single live
 * subscription and fans it out through `useSyncExternalStore`.
 *
 * The relay keeps only the latest kind:30030 per `(pubkey, d_tag)`, but a LIVE
 * subscription still delivers a member's replacement alongside the copy it
 * already delivered. So events are held per author, newest wins, and the
 * palette is the union over those survivors: an emoji a member REMOVES from
 * their set disappears, instead of lingering because an older event is still
 * in the accumulator.
 */

import {
  unionCustomEmoji,
  type CustomEmoji,
  type EmojiSetEvent,
} from "./customEmoji.ts";

/** The subset of a 30030 event the store keeps. */
export interface AuthoredEmojiSetEvent extends EmojiSetEvent {
  pubkey: string;
}

/**
 * Fold one event into the per-author accumulator.
 *
 * Returns the SAME map reference when the event changes nothing (a replay of
 * an event already held, or one older than the author's current set), so a
 * caller can skip the re-render.
 */
export function mergeEmojiSetEvent(
  events: ReadonlyMap<string, AuthoredEmojiSetEvent>,
  event: AuthoredEmojiSetEvent,
): ReadonlyMap<string, AuthoredEmojiSetEvent> {
  const held = events.get(event.pubkey);
  if (held && held.created_at >= event.created_at) {
    return events;
  }
  const next = new Map(events);
  next.set(event.pubkey, event);
  return next;
}

/** Palette for a set of accumulated events, sorted by shortcode. */
export function paletteFromEvents(
  events: ReadonlyMap<string, AuthoredEmojiSetEvent>,
): CustomEmoji[] {
  return unionCustomEmoji([...events.values()]);
}

/** What the store needs from a relay session — the whole surface it uses. */
export interface PaletteRelaySource {
  subscribe(
    filter: Record<string, unknown>,
    handlers: { onEvent: (event: AuthoredEmojiSetEvent) => void },
  ): () => void;
}

export interface PaletteStore {
  /**
   * Point the store at a relay session. Idempotent for the same source;
   * a different source tears the old subscription down and starts empty,
   * which is what a community switch has to do.
   */
  attach(source: PaletteRelaySource | null): void;
  subscribe(listener: () => void): () => void;
  /** Stable reference between changes — safe for `useSyncExternalStore`. */
  getSnapshot(): CustomEmoji[];
}

const EMPTY: CustomEmoji[] = [];

export function createPaletteStore(
  filter: Record<string, unknown>,
): PaletteStore {
  let source: PaletteRelaySource | null = null;
  let unsubscribe: (() => void) | null = null;
  let events: ReadonlyMap<string, AuthoredEmojiSetEvent> = new Map();
  let snapshot: CustomEmoji[] = EMPTY;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const open = () => {
    if (unsubscribe || !source) {
      return;
    }
    unsubscribe = source.subscribe(filter, {
      onEvent: (event) => {
        const next = mergeEmojiSetEvent(events, event);
        if (next === events) {
          return;
        }
        events = next;
        snapshot = paletteFromEvents(events);
        emit();
      },
    });
  };

  return {
    attach(next) {
      if (next === source) {
        open();
        return;
      }
      unsubscribe?.();
      unsubscribe = null;
      source = next;
      events = new Map();
      if (snapshot.length > 0) {
        snapshot = EMPTY;
        emit();
      }
      open();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
  };
}
