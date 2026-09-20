/**
 * Half-finished decision-card interviews, persisted to IndexedDB.
 *
 * The model is `local-draft-until-submit`: answering a question publishes
 * NOTHING. A partial interview lives only here until the user submits it or
 * completes it, so an agent is never handed half an answer it might act on,
 * and a phone that loses its tab mid-interview loses nothing.
 *
 * Same storage and the same catch-and-cold-start discipline as `askCache.ts`
 * (idb-keyval; corrupt or unavailable storage behaves like "no draft"), for
 * the same reason: a draft is an optimization over re-answering, never a
 * source of truth. The authority is always the card plus what the relay has.
 *
 * ## Keyed on the card EVENT id
 *
 * A nostr event id is content-derived, so an "edited" card is a different
 * card with a different id and a stale draft can never bind to a question set
 * that changed underneath it. That is structural, not a check — which is why
 * `startInterview` still re-validates a restored draft against the card it is
 * restored against: the draft also crosses a build boundary, and a shape
 * written by an older build deserializes with no schema at all.
 *
 * ## Drafts are unsent user choices, so sign-out clears them
 *
 * {@link clearAllCardDrafts} enumerates the store and drops every draft key.
 * It runs from the same teardown as `clearAsksCache()` — leaving a stranger
 * at this browser profile the answers the previous signer was midway through
 * giving is exactly the privacy failure the local-draft model would otherwise
 * introduce.
 */

import { del, delMany, get, keys, set } from "idb-keyval";
import type { CardInterviewState } from "./cardInterview.ts";

/**
 * Bumped when the STORED shape changes. A version bump orphans the previous
 * key rather than mis-reading it; the orphans are swept by
 * {@link clearAllCardDrafts}, which matches on the prefix and is therefore
 * version-blind on purpose.
 */
const DRAFT_VERSION = "v1";

/** Every draft key starts with this. The sweep and the tests both key on it. */
export const CARD_DRAFT_KEY_PREFIX = "card-draft:";

/** How long a stored draft is worth restoring. Older ones are swept on read. */
export const CARD_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Debounce for draft writes — a fast tapper must not thrash IndexedDB. */
export const CARD_DRAFT_DEBOUNCE_MS = 500;

export interface StoredCardDraft extends CardInterviewState {
  /** Stored shape version, checked on read. */
  v: string;
  /** The card event id this answers — redundant with the key, self-describing. */
  cardId: string;
  /** `Date.now()` at write. Drives the TTL sweep. */
  at: number;
}

export function cardDraftKey(cardId: string): string {
  return `${CARD_DRAFT_KEY_PREFIX}${DRAFT_VERSION}:${cardId}`;
}

/**
 * Read one draft. Returns null for: no draft, a different stored version, a
 * draft older than the TTL, a shape that is not a draft, or storage that is
 * unavailable. Never throws — this runs on every card render.
 */
export async function loadCardDraft(
  cardId: string,
  now: number = Date.now(),
): Promise<StoredCardDraft | null> {
  let stored: unknown;
  try {
    stored = await get(cardDraftKey(cardId));
  } catch {
    // Node's test env, private mode, a blocked quota: cold start.
    return null;
  }
  if (
    typeof stored !== "object" ||
    stored === null ||
    Array.isArray(stored) ||
    (stored as StoredCardDraft).v !== DRAFT_VERSION
  ) {
    return null;
  }
  const draft = stored as StoredCardDraft;
  if (typeof draft.at !== "number" || now - draft.at > CARD_DRAFT_TTL_MS) {
    // Expired drafts are dropped rather than restored: a month-old half
    // answer is not what a user meant to resume, and it is still their data.
    void clearCardDraft(cardId);
    return null;
  }
  return draft;
}

/** Write one draft. Best effort — a failed write costs re-answering, nothing more. */
export async function saveCardDraft(
  cardId: string,
  state: CardInterviewState,
  now: number = Date.now(),
): Promise<void> {
  const draft: StoredCardDraft = {
    v: DRAFT_VERSION,
    cardId,
    index: state.index,
    answers: state.answers,
    note: state.note,
    at: now,
  };
  try {
    await set(cardDraftKey(cardId), draft);
  } catch {
    // Storage full or blocked.
  }
}

/** Drop one draft — what a successful `done:true` publish does. */
export async function clearCardDraft(cardId: string): Promise<void> {
  try {
    await del(cardDraftKey(cardId));
  } catch {
    // Best effort.
  }
}

/**
 * Drop EVERY card draft, whatever version wrote it. Sign-out teardown.
 *
 * Prefix-matched rather than version-matched deliberately: the point is to
 * leave no unsent answers behind, and a key written by a build that used a
 * different `DRAFT_VERSION` is exactly as private as one written by this one.
 */
export async function clearAllCardDrafts(): Promise<void> {
  try {
    const stored = await keys();
    const drafts = stored.filter(
      (key): key is string =>
        typeof key === "string" && key.startsWith(CARD_DRAFT_KEY_PREFIX),
    );
    if (drafts.length > 0) {
      await delMany(drafts);
    }
  } catch {
    // Best effort.
  }
}

/** The pieces of a timer this module needs — injectable so tests own the clock. */
export interface DraftTimers {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const REAL_TIMERS: DraftTimers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface CardDraftWriter {
  /** Queue a write. Repeated calls inside the window collapse into one. */
  schedule: (state: CardInterviewState) => void;
  /** Write whatever is pending right now (component unmount, submit). */
  flush: () => void;
  /** Forget whatever is pending — the draft is being DELETED, not saved. */
  cancel: () => void;
}

/**
 * A debounced writer for one card's draft.
 *
 * Debounced rather than throttled because the interesting write is the LAST
 * one: a user tapping through four questions produces four states in under a
 * second, and only the final one is worth the round trip. {@link flush}
 * exists because unmount is the one moment a pending write must not be lost.
 *
 * {@link cancel} is not `flush`'s opposite by accident — it is what a
 * successful submit calls, immediately before deleting the draft. Without it,
 * a pending debounced write lands AFTER the delete and resurrects a draft for
 * an interview that has already been published.
 */
export function createCardDraftWriter(
  cardId: string,
  options: {
    delayMs?: number;
    timers?: DraftTimers;
    write?: (cardId: string, state: CardInterviewState) => void;
  } = {},
): CardDraftWriter {
  const delayMs = options.delayMs ?? CARD_DRAFT_DEBOUNCE_MS;
  const timers = options.timers ?? REAL_TIMERS;
  const write =
    options.write ??
    ((id: string, state: CardInterviewState) => {
      void saveCardDraft(id, state);
    });
  let handle: unknown = null;
  let pending: CardInterviewState | null = null;

  function commit() {
    handle = null;
    if (pending === null) {
      return;
    }
    const state = pending;
    pending = null;
    write(cardId, state);
  }

  return {
    schedule(state) {
      pending = state;
      if (handle !== null) {
        timers.clearTimeout(handle);
      }
      handle = timers.setTimeout(commit, delayMs);
    },
    flush() {
      if (handle !== null) {
        timers.clearTimeout(handle);
      }
      commit();
    },
    cancel() {
      if (handle !== null) {
        timers.clearTimeout(handle);
        handle = null;
      }
      pending = null;
    },
  };
}
