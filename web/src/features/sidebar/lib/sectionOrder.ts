/**
 * Ordering for the sidebar's Favorites and Channels sections (Sam,
 * 2026-09-29): unread items on top, and within the unread group and within
 * the rest, most frequently used first. DMs, Forums and Links keep their own
 * orders — nothing here touches them.
 *
 * Ties break deterministically so two renders with the same inputs can never
 * disagree: newest activity first, then name (case-insensitive), then key.
 *
 * Two stabilisers keep rows from moving under the pointer:
 *
 * 1. The OPEN item ranks by a snapshot of its facts taken when it was
 *    opened ({@link RankOptions.frozen}). Opening an unread channel clears
 *    its unread state and bumps its visit score a moment later; without the
 *    snapshot it would drop out of the unread group as soon as it was
 *    clicked. It re-ranks on its live facts once the viewer navigates away.
 * 2. While the pointer is over the list the previous order is held
 *    ({@link holdOrder}): whatever re-ranks meanwhile (a new unread, the
 *    previously open item un-freezing on a click) waits until the pointer
 *    leaves, so a click can never land on a row that just slid into place.
 */

/** What an item is ranked by. */
export interface RankFacts {
  /** Unread rows sort to the top. */
  unread: boolean;
  /** Decayed visit score (visitFrequency.ts); higher first. */
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

/** Visit scores closer than this are treated as equal (float decay noise). */
const SCORE_EPSILON = 1e-6;

function compareFacts(
  a: RankFacts,
  aKey: string,
  b: RankFacts,
  bKey: string,
): number {
  if (a.unread !== b.unread) return a.unread ? -1 : 1;
  if (Math.abs(a.score - b.score) > SCORE_EPSILON) return b.score - a.score;
  if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity;
  const byName = a.name.localeCompare(b.name, undefined, {
    sensitivity: "base",
  });
  if (byName !== 0) return byName;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

/**
 * Rank a section: unread first, then visit score, then the tie-breaks.
 * Returns a new array; the input is React-owned and never mutated.
 */
export function rankSection<T>(
  items: readonly T[],
  getKey: (item: T) => string,
  factsOf: (item: T) => RankFacts,
  { frozen = null }: RankOptions = {},
): T[] {
  const ranked = items.map((item) => {
    const key = getKey(item);
    const facts =
      frozen !== null && frozen.key === key ? frozen.facts : factsOf(item);
    return { item, key, facts };
  });
  ranked.sort((a, b) => compareFacts(a.facts, a.key, b.facts, b.key));
  return ranked.map((entry) => entry.item);
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
