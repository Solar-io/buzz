/**
 * The shortcut bar's Nostr envelope — kind 30078 (NIP-78 app data), one event
 * per user.
 *
 * Why kind 30078 and not a new kind: the relay already accepts it with only
 * `Scope::UsersWrite` and stores it globally-only (`is_global_only_kind`
 * lists it — a stray `h` tag would be REJECTED, so none is added), and it is
 * parameterized-replaceable per `(pubkey, kind, d)`, so the relay keeps only
 * the newest event per coordinate and there is nothing to delete. This
 * mirrors the desktop's seven 30078 features (`d="read-state:<slot>"` +
 * `t="read-state"`).
 *
 * The content is NIP-44-v2 ciphertext sealed to the author's own pubkey —
 * one opaque `d` tag shared by every user leaks nothing about which channels
 * exist, which per-channel `d` tags would.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

/** NIP-78 app data — the kind the relay already stores globally-only. */
export const KIND_SHORTCUT_BAR = 30078;

/**
 * The `d` coordinate for the whole feature: ONE blob per user, never
 * per-channel (any member can query another user's 30078 `d` tags in
 * plaintext).
 */
export const SHORTCUT_BAR_D_TAG = "shortcut-bar";

/** Tags for a shortcut-bar publish, mirroring the desktop's read-state shape. */
export function buildShortcutEventTags(): string[][] {
  return [
    ["d", SHORTCUT_BAR_D_TAG],
    ["t", "shortcut-bar"],
  ];
}

/**
 * `created_at` for the next publish: never older than anything already
 * fetched, so a clock running a minute behind another device cannot publish
 * a blob that loses to that device's older write.
 */
export function nextShortcutCreatedAt(
  maxFetchedCreatedAt: number,
  nowSeconds: number,
): number {
  return Math.max(Math.floor(nowSeconds), maxFetchedCreatedAt + 1);
}

/** The subset of a signed event this module reads. */
export interface ShortcutEventLike {
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
}

function tagValue(tags: string[][], name: string): string | null {
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === name && typeof tag[1] === "string") {
      return tag[1];
    }
  }
  return null;
}

/** True when the event sits on this feature's `d` coordinate. */
export function isShortcutBarEvent(event: ShortcutEventLike): boolean {
  return tagValue(event.tags, "d") === SHORTCUT_BAR_D_TAG;
}

/**
 * Fold a stream of shortcut-bar events down to the newest one.
 *
 * The relay replaces server-side per `(pubkey, kind, d)`, but a historical
 * replay and a live update can still deliver an old and a new copy in either
 * order, so the fold is newest-`created_at`-wins — the NIP-33 rule applied on
 * the client. Events on a foreign `d` coordinate are ignored, not folded.
 */
export function reduceShortcutEvents(
  events: readonly ShortcutEventLike[],
): ShortcutEventLike | null {
  let newest: ShortcutEventLike | null = null;
  for (const event of events) {
    if (!isShortcutBarEvent(event)) {
      continue;
    }
    if (newest && newest.created_at >= event.created_at) {
      continue;
    }
    newest = event;
  }
  return newest;
}
