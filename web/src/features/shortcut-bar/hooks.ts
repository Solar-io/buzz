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
  shortcutListFor,
} from "./lib/shortcutBlob.ts";
import {
  KIND_SHORTCUT_BAR,
  SHORTCUT_BAR_D_TAG,
  type ShortcutEventLike,
  buildShortcutEventTags,
  nextShortcutCreatedAt,
  reduceShortcutEvents,
} from "./lib/shortcutEvent.ts";

/**
 * The per-channel shortcut bar, relay-backed.
 *
 * The data is ONE kind-30078 event per user (NIP-78, `d="shortcut-bar"`),
 * NIP-44-encrypted to self, holding every channel's shortcuts. The shape and
 * LWW rules live in `lib/shortcutEvent.ts`; this file is the subscription,
 * the decrypt, and the optimistic write overlay.
 *
 * Writes are whole-blob replacement with last-write-wins on `created_at`
 * (desktop `readStateManager.ts` pattern): two devices editing between syncs
 * means the second publish silently wins. Acceptable for a single-user
 * config surface, and documented as such in the design rather than
 * "solved" with a merge nobody asked for.
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
  /** This channel's shortcuts, newest blob first. */
  shortcuts: ShortcutDef[];
  /** True only when the unlocked local key is live (the render gate). */
  canUse: boolean;
  /** The stored blob exists but is unreadable or from a newer version. */
  blocked: boolean;
  blockedMessage: string | null;
  /**
   * Read → transform → budget-check → encrypt → sign → optimistic → publish,
   * rolling the optimistic entry back if the relay refuses.
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

export function useShortcutBar(channelId: string): ShortcutBar {
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

  const [relayState, setRelayState] = useState<RelayBlobState>({ blob: emptyShortcutBlob(), blocked: false });
  useEffect(() => {
    let alive = true;
    if (!newest || !selfPubkey || signer !== "local") {
      setRelayState({ blob: emptyShortcutBlob(), blocked: false });
      return;
    }
    void (async () => {
      try {
        const { plaintext } = await nip44DecryptFrom(newest.content, newest.pubkey);
        const parsed = parseShortcutBlob(JSON.parse(plaintext));
        if (alive && parsed.ok) { setRelayState({ blob: parsed.blob, blocked: false }); return; }
      } catch {
        // Undecryptable here — expose a blocked state.
      }
      if (alive) setRelayState({ blob: emptyShortcutBlob(), blocked: true });
    })();
    return () => { alive = false; };
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

  const mutateShortcuts = useCallback(
    async (
      fn: (blob: ShortcutBarBlob) => BlobTransform,
    ): Promise<ShortcutMutation> => {
      if (!canUse || !selfPubkey) {
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
    [canUse, selfPubkey, relayState, session],
  );

  return {
    shortcuts: shortcutListFor(blob, channelId),
    canUse,
    blocked: relayState.blocked,
    blockedMessage: relayState.blocked ? SHORTCUT_BLOCKED_MESSAGE : null,
    mutateShortcuts,
  };
}

/**
 * The shortcut overlay's dock: the channel's overlay-mode shortcuts as the
 * panel registry, with a tab session persisted PER CHANNEL under
 * `buzz:shortcut-overlay-sessions.v1` (iframes still die on close — only the
 * tab LIST survives, same as Files across reloads).
 *
 * `setScope`/`setPanels` run during render, before any subscriber reads: the
 * overlay is unmounted on channel switch, so a scope change always happens
 * on a fresh mount and the emit inside is a no-op in practice.
 */
const shortcutDockStore = createDockStore({
  storageKey: "buzz:shortcut-overlay-sessions.v1",
});

export function useShortcutDock(channelId: string): WebPanelDockApi {
  const { shortcuts } = useShortcutBar(channelId);
  const store = shortcutDockStore;
  store.setScope(channelId);
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
