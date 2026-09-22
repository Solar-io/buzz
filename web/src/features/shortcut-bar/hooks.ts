import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { RelaySession } from "@/shared/api/relay-session";
import { subscribeAuth } from "@/shared/lib/key-store";
import {
  activeSignerSource,
  nip44DecryptFrom,
  nip44EncryptTo,
  ownPubkey,
  signNostrEvent,
  type SignedNostrEvent,
} from "@/shared/lib/nostr-signer";
import type { WebPanelDockApi } from "@/features/webPanels/hooks";
import { createDockStore } from "@/features/webPanels/lib/dockStore.ts";
import type { WebPanelDef } from "@/features/webPanels/lib/panelRegistry.ts";

import {
  SHORTCUT_BLOB_BUDGET_BYTES,
  SHORTCUT_BUDGET_MESSAGE,
  type ShortcutBarBlob,
  type ShortcutDef,
  emptyShortcutBlob,
  parseShortcutBlob,
  serializeShortcutBlob,
  sidebarShortcuts,
} from "./lib/shortcutBlob.ts";
import {
  KIND_SHORTCUT_BAR,
  SHORTCUT_BAR_D_TAG,
  type ShortcutEventLike,
  buildShortcutEventTags,
  nextShortcutCreatedAt,
  reduceShortcutEvents,
} from "./lib/shortcutEvent.ts";
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

/** The decrypted-or-blocked view of the relay's newest copy. */
interface RelayBlobState {
  blob: ShortcutBarBlob;
  /** A copy exists but this device cannot open it — writes must be refused. */
  blocked: boolean;
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
  const [events, setEvents] = useState<ShortcutEventLike[]>([]);
  // Highest `created_at` the relay has shown us; the next publish is pinned
  // past it so a slow clock cannot publish a losing write.
  const maxFetchedRef = useRef(0);

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

  // One REQ for the user's single blob: the relay answers with the stored
  // replaceable event, then keeps the subscription open for live updates.
  useEffect(() => {
    if (!selfPubkey) {
      setEvents([]);
      return;
    }
    setEvents([]);
    return session.subscribe(
      {
        kinds: [KIND_SHORTCUT_BAR],
        authors: [selfPubkey],
        "#d": [SHORTCUT_BAR_D_TAG],
        limit: 1,
      },
      {
        onEvent: (event: SignedNostrEvent) => {
          maxFetchedRef.current = Math.max(
            maxFetchedRef.current,
            event.created_at,
          );
          setEvents((previous) => [...previous, event]);
        },
      },
    );
  }, [session, selfPubkey]);

  const newest = useMemo(() => reduceShortcutEvents(events), [events]);

  const [relayState, setRelayState] = useState<RelayBlobState>({
    blob: emptyShortcutBlob(),
    blocked: false,
  });
  useEffect(() => {
    let alive = true;
    if (!newest || !selfPubkey || signer !== "local") {
      setRelayState({ blob: emptyShortcutBlob(), blocked: false });
      return;
    }
    void (async () => {
      try {
        const { plaintext } = await nip44DecryptFrom(
          newest.content,
          newest.pubkey,
        );
        const parsed = parseShortcutBlob(JSON.parse(plaintext));
        if (alive && parsed.ok) {
          setRelayState({ blob: parsed.blob, blocked: false });
          return;
        }
      } catch {
        // Undecryptable here — expose a blocked state.
      }
      if (alive) setRelayState({ blob: emptyShortcutBlob(), blocked: true });
    })();
    return () => {
      alive = false;
    };
  }, [newest, selfPubkey, signer]);

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
          maxFetchedRef.current,
          Math.floor(Date.now() / 1000),
        ),
      });
      maxFetchedRef.current = Math.max(maxFetchedRef.current, event.created_at);
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
    [storageMode, canUse, selfPubkey, relayState, session],
  );

  return {
    shortcuts: storageMode === "local" ? localLinks : sidebarShortcuts(blob),
    canUse,
    blocked: relayState.blocked,
    blockedMessage: relayState.blocked ? SHORTCUT_BLOCKED_MESSAGE : null,
    mutateShortcuts,
  };
}

/**
 * The shortcut overlay's dock: the sidebar list's overlay-mode shortcuts as
 * the panel registry, with ONE global tab session under
 * `buzz:shortcut-overlay-sessions.v1` (iframes still die on close — only the
 * tab LIST survives, same as Files across reloads).
 *
 * There is no `setScope` here any more. The registry used to be per channel
 * and each channel kept its own tabs; the list is channel-independent now, so
 * a scope per channel would leave every open tab stranded under whichever key
 * it was opened under. The store is pinned to a single scope instead, which
 * `dockStore` already supports — a file written by the per-channel build is
 * read, its other scopes simply never load again.
 */
const SHORTCUT_DOCK_SCOPE = "sidebar";

const shortcutDockStore = createDockStore({
  storageKey: "buzz:shortcut-overlay-sessions.v1",
  initialScope: SHORTCUT_DOCK_SCOPE,
});

export function useShortcutDock(): WebPanelDockApi {
  const { shortcuts } = useShortcutBar();
  const store = shortcutDockStore;
  const panels = useMemo<WebPanelDef[]>(
    () =>
      shortcuts
        .filter((shortcut) => shortcut.mode === "overlay")
        .map((shortcut) => ({
          id: shortcut.id,
          label: shortcut.label,
          url: shortcut.url,
          custom: true,
        })),
    [shortcuts],
  );
  store.setPanels(panels);
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return useMemo(
    () => ({
      panels,
      instances: state.instances,
      activeInstanceId: state.activeInstanceId,
      open: store.open,
      focusOrOpen: store.focusOrOpen,
      close: store.close,
      activate: store.activate,
    }),
    // `store` is a module singleton with stable methods — listed only to
    // satisfy the reader, never changing.
    [panels, state],
  );
}
