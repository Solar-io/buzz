/**
 * Cross-device read-state sync (NIP-RS) — the lifecycle half of
 * readStateSyncBlob.ts. Owns the boot-to-live subscription, the merge into
 * the two localStorage stores, and the debounced publish.
 *
 * The prime directive: LOCAL BEHAVIOR IS IDENTICAL TO TODAY. Every relay
 * interaction is wrapped so an unreachable relay, a refused publish, or a
 * session that cannot decrypt (NIP-07-only) costs nothing but a
 * console.debug — read state is localStorage first and a synced copy second,
 * never the other way round.
 *
 * v2: the boot REQ stays open after EOSE (one-shot boot fetches could never
 * hear another device's later read marker, so an open client never
 * converged until reload). One subscription serves both phases: until EOSE
 * it IS the boot batch — identical accept/drain semantics to the fetch it
 * replaces — and after EOSE every EVENT is a live marker. RelaySession's
 * reconnect replay re-REQs the same filter after any socket death; the
 * bounded event-id dedupe absorbs that replay overlap, so a reconnect reads
 * as a quiet no-op rather than a second boot.
 *
 * Convergence: a live FOREIGN event that actually advances the merged
 * stores re-arms the same publish debounce a local change would, so this
 * install's slot is republished carrying the union (every active device's
 * coordinate then stays recent enough to sit inside a fresh boot's
 * limit:64 window). Own echoes are dropped by id before decrypt, and a
 * republish can only carry state another device lacked — the exchange
 * terminates instead of ping-ponging.
 *
 * Still v1-scope elsewhere: ONE slot per browser install, no thread/msg
 * hierarchy, no override layer. Each browser writes its own random `d`
 * coordinate and every client max-merges every coordinate it sees, so N
 * devices converge without coordination.
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
  READ_STATE_D_TAG_PREFIX,
  buildPublishPayload,
  buildReadStateEventTags,
  isValidReadStateDTag,
  mergeChannelMarkers,
  mergeInboxOverlay,
  mergePayloadBatch,
  nextPublishCreatedAt,
} from "./readStateSyncBlob.ts";

/**
 * Fired on `window` once a boot batch or a coalesced live burst has merged
 * relay state into the two localStorage stores. repos.tsx and
 * useInboxReadState listen for it and re-read localStorage — the same
 * reread-on-external-change pattern those hooks already use for tab focus.
 */
export const READ_STATE_SYNCED_EVENT = "buzz:read-state-synced";

/** NIP-RS debounce guidance: flush 5–10s after the last local change. */
const PUBLISH_DEBOUNCE_MS = 5_000;

/**
 * Leak valve for the BOOT PHASE only (useUnreadCount's IN_FLIGHT_TIMEOUT_MS
 * pattern): a socket that dies before EOSE must not leave the boot merge
 * hanging — whatever arrived by then is merged and later events flow
 * through the live path when the session reconnects and replays the REQ.
 * The subscription itself is NOT torn down here; it is the same persistent
 * REQ the live phase uses.
 */
const BOOT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Live-burst coalesce window. A reconnect replay or a cluster of devices
 * publishing near-simultaneously delivers its events back-to-back on one
 * socket; merging and notifying per event would re-read both stores and
 * re-render the unread UI once per marker. One flush per window keeps a
 * burst to one merged write and at most one synced event.
 */
const LIVE_COALESCE_MS = 100;

/**
 * Bound on remembered event ids (dedupe + own-echo drop). Boot and each
 * reconnect replay deliver up to `limit` (64) events; live traffic adds one
 * id per published marker. FIFO eviction: an id that falls off and is later
 * replayed is decrypted again, but the grow-only merge makes that a no-op —
 * the bound caps memory, not correctness.
 */
const SEEN_EVENT_IDS_MAX = 512;

/**
 * Identity keys, same prefixes the desktop uses (`readStateIdentity.ts`), so
 * a future shared install story does not have to migrate anything. Keyed by
 * pubkey: two identities in one browser never share a slot.
 */
const SLOT_ID_KEY_PREFIX = "buzz.nip-rs.slot-id";
const CLIENT_ID_KEY_PREFIX = "buzz.nip-rs.client-id";

/** One identity's sync lifetime; replaced wholesale on identity change. */
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
  liveFlushTimer: ReturnType<typeof setTimeout> | null;
  /** Live decrypts awaiting one coalesced flush (cleared per flush). */
  liveQueue: Array<Promise<string | null>>;
  /**
   * FIFO of event ids already accepted (or published by us). Checked before
   * any decrypt so replays and own echoes cost nothing.
   */
  seenEventIds: Map<string, true>;
  /** Handle for THIS state's current subscription (moved on session swap). */
  unsubscribe: (() => void) | null;
  /** Set by dispose; every await site re-checks liveness against it. */
  disposed: boolean;
  onPageHide: () => void;
}

let syncState: ReadStateSyncState | null = null;

/**
 * Liveness guard for every continuation past an await: a state that was
 * disposed (identity switch) or replaced must not merge, notify, or publish
 * — its subscription is gone and its identity's stores are no longer ours.
 */
function isStateLive(state: ReadStateSyncState): boolean {
  return !state.disposed && syncState === state;
}

/**
 * Remember an event id; false means it was already remembered (a replay or
 * our own echo) and the caller must drop it before decrypting.
 */
function rememberEventId(state: ReadStateSyncState, eventId: string): boolean {
  if (state.seenEventIds.has(eventId)) {
    return false;
  }
  state.seenEventIds.set(eventId, true);
  if (state.seenEventIds.size > SEEN_EVENT_IDS_MAX) {
    for (const oldest of state.seenEventIds.keys()) {
      state.seenEventIds.delete(oldest);
      break;
    }
  }
  return true;
}

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
 * call for the same identity and the SAME session is a no-op; a new session
 * object under the same pubkey (provider reconnect) MOVES the persistent
 * subscription — the old REQ is closed with its exact handle and the boot
 * re-runs on the new session (the id dedupe makes the replayed overlap a
 * quiet no-op); a DIFFERENT pubkey tears the previous sync down first
 * (account switch).
 */
export function initReadStateSync(options: {
  session: RelaySession;
  selfPubkey: string;
}): void {
  const { session, selfPubkey } = options;
  if (syncState?.pubkey === selfPubkey) {
    if (syncState.session === session) {
      return;
    }
    const state = syncState;
    state.unsubscribe?.();
    state.unsubscribe = null;
    state.session = session;
    void bootFetch(state);
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
    liveFlushTimer: null,
    liveQueue: [],
    seenEventIds: new Map(),
    unsubscribe: null,
    disposed: false,
    onPageHide: () => flushDebouncedPublish(state),
  };
  syncState = state;
  // The 5s debounce's one escape hatch: a tab closed inside the window must
  // not silently lose the last read (NIP-RS publishes on close for this
  // reason). Still publish-only — never blocks the close.
  window.addEventListener("pagehide", state.onPageHide);
  void bootFetch(state);
}

/**
 * Tear the current sync down exactly: stop both timers, close the REQ with
 * the handle that opened it, drop the pagehide listener, and mark the state
 * dead so in-flight decrypts/publishes landing after this point no-op
 * (async liveness guard) instead of writing a replaced identity's stores.
 */
export function disposeReadStateSync(): void {
  if (syncState === null) {
    return;
  }
  const state = syncState;
  state.disposed = true;
  if (state.debounceTimer !== null) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }
  if (state.liveFlushTimer !== null) {
    clearTimeout(state.liveFlushTimer);
    state.liveFlushTimer = null;
  }
  state.liveQueue = [];
  state.unsubscribe?.();
  state.unsubscribe = null;
  window.removeEventListener("pagehide", state.onPageHide);
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
 * Own-slot check: the event sits on THIS install's `d` coordinate, so it is
 * one of our own publishes echoed back or replayed. Dropped before decrypt —
 * merging our own blob back is at best a wasted decrypt and at worst a
 * self-triggered convergence republish.
 */
function isOwnSlotEvent(
  event: Pick<SignedNostrEvent, "tags">,
  slotId: string,
): boolean {
  return event.tags.some(
    (tag) =>
      Array.isArray(tag) &&
      tag[0] === "d" &&
      tag[1] === `${READ_STATE_D_TAG_PREFIX}${slotId}`,
  );
}

/**
 * The boot-to-live subscription. Until EOSE (or the 15s valve) accepted
 * events form the boot batch — decrypt failures become nulls and are
 * skipped by the fold, one undecryptable event must not kill the batch, and
 * EOSE waits for every decrypt already accepted (a slow NIP-44 round must
 * not silently drop a good blob). After EOSE the same REQ delivers live
 * markers, and each reconnect replay re-runs the cycle with the dedupe
 * absorbing the overlap. The pin tracks EVERY matching event's created_at,
 * decryptable or not: the relay retains those events, so our next publish
 * must still beat them.
 */
async function bootFetch(state: ReadStateSyncState): Promise<void> {
  const bootDecrypts: Array<Promise<string | null>> = [];
  let bootDone = false;
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let valveDone = false;
  let leakValve: ReturnType<typeof setTimeout> | null = null;
  const finishBoot = () => {
    if (valveDone) {
      return;
    }
    valveDone = true;
    bootDone = true;
    if (leakValve !== null) {
      clearTimeout(leakValve);
    }
    settle();
  };
  const unsubscribe = state.session.subscribe(
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
        // Replay / own-echo dedupe BEFORE decrypt: reconnect replays
        // re-deliver stored events verbatim, and our own publishes come
        // back on this same REQ — neither may re-enter the merge path.
        if (!rememberEventId(state, event.id)) {
          return;
        }
        if (isOwnSlotEvent(event, state.slotId)) {
          return;
        }
        if (!isReadStateEvent(event, state.pubkey)) {
          return;
        }
        const decrypt: Promise<string | null> = nip44DecryptFrom(
          event.content,
          event.pubkey,
        )
          .then(({ plaintext }) => plaintext)
          .catch(() => null);
        if (bootDone) {
          state.liveQueue.push(decrypt);
          scheduleLiveFlush(state);
        } else {
          bootDecrypts.push(decrypt);
        }
      },
      onEose: () => {
        if (!bootDone) {
          finishBoot();
          return;
        }
        // A reconnect replay's EOSE is a batch boundary: flush the burst it
        // delivered now instead of waiting out the coalesce window.
        void flushLiveQueue(state);
      },
    },
  );
  state.unsubscribe = unsubscribe;
  leakValve = setTimeout(finishBoot, BOOT_FETCH_TIMEOUT_MS);
  await settled;
  // EOSE can race the last decrypts; everything accepted before it lands so
  // the boot batch keeps its one-shot-fetch drain semantics.
  const payloads = await Promise.all(bootDecrypts);
  // The identity may have been replaced (or the session moved, re-running
  // boot) while decrypts drained — a dead state must not merge.
  if (!isStateLive(state)) {
    return;
  }
  applyMergedRemote(mergePayloadBatch(payloads));
}

/** Arm the one-per-burst live flush timer (no-op while one is pending). */
function scheduleLiveFlush(state: ReadStateSyncState): void {
  if (state.liveFlushTimer !== null) {
    return;
  }
  state.liveFlushTimer = setTimeout(() => {
    state.liveFlushTimer = null;
    void flushLiveQueue(state);
  }, LIVE_COALESCE_MS);
}

/**
 * Drain the live queue as ONE batch: a single grow-only merge into both
 * stores, at most one synced event per burst, and — only when a foreign
 * marker actually advanced state — a convergence republish on the shared
 * debounce.
 */
async function flushLiveQueue(state: ReadStateSyncState): Promise<void> {
  if (state.liveFlushTimer !== null) {
    clearTimeout(state.liveFlushTimer);
    state.liveFlushTimer = null;
  }
  const queued = state.liveQueue;
  if (queued.length === 0) {
    return;
  }
  state.liveQueue = [];
  const payloads = await Promise.all(queued);
  if (!isStateLive(state)) {
    return;
  }
  const advanced = applyMergedRemote(mergePayloadBatch(payloads));
  if (advanced) {
    // Everything in the live queue passed the own-slot drop, so any advance
    // came from another device — refresh our slot with the union. Our own
    // echo of that publish is dropped by id, and the other devices' merges
    // of it cannot advance them, so the chain terminates.
    schedulePublishDebounced(state);
  }
}

/**
 * Merge the folded remote state into both localStorage stores and nudge the
 * UI. Returns whether the merge advanced either store. Fires the synced
 * event only on an advance — a no-op batch (fresh browser, empty relay,
 * all-stale burst) re-reading state would re-derive the activity feed's
 * bounded REQs for nothing.
 */
function applyMergedRemote(remote: MergedRemoteReadState): boolean {
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
  const advanced =
    mergedChannels !== localChannels || mergedInbox !== localInbox;
  if (advanced) {
    window.dispatchEvent(new CustomEvent(READ_STATE_SYNCED_EVENT));
  }
  return advanced;
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
  schedulePublishDebounced(syncState);
}

function schedulePublishDebounced(state: ReadStateSyncState): void {
  if (state.debounceTimer !== null) {
    clearTimeout(state.debounceTimer);
  }
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    if (!isStateLive(state)) {
      return;
    }
    void publishReadState(state);
  }, PUBLISH_DEBOUNCE_MS);
}

function flushDebouncedPublish(state: ReadStateSyncState): void {
  if (state.debounceTimer === null) {
    return;
  }
  clearTimeout(state.debounceTimer);
  state.debounceTimer = null;
  if (!isStateLive(state)) {
    return;
  }
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
    if (!isStateLive(state)) {
      return;
    }
    // Remember our own event id BEFORE the publish leaves: the still-open
    // subscription will echo it back, and the id must already sit in the
    // dedupe set by then so the echo is dropped before any decrypt — it can
    // never re-enter the merge path, let alone re-arm the convergence
    // publish (that would be a self-sustaining loop).
    rememberEventId(state, event.id);
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
