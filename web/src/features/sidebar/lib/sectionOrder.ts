/**
 * Ordering for the sidebar's Favorites, Channels and Direct messages
 * sections (Sam, 2026-10-03):
 *
 * 1. Unread items on top, most recent activity first.
 * 2. The next {@link FREQUENT_SLOTS} are the ones the viewer most recently
 *    wrote in (Sam, 2026-10-04: "most frequently used recently" — the latest
 *    conversation goes to the top and bumps the oldest of the four). An item
 *    the viewer never wrote in does not qualify.
 * 3. Everything else alphabetically.
 *
 * Forums and Links keep their own orders — nothing here touches them.
 *
 * Ties break deterministically so two renders with the same inputs can never
 * disagree: name (case-insensitive), then key.
 *
 * Two stabilisers keep rows from moving under the pointer:
 *
 * 1. The OPEN item ranks by a snapshot of its facts taken when it was
 *    opened ({@link RankOptions.frozen}). Opening an unread channel clears
 *    its unread state; without the snapshot it would drop out of the unread
 *    group as soon as it was clicked. Its own-send score stays live, so
 *    writing there lifts it into the top four immediately. It re-ranks on
 *    all its live facts once the viewer navigates away.
 * 2. While the pointer is over the list the previous order is held
 *    ({@link holdOrder}): whatever re-ranks meanwhile (a new unread, the
 *    previously open item un-freezing on a click) waits until the pointer
 *    leaves, so a click can never land on a row that just slid into place.
 */

/** What an item is ranked by. */
export interface RankFacts {
  /** Unread rows sort to the top. */
  unread: boolean;
  /** When the viewer last wrote here (ownActivity.ts), unix s; 0 = never. */
  score: number;
  /** Newest activity, any monotonic unit (unix seconds here); higher first. */
  lastActivity: number;
  /** Display name, compared case-insensitively. */
  name: string;
}

export interface RankOptions {
  /** The open item's facts as they were when it was opened. */
  frozen?: { key: string; facts: RankFacts } | null;
}

/** How many read items rank by usage before the alphabetical remainder. */
export const FREQUENT_SLOTS = 4;

/** Scores closer than this are treated as equal (and 0 as never). */
const SCORE_EPSILON = 1e-6;

interface Ranked<T> {
  item: T;
  key: string;
  facts: RankFacts;
}

function byName<T>(a: Ranked<T>, b: Ranked<T>): number {
  const name = a.facts.name.localeCompare(b.facts.name, undefined, {
    sensitivity: "base",
  });
  if (name !== 0) return name;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function byRecency<T>(a: Ranked<T>, b: Ranked<T>): number {
  if (a.facts.lastActivity !== b.facts.lastActivity) {
    return b.facts.lastActivity - a.facts.lastActivity;
  }
  return byName(a, b);
}

function byUsage<T>(a: Ranked<T>, b: Ranked<T>): number {
  if (Math.abs(a.facts.score - b.facts.score) > SCORE_EPSILON) {
    return b.facts.score - a.facts.score;
  }
  return byName(a, b);
}

/**
 * Rank a section: unread by recency, then the {@link FREQUENT_SLOTS} most
 * used, then the rest by name. Returns a new array; the input is React-owned
 * and never mutated.
 */
export function rankSection<T>(
  items: readonly T[],
  getKey: (item: T) => string,
  factsOf: (item: T) => RankFacts,
  { frozen = null }: RankOptions = {},
): T[] {
  const unread: Ranked<T>[] = [];
  const read: Ranked<T>[] = [];
  for (const item of items) {
    const key = getKey(item);
    const live = factsOf(item);
    // The snapshot pins unread and recency; a send while open still counts
    // (Sam, 2026-10-05: writing in the open channel must lift it to the top).
    const facts =
      frozen !== null && frozen.key === key
        ? { ...frozen.facts, score: Math.max(frozen.facts.score, live.score) }
        : live;
    (facts.unread ? unread : read).push({ item, key, facts });
  }
  unread.sort(byRecency);
  const used = read
    .filter((entry) => entry.facts.score > SCORE_EPSILON)
    .sort(byUsage)
    .slice(0, FREQUENT_SLOTS);
  const frequent = new Set(used);
  const rest = read.filter((entry) => !frequent.has(entry)).sort(byName);
  return [...unread, ...used, ...rest].map((entry) => entry.item);
}

/** A per-row hold: the order on screen when the pointer reached `anchor`. */
export interface RowHold {
  /** Keys in the order they were displayed when the hold began. */
  order: readonly string[];
  /** The row under the pointer. */
  anchor: string;
}

/** Rows each side of the pointed-at row that also keep their place. */
export const ROW_HOLD_RADIUS = 1;

/**
 * Per-row hold (left-nav phase 3): only the row under the pointer and its
 * immediate neighbours keep the positions they had when the pointer got
 * there; every other row takes its live rank around them. A click can never
 * land on a row that just slid into place, while new unread rows still rise
 * — the old whole-list hold froze everything the moment the pointer rested
 * anywhere on the nav, which is how a newly unread DM stayed buried
 * (LEFT_NAV_ARCHITECTURE_REVIEW.md, cause B). Truncation then still lifts
 * any unread row the slice would hide (I5).
 */
export function holdAround<T>(
  items: readonly T[],
  getKey: (item: T) => string,
  hold: RowHold,
  radius = ROW_HOLD_RADIUS,
): T[] {
  const anchorAt = hold.order.indexOf(hold.anchor);
  if (anchorAt < 0) {
    return [...items];
  }
  const byKey = new Map(items.map((item) => [getKey(item), item]));
  const pinned = new Map<number, T>();
  const lo = Math.max(0, anchorAt - radius);
  const hi = Math.min(hold.order.length - 1, anchorAt + radius);
  for (let index = lo; index <= hi; index += 1) {
    const item = byKey.get(hold.order[index] as string);
    if (item !== undefined && index < items.length) {
      pinned.set(index, item);
    }
  }
  const pinnedItems = new Set(pinned.values());
  const rest = items.filter((item) => !pinnedItems.has(item));
  const out: T[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = pinned.get(index) ?? rest.shift();
    if (item !== undefined) out.push(item);
  }
  return out;
}

/**
 * Keep `heldKeys`' order for the items still present; items not in it (new
 * since the hold began) follow in their incoming order. Items that left are
 * simply gone.
 */
export function holdOrder<T>(
  items: readonly T[],
  getKey: (item: T) => string,
  heldKeys: readonly string[],
): T[] {
  const position = new Map(heldKeys.map((key, index) => [key, index]));
  const held: { item: T; index: number }[] = [];
  const fresh: T[] = [];
  for (const item of items) {
    const index = position.get(getKey(item));
    if (index === undefined) {
      fresh.push(item);
    } else {
      held.push({ item, index });
    }
  }
  held.sort((a, b) => a.index - b.index);
  return [...held.map((entry) => entry.item), ...fresh];
}
