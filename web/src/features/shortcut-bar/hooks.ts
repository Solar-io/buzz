import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { RelaySession } from "@/shared/api/relay-session";
import type { NostrFilter } from "@/shared/lib/nostr-client";
import { subscribeAuth } from "@/shared/lib/key-store";
import {
  activeSignerSource,
  nip44DecryptFrom,
  nip44EncryptTo,
  ownPubkey,
  signNostrEvent,
  type SignedNostrEvent,
} from "@/shared/lib/nostr-signer";

import {
  SHORTCUT_BLOB_BUDGET_BYTES,
  SHORTCUT_BUDGET_MESSAGE,
  type ShortcutBarBlob,
  type ShortcutDef,
  emptyShortcutBlob,
  serializeShortcutBlob,
  sidebarShortcuts,
} from "./lib/shortcutBlob.ts";
import {
  KIND_SHORTCUT_BAR,
  buildShortcutEventTags,
  nextShortcutCreatedAt,
} from "./lib/shortcutEvent.ts";
import { createLinksStore } from "./lib/linksStore.ts";
import {
  linkStorageMode,
  mutateLocalLinks,
  readLocalLinks,
} from "./lib/localLinkStore.ts";

/**
 * The sidebar shortcuts, relay-backed — with a device-local fallback.
 *
 * The data is ONE kind-30078 event per user (NIP-78, `d="shortcut-bar"`),
 * NIP-44-encrypted to self, holding every list. The shape and LWW rules live
 * in `lib/shortcutEvent.ts`; this file is the subscription, the decrypt, and
 * the optimistic write overlay.
 *
 * The list this hook exposes is the CHANNEL-INDEPENDENT one, stored under the
 * reserved `__sidebar__` key — it is what the sidebar renders. Earlier builds
 * stored a list per channel in the same blob; those keys are still read,
 * written and preserved untouched, they are simply no longer rendered.
 *
 * Writes are whole-blob replacement with last-write-wins on `created_at`
 * (desktop `readStateManager.ts` pattern): two devices editing between syncs
 * means the second publish silently wins. Acceptable for a single-user
 * config surface, and documented as such in the design rather than
 * "solved" with a merge nobody asked for.
 *
 * STORAGE BRANCH (`lib/localLinkStore.ts`): with the unlocked local key the
 * blob above is the store, exactly as before. With any other signer
 * (extension, web-auth, ephemeral) NIP-44-to-self has no path, and the same
 * `ShortcutDef[]` list is served from `localStorage` instead — same reducers,
 * same caps, per-device. The two stores are separate by design and never
 * merged or migrated; `canUse` stays exposed so callers know which one is
 * live. A blob this device cannot decrypt blocks only the BLOB store (the
 * toast below); the local list is always renderable and editable.
 */

/**
 * The one shared Links source: one relay subscription and one decrypt for
 * every reader (sidebar, web layer, settings), painted from a per-pubkey
 * seed before the relay answers. See `lib/linksStore.ts`.
 */
const linksStore = createLinksStore({
  subscribe: (filter, options) =>
    currentSession
      ? currentSession.subscribe(filter as NostrFilter, options)
      : () => {},
  decrypt: async (content, pubkey) =>
    (await nip44DecryptFrom(content, pubkey)).plaintext,
  storage: () => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  },
});
/** The session the store's next subscribe uses (set just before acquire). */
let currentSession: RelaySession | null = null;
const sessionIds = new WeakMap<RelaySession, string>();
let nextSessionId = 0;
function sessionId(session: RelaySession): string {
  let id = sessionIds.get(session);
  if (!id) {
    nextSessionId += 1;
    id = `session-${nextSessionId}`;
    sessionIds.set(session, id);
  }
  return id;
}
const EMPTY_BLOB = emptyShortcutBlob();

/** Shown while the relay copy has not arrived; writing over a seed could
 * clobber an edit made on another device since the seed was taken. */
const LINKS_LOADING_MESSAGE =
  "Links are still loading from the relay — try again in a moment.";

/** The bar needs the UNLOCKED LOCAL key — NIP-44-to-self has no NIP-07 path. */
const NEED_LOCAL_KEY_MESSAGE =
  "Shortcuts need your unlocked local key — sign in with it to use them.";

/** Shown (and write-blocking) when the stored blob cannot be opened here. */
export const SHORTCUT_BLOCKED_MESSAGE =
  "Shortcut data unreadable on this device — not changing it, so nothing is lost.";

export interface ShortcutMutation {
  ok: boolean;
  /** Human-readable reason when `ok` is false; null on success. */
  message: string | null;
}

type BlobTransform =
  | { ok: true; blob: ShortcutBarBlob }
  | { ok: false; reason: string };

/**
 * Shortcuts the viewer has just published, held until the relay echoes them.
 *
 * Module scope rather than component state, mirroring `user-status/hooks.ts`:
 * every reader updates together, and a later mount still sees the write.
 */
interface OptimisticEntry {
  blob: ShortcutBarBlob;
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
 * Which signer is live, re-resolved when the auth store says it changed.
 * `activeSignerSource()` reads synchronous module state that lands after
 * mount, so a one-shot read at first render answers "ephemeral" for a
 * session that is about to be local — and would hide the bar from exactly
 * the person it belongs to.
 */
function useActiveSignerSource(): "local" | "extension" | "ephemeral" {
  const [source, setSource] = useState(activeSignerSource);
  useEffect(() => {
    const update = () => setSource(activeSignerSource());
    update();
    return subscribeAuth(update);
  }, []);
  return source;
}

export interface ShortcutBar {
  /** The sidebar shortcuts — the blob's list, or the device-local one. */
  shortcuts: ShortcutDef[];
  /** True only when the unlocked local key is live (the storage branch). */
  canUse: boolean;
  /** The stored blob exists but is unreadable or from a newer version. */
  blocked: boolean;
  blockedMessage: string | null;
  /**
   * Read → transform → budget-check → encrypt → sign → optimistic → publish,
   * rolling the optimistic entry back if the relay refuses. In fallback mode
   * the same transform runs against the localStorage list instead.
   */
  mutateShortcuts: (
    fn: (blob: ShortcutBarBlob) => BlobTransform,
  ) => Promise<ShortcutMutation>;
}

function blobByteLength(plaintext: string): number {
  return new TextEncoder().encode(plaintext).length;
}

async function publishQuietly(
  session: RelaySession,
  event: SignedNostrEvent,
): Promise<{ ok: boolean; message: string }> {
  try {
    return await session.publish(event);
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "The relay refused the save.",
    };
  }
}

export function useShortcutBar(): ShortcutBar {
  const { session } = useRelaySession();
  const signer = useActiveSignerSource();
  const [selfPubkey, setSelfPubkey] = useState<string | null>(null);

  // Resolve the self pubkey reactively: it gates both the subscription's
  // `authors` filter and the encrypt-to-self coordinate.
  useEffect(() => {
    const cancelled = false;
    const resolve = () => {
      void ownPubkey().then((pubkey) => {
        if (!cancelled) {
          setSelfPubkey(pubkey);
        }
      });
    };
    resolve();
    return subscribeAuth(resolve);
  }, []);

  // One shared REQ + decrypt for every reader (see linksStore).
  useEffect(() => {
    if (!selfPubkey) {
      return;
    }
    currentSession = session;
    return linksStore.acquire(
      sessionId(session),
      selfPubkey,
      signer === "local",
    );
  }, [session, selfPubkey, signer]);
  const links = useSyncExternalStore(
    linksStore.subscribe,
    linksStore.getSnapshot,
    linksStore.getSnapshot,
  );
  const mine = links.pubkey !== null && links.pubkey === selfPubkey;
  const newest = mine ? links.newest : null;
  const relayState = useMemo(
    () =>
      mine && signer === "local"
        ? { blob: links.blob, blocked: links.blocked }
        : { blob: EMPTY_BLOB, blocked: false },
    [mine, signer, links.blob, links.blocked],
  );
  const relayLoaded = mine && links.loaded;

  const optimisticStamp = useSyncExternalStore(
    subscribeOptimistic,
    optimisticSnapshot,
    optimisticSnapshot,
  );

  // Overlay the pending local write onto what the relay told us. The relay
  // wins as soon as its copy is at least as new as ours — that is what makes
  // this an optimistic write rather than a shadow copy that never yields.
  const blob = useMemo(() => {
    void optimisticStamp;
    const entry = selfPubkey ? optimistic.get(selfPubkey) : undefined;
    if (entry && (!newest || entry.at > newest.created_at)) {
      return entry.blob;
    }
    return relayState.blob;
  }, [selfPubkey, newest, relayState, optimisticStamp]);

  const canUse = signer === "local";
  const storageMode = linkStorageMode(canUse);

  // The fallback list, read from localStorage on every stamp bump (each
  // successful local mutation stamps) rather than mirrored into React state:
  // the store is the state, and a read is cheaper than a shadow copy that
  // could drift from what another tab wrote.
  const [localLinksStamp, setLocalLinksStamp] = useState(0);
  const localLinks = useMemo(() => {
    // The stamp is the invalidation trigger, not an input — same shape as
    // the optimistic overlay's memo below.
    void localLinksStamp;
    return storageMode === "local" ? readLocalLinks() : [];
  }, [storageMode, localLinksStamp]);

  const mutateShortcuts = useCallback(
    async (
      fn: (blob: ShortcutBarBlob) => BlobTransform,
    ): Promise<ShortcutMutation> => {
      if (storageMode === "local") {
        const result = await mutateLocalLinks(fn);
        if (result.ok) {
          setLocalLinksStamp((stamp) => stamp + 1);
        }
        return result;
      }
      if (!canUse || !selfPubkey) {
        // Unreachable while storageMode is derived from canUse in the same
        // render — kept as the guard for a signer that flipped between the
        // render and this call.
        return { ok: false, message: NEED_LOCAL_KEY_MESSAGE };
      }
      if (!relayLoaded) {
        return { ok: false, message: LINKS_LOADING_MESSAGE };
      }
      if (relayState.blocked) {
        // E6: never clobber a blob this device cannot read — a v1 write over
        // a future-version blob would silently destroy whatever the newer
        // client stored.
        return { ok: false, message: SHORTCUT_BLOCKED_MESSAGE };
      }
      const result = fn(relayState.blob);
      if (!result.ok) {
        return { ok: false, message: result.reason };
      }
      const plaintext = serializeShortcutBlob(result.blob);
      // Belt and braces: the lib already refuses over-budget mutations, but
      // this hook is the only place that can promise a publish never carries
      // one, whatever transform the caller passed.
      if (blobByteLength(plaintext) > SHORTCUT_BLOB_BUDGET_BYTES) {
        return { ok: false, message: SHORTCUT_BUDGET_MESSAGE };
      }
      let ciphertext: string;
      try {
        ciphertext = (await nip44EncryptTo(plaintext, selfPubkey)).ciphertext;
      } catch (error) {
        return {
          ok: false,
          message:
            error instanceof Error
              ? error.message
              : "Could not seal shortcuts.",
        };
      }
      const event = await signNostrEvent({
        kind: KIND_SHORTCUT_BAR,
        tags: buildShortcutEventTags(),
        content: ciphertext,
        created_at: nextShortcutCreatedAt(
          linksStore.getSnapshot().maxFetched,
          Math.floor(Date.now() / 1000),
        ),
      });
      linksStore.notePublished(event.created_at);
      const previous = optimistic.get(selfPubkey) ?? null;
      setOptimistic(selfPubkey, { at: event.created_at, blob: result.blob });
      const publishResult = await publishQuietly(session, event);
      if (!publishResult.ok) {
        setOptimistic(selfPubkey, previous);
      }
      return {
        ok: publishResult.ok,
        message: publishResult.ok ? null : publishResult.message,
      };
    },
    [storageMode, canUse, selfPubkey, relayState, relayLoaded, session],
  );

  return {
    shortcuts: storageMode === "local" ? localLinks : sidebarShortcuts(blob),
    canUse,
    blocked: relayState.blocked,
    blockedMessage: relayState.blocked ? SHORTCUT_BLOCKED_MESSAGE : null,
    mutateShortcuts,
  };
}
