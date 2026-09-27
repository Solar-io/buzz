/**
 * DM hiding, relay-synced via NIP-DV (docs/nips/NIP-DV.md). Hide = a
 * user-signed kind:41012 with an `h` tag; re-opening (kind:41010) un-hides.
 * The relay re-publishes a relay-signed kind:30622 snapshot per viewer
 * (d = p = viewer pubkey, one `h` per hidden DM) and the NEWEST snapshot is
 * the source of truth. localStorage ("buzz:dm-hidden") is only an
 * optimistic/offline cache used until a snapshot arrives. Import-free for
 * the node test runner.
 */

const STORAGE_KEY = "buzz:dm-hidden";
const MIGRATED_KEY_PREFIX = "buzz:dm-hidden-migrated:";

export const DM_HIDE_KIND = 41012;
export const DM_VISIBILITY_SNAPSHOT_KIND = 30622;

export function loadHiddenDms(storage: Storage | null): string[] {
  if (!storage) {
    return [];
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export function saveHiddenDms(storage: Storage | null, ids: string[]): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(Array.from(new Set(ids))));
  } catch {
    // Quota/private-mode failures just lose the cache — never fatal.
  }
}

export function hideDm(ids: string[], channelId: string): string[] {
  return ids.includes(channelId) ? ids : [...ids, channelId];
}

export function unhideDm(ids: string[], channelId: string): string[] {
  return ids.filter((id) => id !== channelId);
}

interface SnapshotLike {
  id: string;
  kind: number;
  created_at: number;
  tags: string[][];
}

export interface HiddenSnapshot {
  id: string;
  createdAt: number;
  ids: string[];
}

/** REQ filter for the viewer's own snapshot (#p is the relay's read gate). */
export function hiddenDmSnapshotFilter(selfPubkey: string): {
  kinds: number[];
  "#p": string[];
  limit: number;
} {
  return {
    kinds: [DM_VISIBILITY_SNAPSHOT_KIND],
    "#p": [selfPubkey],
    limit: 1,
  };
}

/**
 * Parse a kind:30622 snapshot for `selfPubkey`; null unless it is a snapshot
 * addressed to this viewer (d and p both = self). The web does not know the
 * relay's NIP-11 `self` pubkey, so — like mobile — it relies on the relay
 * rejecting client-authored 30622 (NIP-DV §Security) for authenticity.
 */
export function parseHiddenSnapshot(
  event: SnapshotLike,
  selfPubkey: string,
): HiddenSnapshot | null {
  if (event.kind !== DM_VISIBILITY_SNAPSHOT_KIND) {
    return null;
  }
  const d = event.tags.find((tag) => tag[0] === "d")?.[1];
  const p = event.tags.find((tag) => tag[0] === "p")?.[1];
  if (d !== selfPubkey || p !== selfPubkey) {
    return null;
  }
  const ids = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] === "h" && typeof tag[1] === "string" && tag[1]) {
      ids.add(tag[1]);
    }
  }
  return { id: event.id, createdAt: event.created_at, ids: [...ids] };
}

/** Keep the newer snapshot (created_at, then lowest id per NIP-01). */
export function newerSnapshot(
  current: HiddenSnapshot | null,
  candidate: HiddenSnapshot,
): HiddenSnapshot {
  if (!current) return candidate;
  if (candidate.createdAt !== current.createdAt) {
    return candidate.createdAt > current.createdAt ? candidate : current;
  }
  return candidate.id < current.id ? candidate : current;
}

/**
 * An optimistic local change not yet reflected by a snapshot. `at` is the
 * unix-seconds time it was made; a snapshot at or after that time supersedes
 * it (the relay stamps the snapshot after processing the command).
 */
export interface PendingHideChange {
  hidden: boolean;
  at: number;
}

/**
 * Effective hidden set: the snapshot (or the offline cache before any
 * snapshot arrived) with still-pending optimistic changes on top. Also
 * returns the pending entries no snapshot has superseded yet.
 */
export function effectiveHiddenDms(
  snapshot: HiddenSnapshot | null,
  cached: readonly string[],
  pending: ReadonlyMap<string, PendingHideChange>,
): { hidden: string[]; pending: Map<string, PendingHideChange> } {
  const base = new Set(snapshot ? snapshot.ids : cached);
  const remaining = new Map<string, PendingHideChange>();
  for (const [id, change] of pending) {
    if (snapshot && snapshot.createdAt >= change.at) {
      continue;
    }
    remaining.set(id, change);
    if (change.hidden) base.add(id);
    else base.delete(id);
  }
  return { hidden: [...base], pending: remaining };
}

/** Locally-hidden ids the relay does not know about (one-time migration). */
export function migrationCandidates(
  localIds: readonly string[],
  snapshot: HiddenSnapshot | null,
): string[] {
  const relay = new Set(snapshot?.ids ?? []);
  return Array.from(new Set(localIds)).filter((id) => !relay.has(id));
}

/** Unsigned kind:41012 (buzz-cli cmd_hide_dm shape). */
export function hideDmEventTemplate(channelId: string): {
  kind: number;
  tags: string[][];
  content: string;
} {
  return { kind: DM_HIDE_KIND, tags: [["h", channelId]], content: "" };
}

export function isHiddenDmMigrationDone(
  storage: Storage | null,
  selfPubkey: string,
): boolean {
  try {
    return storage?.getItem(MIGRATED_KEY_PREFIX + selfPubkey) === "1";
  } catch {
    return false;
  }
}

export function markHiddenDmMigrationDone(
  storage: Storage | null,
  selfPubkey: string,
): void {
  try {
    storage?.setItem(MIGRATED_KEY_PREFIX + selfPubkey, "1");
  } catch {
    // Non-fatal: the migration re-runs next load (hides are idempotent).
  }
}
