/**
 * React access to the community custom-emoji palette.
 *
 * Deliberately provider-free. The palette is one list per relay and every
 * message row wants it, so it lives in a module store (lib/paletteStore.ts)
 * that holds a single REQ; a context provider would have to be mounted in
 * `App.tsx` and every consumer would still read the same one list.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import { subscribeAuth } from "@/shared/lib/key-store";
import { communityEmojiFilter, type CustomEmoji } from "./lib/customEmoji.ts";
import { fetchOwnEmoji, publishOwnEmojiSet } from "./lib/ownEmojiApi.ts";
import {
  addOwnEmoji,
  emojiEditMessage,
  removeOwnEmoji,
  renameOwnEmoji,
} from "./lib/ownEmojiSet.ts";
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

/**
 * The caller's OWN editable set — the only thing the settings card may change.
 *
 * Distinct from the community union above, and deliberately a react-query
 * snapshot rather than a live store: the card reads it, computes a new set
 * from it, and republishes. A live value would change under an in-progress
 * edit for no benefit, since the caller's own publishes are the only thing
 * that can change it and every mutation invalidates it.
 */
export const ownCustomEmojiQueryKey = ["custom-emoji-own"] as const;

export function useOwnCustomEmojiQuery() {
  const { session, status } = useRelaySession();
  const [self, setSelf] = useState<string | null>(null);

  /**
   * Resolve our own pubkey, and RE-resolve it whenever the auth state moves.
   *
   * `ownPubkey()` is async but reads synchronous module state that the key
   * store fills in from IndexedDB after the app mounts — so sampling it once
   * in a mount effect returns null on any load where the restore has not
   * landed yet, and never corrects. Measured against the dev relay on
   * 2026-09-04: the card said "You have not added any emoji yet" while the
   * caller's own emoji sat in the community list, because this query stayed
   * disabled and its fetch never ran even once.
   *
   * `subscribeAuth` is the store's own signal that the answer changed. It is
   * also what makes signing out and back in as someone else show the right
   * set rather than the previous account's.
   */
  useEffect(() => {
    let cancelled = false;
    const resolve = () => {
      void ownPubkey().then((pubkey) => {
        if (!cancelled) setSelf(pubkey);
      });
    };
    resolve();
    const unsubscribe = subscribeAuth(resolve);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return useQuery<CustomEmoji[]>({
    queryKey: [...ownCustomEmojiQueryKey, self],
    queryFn: () => fetchOwnEmoji(session, self as string),
    enabled: self !== null && status === "open",
    staleTime: 60_000,
  });
}

/** What a mutation does to the caller's own set, before publishing it. */
export type OwnEmojiEdit =
  | { type: "add"; shortcode: string; url: string }
  | { type: "rename"; from: string; to: string }
  | { type: "remove"; shortcode: string };

function applyEdit(own: CustomEmoji[], edit: OwnEmojiEdit) {
  switch (edit.type) {
    case "add":
      return addOwnEmoji(own, edit.shortcode, edit.url);
    case "rename":
      return renameOwnEmoji(own, edit.from, edit.to);
    case "remove":
      return removeOwnEmoji(own, edit.shortcode);
  }
}

/**
 * Apply one edit to my own set and republish it.
 *
 * The set is re-read immediately before the edit rather than taken from the
 * cached query. A 30030 is parameterized-replaceable, so publishing a set
 * computed from a stale read does not merge — it OVERWRITES, and an emoji
 * added in another tab thirty seconds ago would vanish without an error
 * anywhere. The extra round trip is the price of not doing that.
 */
export function useEditOwnCustomEmoji() {
  const { session } = useRelaySession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (edit: OwnEmojiEdit) => {
      const self = await ownPubkey();
      if (!self) {
        throw new Error("Sign in before changing custom emoji.");
      }
      const own = await fetchOwnEmoji(session, self);
      const result = applyEdit(own, edit);
      if (!result.ok) {
        throw new Error(emojiEditMessage(result.error));
      }
      await publishOwnEmojiSet(session, result.next);
      return result.shortcode;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ownCustomEmojiQueryKey,
      });
    },
  });
}
