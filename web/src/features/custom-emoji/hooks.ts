/**
 * React access to the community custom-emoji palette.
 *
 * Deliberately provider-free. The palette is one list per relay and every
 * message row wants it, so it lives in a module store (lib/paletteStore.ts)
 * that holds a single REQ; a context provider would have to be mounted in
 * `App.tsx` and every consumer would still read the same one list.
 */

import { useEffect, useSyncExternalStore } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { communityEmojiFilter, type CustomEmoji } from "./lib/customEmoji.ts";
import {
  createPaletteStore,
  type AuthoredEmojiSetEvent,
  type PaletteRelaySource,
} from "./lib/paletteStore.ts";

/**
 * The one palette store for the app.
 *
 * Exported, not module-private: the store is plain (non-React) state, and
 * anything outside a component tree that needs the palette — or needs to point
 * it at a different event source — should reach it here rather than through a
 * hook it cannot call.
 */
export const customEmojiPaletteStore = createPaletteStore(
  communityEmojiFilter(),
);

const store = customEmojiPaletteStore;

type Session = ReturnType<typeof useRelaySession>["session"];

/**
 * One adapter per session, cached.
 *
 * `attach` compares sources by identity to decide whether the community
 * changed, so building a fresh adapter object on every effect run would tear
 * the subscription down and reopen it on every render of every consumer.
 */
const sources = new WeakMap<object, PaletteRelaySource>();

function sourceFor(session: Session): PaletteRelaySource {
  const cached = sources.get(session);
  if (cached) {
    return cached;
  }
  // RelaySession.subscribe takes a typed NostrFilter and yields typed events;
  // the store is written against the narrower shape it actually reads, so it
  // can be tested without a relay at all.
  const source: PaletteRelaySource = {
    subscribe: (filter, handlers) =>
      session.subscribe(filter as Parameters<typeof session.subscribe>[0], {
        onEvent: (event: SignedNostrEvent) =>
          handlers.onEvent(event as AuthoredEmojiSetEvent),
      }),
  };
  sources.set(session, source);
  return source;
}

/**
 * The community palette, live. Empty until the relay session is open and the
 * first kind:30030 arrives — every consumer already handles an empty palette
 * (nothing to render, nothing to offer), so there is no loading state.
 */
export function useCustomEmoji(): CustomEmoji[] {
  const { session, status } = useRelaySession();

  useEffect(() => {
    if (status !== "open") {
      return;
    }
    store.attach(sourceFor(session));
  }, [session, status]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
