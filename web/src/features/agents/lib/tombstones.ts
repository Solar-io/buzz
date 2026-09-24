/**
 * Local tombstones for replaceable coordinates the web itself deleted. The
 * live 30175/30176 subscriptions can still deliver the deleted head (a
 * late relay frame, a reconnect replay, or another open subscription), and
 * without a tombstone the row would reappear after a successful delete. The
 * rule mirrors the relay's NIP-09 a-tag semantics: a version at or before the
 * tombstone's created_at is dead; a strictly newer one is a re-creation and
 * is admitted. Pure, React-free for the node runner.
 */

/** Record a tombstone, keeping the latest created_at per id. */
export function applyTombstone(
  tombstones: ReadonlyMap<string, number>,
  id: string,
  tombstoneCreatedAt: number,
): Map<string, number> {
  const next = new Map(tombstones);
  const existing = next.get(id);
  if (existing === undefined || tombstoneCreatedAt > existing) {
    next.set(id, tombstoneCreatedAt);
  }
  return next;
}

/** Whether an arriving version survives the local tombstone for its id. */
export function admitAfterTombstone(
  tombstones: ReadonlyMap<string, number>,
  id: string,
  createdAt: number,
): boolean {
  const tombstone = tombstones.get(id);
  return tombstone === undefined || createdAt > tombstone;
}

/** Drop an id from a keyed map (the forget half of the hooks). */
export function withoutKey<V>(
  map: ReadonlyMap<string, V>,
  id: string,
): Map<string, V> {
  const next = new Map(map);
  next.delete(id);
  return next;
}
