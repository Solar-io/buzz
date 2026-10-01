import { useEffect, useRef } from "react";
import type { RelaySession } from "@/shared/api/relay-session";
import type { NostrFilter } from "@/shared/lib/nostr-client";
import {
  nip44DecryptFrom,
  nip44EncryptTo,
  signNostrEvent,
  type SignedNostrEvent,
} from "@/shared/lib/nostr-signer";
import {
  type ChannelPrefs,
  loadChannelPrefs,
  saveChannelPrefs,
} from "./channelPrefs.ts";
import { blobFromPrefs, canonicalFavoritesBlob } from "./favoritesSync.ts";
import {
  type FavoritesSync,
  createFavoritesSync,
} from "./favoritesSyncEngine.ts";

/**
 * React wiring for cross-device favorites (`favoritesSyncEngine.ts`), kept
 * out of repos.tsx (file-size ceiling) like `useReadStateSync`.
 *
 * One engine per (session, identity): a new relay session or a different
 * signed-in key disposes the old engine and boots a fresh one, so nothing
 * from one identity's set leaks into another's. The web client has no
 * in-app community switch (one relay per origin); the session key is what
 * would change if it gained one.
 *
 * `prefs` is the shell's React copy. Every change to its favorites that the
 * engine did not itself write is a local toggle and is published.
 */
export function useFavoritesSync(options: {
  session: RelaySession | null;
  selfPubkey: string | null;
  prefs: ChannelPrefs;
  /** The merge wrote new favorites to localStorage: re-read them. */
  onSynced: () => void;
}): void {
  const { session, selfPubkey, prefs } = options;
  const onSyncedRef = useRef(options.onSynced);
  onSyncedRef.current = options.onSynced;
  const engineRef = useRef<FavoritesSync | null>(null);

  useEffect(() => {
    if (!session || !selfPubkey) {
      return;
    }
    const engine = createFavoritesSync({
      pubkey: selfPubkey,
      subscribe: (filter, handlers) =>
        session.subscribe(filter as NostrFilter, handlers),
      // Every event the engine publishes came from `sign` below.
      publish: (event) => session.publish(event as SignedNostrEvent),
      decrypt: async (ciphertext, pubkey) =>
        (await nip44DecryptFrom(ciphertext, pubkey)).plaintext,
      encrypt: async (plaintext, pubkey) =>
        (await nip44EncryptTo(plaintext, pubkey)).ciphertext,
      sign: (template) => signNostrEvent(template),
      loadPrefs: loadChannelPrefs,
      savePrefs: saveChannelPrefs,
      onLocalSynced: () => onSyncedRef.current(),
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      nowMs: () => Date.now(),
      log: (message, detail) => console.debug(`[favorites] ${message}`, detail),
    });
    engineRef.current = engine;
    return () => {
      engine.dispose();
      if (engineRef.current === engine) {
        engineRef.current = null;
      }
    };
  }, [session, selfPubkey]);

  // A local toggle: the favorites part of `prefs` changed. The engine's own
  // writes reach here too (via onSynced → re-read) and publish nothing,
  // because the engine skips a set the relay already holds.
  const favoritesText = canonicalFavoritesBlob(blobFromPrefs(prefs));
  const firstRef = useRef(true);
  useEffect(() => {
    void favoritesText;
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    engineRef.current?.noteLocalChange();
  }, [favoritesText]);
}
