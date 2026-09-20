/**
 * Cross-browser read-state sync (NIP-RS) — the lifecycle half of
 * readStateSyncBlob.ts. Owns the boot fetch, the merge into the two
 * localStorage stores, and the debounced publish.
 *
 * The prime directive: LOCAL BEHAVIOR IS IDENTICAL TO TODAY. Every relay
 * interaction is wrapped so an unreachable relay, a refused publish, or a
 * session that cannot decrypt (NIP-07-only) costs nothing but a
 * console.debug — read state is localStorage first and a synced copy second,
 * never the other way round.
 *
 * v1 scope (deliberately leaner than the desktop manager): ONE slot per
 * browser install, boot fetch only (no live subscription), no thread/msg
 * hierarchy, no override layer. Each browser writes its own random `d`
 * coordinate and boot max-merges every coordinate it finds, so N browsers
 * converge without coordination.
 */

import type { RelaySession } from "@/shared/api/relay-session";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  nip44DecryptFrom,
  nip44EncryptTo,
  signNostrEvent,
} from "@/shared/lib/nostr-signer";
import {
  loadInboxReadState,
  saveInboxReadState,
} from "@/features/home/lib/inboxReadState.ts";
import { loadReadState, saveReadState } from "./readState.ts";
import {
  KIND_READ_STATE,
  type MergedRemoteReadState,
  buildReadStateEventTags,
  buildPublishPayload,
  isValidReadStateDTag,
  mergeChannelMarkers,
  mergeInboxOverlay,
  mergePayloadBatch,
  nextPublishCreatedAt,
} from "./readStateSyncBlob.ts";

/**
 * Fired on `window` once the boot fetch has merged relay state into the two
 * localStorage stores. repos.tsx and useInboxReadState listen for it and
 * re-read localStorage — the same reread-on-external-change pattern those
 * hooks already use for tab focus.
 */
export const READ_STATE_SYNCED_EVENT = "buzz:read-state-synced";

/** NIP-RS debounce guidance: flush 5–10s after the last local change. */
const PUBLISH_DEBOUNCE_MS = 5_000;

/**
 * Leak valve for the boot REQ (useUnreadCount's IN_FLIGHT_TIMEOUT_MS
 * pattern): a socket that dies before EOSE must not leave the fetch hanging —
 * whatever arrived by then is merged and the REQ is closed.
 */
const BOOT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Identity keys, same prefixes the desktop uses (`readStateIdentity.ts`), so
 * a future shared install story does not have to migrate anything. Keyed by
 * pubkey: two identities in one browser never share a slot.
 */
const SLOT_ID_KEY_PREFIX = "buzz.nip-rs.slot-id";
const CLIENT_ID_KEY_PREFIX = "buzz.nip-rs.client-id";

/** One boot fetch's worth of state; replaced wholesale on identity change. */
interface ReadStateSyncState {
  pubkey: string;
  session: RelaySession;
  /** 16 hex — identifies this browser install inside the encrypted blob. */
  clientId: string;
  /** 32 hex — this install's random `d` coordinate suffix. */
  slotId: string;
  /** Highest event created_at seen (fetched or self-published) — the pin. */
  highestSeenCreatedAt: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  onPageHide: () => void;
}

let syncState: ReadStateSyncState | null = null;

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable-per-install identity value, generated on first use. */
function persistedId(key: string, bytes: number): string {
  let value: string | null = null;
  try {
    value = globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    // Storage unavailable — the id regenerates per session; sync degrades to
    // publish-only from this browser, which is still strictly additive.
  }
  if (!value) {
    value = randomHex(bytes);
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // Same story: a browser that cannot persist cannot own a stable slot.
    }
  }
  return value;
}

/**
 * Boot the sync once identity is available. Idempotent per pubkey: a second
 * call for the same identity only refreshes the session handle (the session
 * object can be replaced across provider reconnects); a DIFFERENT pubkey
 * tears the previous sync down first (account switch).
 */
export function initReadStateSync(options: {
  session: RelaySession;
  selfPubkey: string;
}): void {
  const { session, selfPubkey } = options;
  if (syncState?.pubkey === selfPubkey) {
    syncState.session = session;
    return;
  }
  disposeReadStateSync();
  const state: ReadStateSyncState = {
    pubkey: selfPubkey,
    session,
    clientId: persistedId(`${CLIENT_ID_KEY_PREFIX}:${selfPubkey}`, 8),
    slotId: persistedId(`${SLOT_ID_KEY_PREFIX}:${selfPubkey}`, 16),
    highestSeenCreatedAt: 0,
    debounceTimer: null,
    onPageHide: () => flushDebouncedPublish(state),
  };
  syncState = state;
  // The 5s debounce's one escape hatch: a tab closed inside the window must
  // not silently lose the last read (NIP-RS publishes on close for this
  // reason). Still publish-only — never blocks the close.
  window.addEventListener("pagehide", state.onPageHide);
  void bootFetch(state);
}

function disposeReadStateSync(): void {
  if (syncState === null) {
    return;
  }
  if (syncState.debounceTimer !== null) {
    clearTimeout(syncState.debounceTimer);
    syncState.debounceTimer = null;
  }
  window.removeEventListener("pagehide", syncState.onPageHide);
  syncState = null;
}

/**
 * NIP-RS correctness filter, applied client-side to everything received
 * (a relay MAY apply tag constraints after its result cap): exactly one `d`
 * tag on a well-formed read-state coordinate, exactly one `t=read-state`.
 * Events on foreign coordinates (the shortcut bar's `d="shortcut-bar"`)
 * share kind 30078 and MUST be ignored here.
 */
function isReadStateEvent(
  event: Pick<SignedNostrEvent, "pubkey" | "tags">,
  selfPubkey: string,
): boolean {
  if (event.pubkey !== selfPubkey) {
    return false;
  }
  const dTags = event.tags.filter(
    (tag) => Array.isArray(tag) && tag[0] === "d",
  );
  if (dTags.length !== 1) {
    return false;
  }
  if (!isValidReadStateDTag(dTags[0]?.[1])) {
    return false;
  }
  const tTags = event.tags.filter(
    (tag) => Array.isArray(tag) && tag[0] === "t" && tag[1] === "read-state",
  );
  return tTags.length === 1;
}

/**
 * One-shot boot fetch: every own read-state event (all browsers' slots),
 * collected until EOSE or the 15s valve. Decrypt failures become nulls and
 * are skipped by the fold — one undecryptable event (other key, corrupt
 * ciphertext) must not kill the batch. The pin tracks EVERY matching event's
 * created_at, decryptable or not: the relay retains those events, so our
 * next publish must still beat them.
 */
async function bootFetch(state: ReadStateSyncState): Promise<void> {
  const payloads: (string | null)[] = [];
  const pendingDecrypts: Promise<void>[] = [];
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let done = false;
  let leakValve: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: () => void = () => {};
  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    if (leakValve !== null) {
      clearTimeout(leakValve);
    }
    unsubscribe();
    settle();
  };
  unsubscribe = state.session.subscribe(
    {
      kinds: [KIND_READ_STATE],
      authors: [state.pubkey],
      "#t": ["read-state"],
      limit: 64,
    },
    {
      onEvent: (event: SignedNostrEvent) => {
        state.highestSeenCreatedAt = Math.max(
          state.highestSeenCreatedAt,
          event.created_at,
        );
        if (!isReadStateEvent(event, state.pubkey)) {
          return;
        }
        pendingDecrypts.push(
          nip44DecryptFrom(event.content, event.pubkey)
            .then(({ plaintext }) => {
              payloads.push(plaintext);
            })
            .catch(() => {
              payloads.push(null);
            }),
        );
      },
      onEose: () => finish(),
    },
  );
  leakValve = setTimeout(finish, BOOT_FETCH_TIMEOUT_MS);
  await settled;
  // EOSE can race the last decrypts; let everything already accepted land so
  // a slow NIP-44 round does not silently drop a good blob.
  await Promise.all(pendingDecrypts);
  applyMergedRemote(mergePayloadBatch(payloads));
}

/**
 * Merge the folded remote state into both localStorage stores and nudge the
 * UI. Fires the synced event only when something actually advanced — a
 * no-op boot (fresh browser, empty relay) re-reading state would re-derive
 * the activity feed's bounded REQs for nothing.
 */
function applyMergedRemote(remote: MergedRemoteReadState): void {
  const localChannels = loadReadState();
  const mergedChannels = mergeChannelMarkers(localChannels, remote.contexts);
  if (mergedChannels !== localChannels) {
    saveReadState(mergedChannels);
  }
  const localInbox = loadInboxReadState();
  const mergedInbox = mergeInboxOverlay(localInbox, {
    read: remote.inboxRead,
    unread: remote.inboxUnread,
  });
  if (mergedInbox !== localInbox) {
    saveInboxReadState(mergedInbox);
  }
  if (mergedChannels !== localChannels || mergedInbox !== localInbox) {
    window.dispatchEvent(new CustomEvent(READ_STATE_SYNCED_EVENT));
  }
}

/**
 * Announce a local persist of either store (repos.tsx markSeen, the inbox
 * overlay's markRead/markUnread, the channel delete/eviction path). Schedules
 * the debounced publish; a no-op before init (tests, logged-out shell) so
 * callers never need to check.
 */
export function notifyReadStateLocalChange(): void {
  if (syncState === null) {
    return;
  }
  if (syncState.debounceTimer !== null) {
    clearTimeout(syncState.debounceTimer);
  }
  syncState.debounceTimer = setTimeout(() => {
    if (syncState === null) {
      return;
    }
    syncState.debounceTimer = null;
    void publishReadState(syncState);
  }, PUBLISH_DEBOUNCE_MS);
}

function flushDebouncedPublish(state: ReadStateSyncState): void {
  if (state.debounceTimer === null) {
    return;
  }
  clearTimeout(state.debounceTimer);
  state.debounceTimer = null;
  void publishReadState(state);
}

/**
 * Re-read both stores from localStorage (the debounced flush is far enough
 * from the writes that re-reading is simpler than threading state through),
 * prune to the publish caps, seal to self, publish. Every failure is quiet:
 * an unreachable relay or an unsigned session leaves local state exactly as
 * it was, and the next change re-arms the debounce.
 */
async function publishReadState(state: ReadStateSyncState): Promise<void> {
  const inbox = loadInboxReadState();
  const built = buildPublishPayload({
    clientId: state.clientId,
    contexts: loadReadState(),
    inboxRead: inbox.read,
    inboxUnread: inbox.unread,
  });
  if (!built.ok) {
    console.debug("[readStateSync] publish suppressed:", built.reason);
    return;
  }
  try {
    const { ciphertext } = await nip44EncryptTo(
      built.payload.plaintext,
      state.pubkey,
    );
    const event = await signNostrEvent({
      kind: KIND_READ_STATE,
      tags: buildReadStateEventTags(state.slotId),
      content: ciphertext,
      created_at: nextPublishCreatedAt(
        Math.floor(Date.now() / 1000),
        state.highestSeenCreatedAt,
      ),
    });
    // Own publishes count toward the pin: the NEXT publish from this browser
    // must beat this one, not tie it (ties lose to relay newest-wins).
    state.highestSeenCreatedAt = Math.max(
      state.highestSeenCreatedAt,
      event.created_at,
    );
    const result = await state.session.publish(event);
    if (!result.ok) {
      console.debug("[readStateSync] publish refused:", result.message);
    }
  } catch (error) {
    console.debug("[readStateSync] publish failed:", error);
  }
}
