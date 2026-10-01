/**
 * Cross-device sidebar favorites — the lifecycle half of `favoritesSync.ts`.
 *
 * One engine per (relay session, identity). It holds one open REQ for the
 * viewer's own `d="sidebar-favorites"` event (boot AND live: another
 * device's later change arrives on the same subscription), merges every copy
 * it sees into the localStorage prefs, and publishes this device's merged set
 * whenever it is ahead of the relay's.
 *
 * Local-first, like read-state sync: localStorage stays the offline cache
 * and the UI never waits on the relay. A relay that refuses the publish
 * (`publish()` RESOLVES `{ok:false}`, it does not throw) leaves the local set
 * untouched and retries with backoff; a copy this device cannot decrypt
 * (a NIP-07-only session, a future blob version) switches sync off for the
 * session rather than overwrite what it cannot read.
 *
 * Dependencies are injected so `node --test` drives it without a socket.
 */

import type { ChannelPrefs } from "./channelPrefs.ts";
import {
  FAVORITES_D_TAG,
  type FavoritesBlob,
  KIND_FAVORITES,
  blobFromPrefs,
  buildFavoritesEventTags,
  canonicalFavoritesBlob,
  mergeFavorites,
  nextFavoritesCreatedAt,
  parseFavoritesBlob,
  planFavoritesSync,
  prefsWithBlob,
} from "./favoritesSync.ts";

/** The subset of a signed event the engine reads and publishes. */
export interface FavoritesEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface FavoritesSyncDeps {
  pubkey: string;
  subscribe: (
    filter: Record<string, unknown>,
    options: {
      onEvent: (event: FavoritesEvent) => void;
      onEose?: () => void;
    },
  ) => () => void;
  /** Resolves `{ok:false}` on a refusal or timeout; may also throw. */
  publish: (event: FavoritesEvent) => Promise<{ ok: boolean; message: string }>;
  decrypt: (ciphertext: string, pubkey: string) => Promise<string>;
  encrypt: (plaintext: string, pubkey: string) => Promise<string>;
  sign: (template: {
    kind: number;
    tags: string[][];
    content: string;
    created_at: number;
  }) => Promise<FavoritesEvent>;
  loadPrefs: () => ChannelPrefs;
  savePrefs: (prefs: ChannelPrefs) => void;
  /** The merge changed this device's favorites (re-read localStorage). */
  onLocalSynced: () => void;
  /** Schedule `fn` after `ms`; returns a cancel. */
  schedule: (fn: () => void, ms: number) => () => void;
  nowMs: () => number;
  log?: (message: string, detail?: unknown) => void;
}

/** Debounce a local toggle burst into one publish. */
export const FAVORITES_PUBLISH_DEBOUNCE_MS = 800;
/** First retry after a refused publish; doubles to the cap. */
export const FAVORITES_RETRY_BASE_MS = 5_000;
export const FAVORITES_RETRY_MAX_MS = 120_000;

export type FavoritesSyncStatus =
  | "loading"
  | "synced"
  | "pending"
  | "retrying"
  | "off";

export interface FavoritesSync {
  /** A favorite was toggled on this device. */
  noteLocalChange: () => void;
  status: () => FavoritesSyncStatus;
  /** Settles once the current reconcile/publish chain has drained. */
  idle: () => Promise<void>;
  dispose: () => void;
}

function dTag(event: FavoritesEvent): string | null {
  const tag = event.tags.find((entry) => entry[0] === "d");
  return typeof tag?.[1] === "string" ? tag[1] : null;
}

export function createFavoritesSync(deps: FavoritesSyncDeps): FavoritesSync {
  const log = deps.log ?? (() => {});
  let disposed = false;
  let loaded = false;
  let off = false;
  /** The newest relay event seen (the coordinate's current winner). */
  let newest: FavoritesEvent | null = null;
  let maxSeenCreatedAt = 0;
  /** The decrypted relay copy as of the last reconcile or our last publish. */
  let remoteBlob: FavoritesBlob | null = null;
  let failures = 0;
  let cancelTimer: (() => void) | null = null;
  let status: FavoritesSyncStatus = "loading";
  /** Serializes reconcile and publish so neither reads a half-applied state. */
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work).catch((error) => {
      log("favorites sync step failed", error);
    });
  };

  const schedulePublish = (ms: number) => {
    if (disposed || off) {
      return;
    }
    cancelTimer?.();
    cancelTimer = deps.schedule(() => {
      cancelTimer = null;
      enqueue(publish);
    }, ms);
  };

  const switchOff = (why: string, detail?: unknown) => {
    off = true;
    status = "off";
    cancelTimer?.();
    cancelTimer = null;
    log(`favorites sync off: ${why}`, detail);
  };

  /** Merge the relay's newest copy into localStorage; publish if we lead. */
  const reconcile = async () => {
    if (disposed || off || !loaded) {
      return;
    }
    const event = newest;
    let remote: FavoritesBlob | null = null;
    if (event) {
      let parsed: ReturnType<typeof parseFavoritesBlob>;
      try {
        parsed = parseFavoritesBlob(
          JSON.parse(await deps.decrypt(event.content, event.pubkey)),
        );
      } catch (error) {
        switchOff("relay copy unreadable on this device", error);
        return;
      }
      if (!parsed.ok) {
        switchOff(`relay copy ${parsed.reason}`);
        return;
      }
      remote = parsed.blob;
    }
    if (disposed) {
      return;
    }
    remoteBlob = remote;
    const local = deps.loadPrefs();
    const plan = planFavoritesSync(remote, blobFromPrefs(local));
    if (plan.localChanged) {
      deps.savePrefs(prefsWithBlob(local, plan.merged));
      deps.onLocalSynced();
    }
    if (plan.publish) {
      status = "pending";
      schedulePublish(0);
    } else if (status !== "retrying") {
      status = "synced";
    }
  };

  const publish = async () => {
    if (disposed || off || !loaded) {
      return;
    }
    const local = deps.loadPrefs();
    const localBlob = blobFromPrefs(local);
    // Fold in the last relay copy once more: a toggle made before the boot
    // reconcile finished must still merge, never replace.
    const blob = mergeFavorites(remoteBlob, localBlob);
    const text = canonicalFavoritesBlob(blob);
    if (text !== canonicalFavoritesBlob(localBlob)) {
      deps.savePrefs(prefsWithBlob(local, blob));
      deps.onLocalSynced();
    }
    if (remoteBlob && text === canonicalFavoritesBlob(remoteBlob)) {
      failures = 0;
      status = "synced";
      return;
    }
    let content: string;
    try {
      content = await deps.encrypt(text, deps.pubkey);
    } catch (error) {
      switchOff("cannot seal favorites with this signer", error);
      return;
    }
    const createdAt = nextFavoritesCreatedAt(
      maxSeenCreatedAt,
      deps.nowMs() / 1000,
    );
    maxSeenCreatedAt = createdAt;
    let result: { ok: boolean; message: string };
    try {
      const event = await deps.sign({
        kind: KIND_FAVORITES,
        tags: buildFavoritesEventTags(),
        content,
        created_at: createdAt,
      });
      result = await deps.publish(event);
    } catch (error) {
      result = {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (disposed) {
      return;
    }
    if (result.ok) {
      remoteBlob = blob;
      failures = 0;
      status = "synced";
      return;
    }
    // Refused: the local set stays exactly as it is; try again later.
    failures += 1;
    status = "retrying";
    const delay = Math.min(
      FAVORITES_RETRY_MAX_MS,
      FAVORITES_RETRY_BASE_MS * 2 ** (failures - 1),
    );
    log(`favorites publish refused (${result.message}); retry in ${delay}ms`);
    schedulePublish(delay);
  };

  const unsubscribe = deps.subscribe(
    {
      kinds: [KIND_FAVORITES],
      authors: [deps.pubkey],
      "#d": [FAVORITES_D_TAG],
      limit: 1,
    },
    {
      onEvent: (event) => {
        if (
          disposed ||
          event.pubkey !== deps.pubkey ||
          event.kind !== KIND_FAVORITES ||
          dTag(event) !== FAVORITES_D_TAG
        ) {
          return;
        }
        maxSeenCreatedAt = Math.max(maxSeenCreatedAt, event.created_at);
        if (newest && newest.created_at >= event.created_at) {
          return;
        }
        newest = event;
        if (loaded) {
          enqueue(reconcile);
        }
      },
      onEose: () => {
        if (disposed || loaded) {
          return;
        }
        loaded = true;
        enqueue(reconcile);
      },
    },
  );

  return {
    noteLocalChange() {
      if (disposed || off || !loaded) {
        // Before EOSE the boot reconcile reads localStorage anyway.
        return;
      }
      status = "pending";
      schedulePublish(FAVORITES_PUBLISH_DEBOUNCE_MS);
    },
    status: () => status,
    idle: () => chain,
    dispose() {
      disposed = true;
      cancelTimer?.();
      cancelTimer = null;
      unsubscribe();
    },
  };
}
