/**
 * One shared, seeded source for the Links list (plan item 2.3, 2026-09-26).
 *
 * `useShortcutBar` used to own its own REQ + NIP-44 decrypt per call site, and
 * the overlay dock called it a second time — so every link open opened a
 * second REQ and a second decrypt, and could not show the clicked page until
 * both finished. With no localStorage seed, Links were also the one sidebar
 * section that popped in after ~1.2 s while channels painted at ~120 ms.
 *
 * This store holds ONE relay subscription per (session, pubkey, signer) —
 * refcounted, so any number of readers share it — plus a per-pubkey seed of
 * the last successfully decrypted blob. The seed is plaintext labels and
 * URLs, the same exposure as the existing `localLinkStore.ts` fallback, and
 * it is keyed by pubkey so an account switch never shows another identity's
 * links.
 *
 * Pure apart from its injected dependencies, so `node --test` loads it.
 */

import {
  type ShortcutBarBlob,
  emptyShortcutBlob,
  parseShortcutBlob,
  serializeShortcutBlob,
} from "./shortcutBlob.ts";
import {
  KIND_SHORTCUT_BAR,
  SHORTCUT_BAR_D_TAG,
  type ShortcutEventLike,
  reduceShortcutEvents,
} from "./shortcutEvent.ts";

export const LINKS_SEED_PREFIX = "buzz:shortcuts-seed.v1:";

export interface LinksState {
  /** Whose state this is; null = nothing acquired yet. */
  pubkey: string | null;
  blob: ShortcutBarBlob;
  /** A copy exists but this device cannot open it — writes must be refused. */
  blocked: boolean;
  /** The newest relay event seen (the LWW winner), if any. */
  newest: ShortcutEventLike | null;
  /** True once the relay answered (EOSE); before that `blob` may be a seed. */
  loaded: boolean;
  /** Highest `created_at` seen; the next publish is pinned past it. */
  maxFetched: number;
}

export interface LinksDeps {
  subscribe: (
    filter: Record<string, unknown>,
    options: {
      onEvent: (event: ShortcutEventLike) => void;
      onEose?: () => void;
      priority?: "critical";
    },
  ) => () => void;
  /** NIP-44 decrypt-from-self; only called when the signer can decrypt. */
  decrypt: (content: string, pubkey: string) => Promise<string>;
  storage: () => Pick<Storage, "getItem" | "setItem"> | null;
}

const EMPTY_STATE: LinksState = {
  pubkey: null,
  blob: emptyShortcutBlob(),
  blocked: false,
  newest: null,
  loaded: false,
  maxFetched: 0,
};

export function readLinksSeed(
  storage: Pick<Storage, "getItem"> | null,
  pubkey: string,
): ShortcutBarBlob | null {
  try {
    const raw = storage?.getItem(LINKS_SEED_PREFIX + pubkey);
    if (!raw) {
      return null;
    }
    const parsed = parseShortcutBlob(JSON.parse(raw));
    return parsed.ok ? parsed.blob : null;
  } catch {
    return null;
  }
}

export function writeLinksSeed(
  storage: Pick<Storage, "setItem"> | null,
  pubkey: string,
  blob: ShortcutBarBlob,
): void {
  try {
    storage?.setItem(LINKS_SEED_PREFIX + pubkey, serializeShortcutBlob(blob));
  } catch {
    // Quota/private mode: the seed is an optimisation, never required.
  }
}

export function createLinksStore(deps: LinksDeps) {
  let state: LinksState = EMPTY_STATE;
  let key: string | null = null;
  let refs = 0;
  let close: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const set = (next: LinksState) => {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const decryptNewest = (
    pubkey: string,
    event: ShortcutEventLike,
    canDecrypt: boolean,
    forKey: string,
  ) => {
    if (!canDecrypt) {
      return;
    }
    void (async () => {
      let blob: ShortcutBarBlob | null = null;
      try {
        const parsed = parseShortcutBlob(
          JSON.parse(await deps.decrypt(event.content, event.pubkey)),
        );
        blob = parsed.ok ? parsed.blob : null;
      } catch {
        blob = null;
      }
      // A newer event (or another identity) may have landed meanwhile.
      if (key !== forKey || state.newest !== event) {
        return;
      }
      if (blob) {
        writeLinksSeed(deps.storage(), pubkey, blob);
        set({ ...state, blob, blocked: false });
      } else {
        set({ ...state, blob: emptyShortcutBlob(), blocked: true });
      }
    })();
  };

  const open = (pubkey: string, canDecrypt: boolean, forKey: string) => {
    const seed = canDecrypt ? readLinksSeed(deps.storage(), pubkey) : null;
    set({ ...EMPTY_STATE, pubkey, blob: seed ?? emptyShortcutBlob() });
    close = deps.subscribe(
      {
        kinds: [KIND_SHORTCUT_BAR],
        authors: [pubkey],
        "#d": [SHORTCUT_BAR_D_TAG],
        limit: 1,
      },
      {
        onEvent: (event) => {
          if (key !== forKey) {
            return;
          }
          const maxFetched = Math.max(state.maxFetched, event.created_at);
          const newest = reduceShortcutEvents(
            state.newest ? [state.newest, event] : [event],
          );
          if (newest === state.newest) {
            set({ ...state, maxFetched });
            return;
          }
          set({ ...state, newest, maxFetched });
          if (newest) {
            decryptNewest(pubkey, newest, canDecrypt, forKey);
          }
        },
        onEose: () => {
          if (key !== forKey) {
            return;
          }
          // No stored blob at all: the relay is the truth, drop any seed.
          set(
            state.newest
              ? { ...state, loaded: true }
              : { ...state, loaded: true, blob: emptyShortcutBlob() },
          );
        },
        priority: "critical",
      },
    );
  };

  return {
    /**
     * Hold the store open for `pubkey`. Refcounted: the first holder opens the
     * relay subscription (after painting the seed), the last one closes it.
     * A different (session, pubkey, signer) replaces the current one.
     */
    acquire(sessionId: string, pubkey: string, canDecrypt: boolean) {
      const nextKey = `${sessionId}|${pubkey}|${canDecrypt ? "d" : "-"}`;
      if (key !== nextKey) {
        close?.();
        close = null;
        key = nextKey;
        refs = 0;
        open(pubkey, canDecrypt, nextKey);
      }
      refs += 1;
      let released = false;
      return () => {
        if (released || key !== nextKey) {
          return;
        }
        released = true;
        refs -= 1;
        if (refs === 0) {
          // Keep `state` (and `key`) so the next holder repaints instantly;
          // only the wire subscription goes. Re-acquiring re-opens it.
          close?.();
          close = null;
          key = null;
        }
      };
    },
    getSnapshot: (): LinksState => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** A publish went out at `createdAt`; later publishes must pass it. */
    notePublished(createdAt: number) {
      if (createdAt > state.maxFetched) {
        set({ ...state, maxFetched: createdAt });
      }
    },
  };
}

export type LinksStore = ReturnType<typeof createLinksStore>;
