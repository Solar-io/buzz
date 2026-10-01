/**
 * Cross-device sidebar favorites — the pure half (envelope, blob, merge).
 * The lifecycle (subscribe, decrypt, publish) is `favoritesSyncEngine.ts`.
 *
 * ENVELOPE: the Links mechanism (`shortcut-bar/lib/shortcutEvent.ts`) — ONE
 * kind-30078 (NIP-78 app data) event per user, parameterized-replaceable,
 * stored globally-only by the relay (so no `h` tag), its content NIP-44
 * sealed to the author's own pubkey. Only the `d` coordinate differs:
 * `d="sidebar-favorites"`. Favorites name channel and DM ids, so they must
 * never ride in plaintext.
 *
 * MERGE: unlike Links (whole-blob last-write-wins), favorites MERGE, because
 * the first sync on a device that already has favorites must never wipe
 * them. Every entry carries an epoch-ms stamp — `at` on a favorite is when it
 * was added, on a tombstone when it was removed — and per key the newest
 * stamp wins, a tie going to the favorite (losing a removal is recoverable,
 * losing a favorite is the bug this exists to prevent). A local favorite
 * from before sync has no stamp (0), so it survives everything but an
 * explicit later removal. Order: the remote set's order first, then
 * local-only additions in their local order.
 *
 * Pure and import-light so `node --test` loads it directly.
 */

import {
  type ChannelPrefs,
  type FavoriteRef,
  type FavoriteTombstone,
  favoriteKey,
  tombstoneList,
} from "./channelPrefs.ts";

/** NIP-78 app data — the kind Links already use. */
export const KIND_FAVORITES = 30078;

/** The favorites coordinate (Links use `shortcut-bar`). */
export const FAVORITES_D_TAG = "sidebar-favorites";

export const FAVORITES_BLOB_VERSION = 1;

/** A favorite with the time it was added (epoch ms; 0 = before sync). */
export interface StampedFavorite extends FavoriteRef {
  at: number;
}

/** The decrypted content of a favorites event. */
export interface FavoritesBlob {
  v: typeof FAVORITES_BLOB_VERSION;
  /** In display order. */
  favorites: StampedFavorite[];
  /** Removals, so other devices drop them too. */
  removed: FavoriteTombstone[];
}

export function emptyFavoritesBlob(): FavoritesBlob {
  return { v: FAVORITES_BLOB_VERSION, favorites: [], removed: [] };
}

export function buildFavoritesEventTags(): string[][] {
  return [
    ["d", FAVORITES_D_TAG],
    ["t", FAVORITES_D_TAG],
  ];
}

/**
 * `created_at` for the next publish: never older than anything seen, so a
 * device whose clock runs behind cannot publish a set that loses to an older
 * one at the relay (it replaces per coordinate on `created_at`).
 */
export function nextFavoritesCreatedAt(
  maxSeenCreatedAt: number,
  nowSeconds: number,
): number {
  return Math.max(Math.floor(nowSeconds), maxSeenCreatedAt + 1);
}

function isFavoriteEntry(value: unknown): value is FavoriteRef {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { kind, id } = value as Record<string, unknown>;
  return (kind === "channel" || kind === "link") && typeof id === "string";
}

/**
 * A relay entry's stamp; a missing or invalid one reads as 0 (like a
 * pre-sync local favorite) so the entry is merged, never dropped and then
 * overwritten by this device's publish.
 */
function entryStamp(value: unknown): number {
  const at = (value as { at?: unknown }).at;
  return typeof at === "number" && Number.isFinite(at) && at >= 0 ? at : 0;
}

export type ParsedFavoritesBlob =
  | { ok: true; blob: FavoritesBlob }
  | { ok: false; reason: "malformed" | "future-version" };

/**
 * Validate a decrypted blob. A newer `v` is refused rather than read, so
 * this build never republishes over a shape it does not understand.
 */
export function parseFavoritesBlob(raw: unknown): ParsedFavoritesBlob {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "malformed" };
  }
  const { v, favorites, removed } = raw as Record<string, unknown>;
  if (typeof v !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (v > FAVORITES_BLOB_VERSION) {
    return { ok: false, reason: "future-version" };
  }
  if (!Array.isArray(favorites)) {
    return { ok: false, reason: "malformed" };
  }
  const seen = new Set<string>();
  const list: StampedFavorite[] = [];
  for (const entry of favorites) {
    if (!isFavoriteEntry(entry) || seen.has(favoriteKey(entry))) {
      continue;
    }
    seen.add(favoriteKey(entry));
    list.push({ kind: entry.kind, id: entry.id, at: entryStamp(entry) });
  }
  return {
    ok: true,
    blob: {
      v: FAVORITES_BLOB_VERSION,
      favorites: list,
      removed: tombstoneList(removed),
    },
  };
}

/** The blob this device would publish for its local prefs. */
export function blobFromPrefs(prefs: ChannelPrefs): FavoritesBlob {
  const stamps = prefs.favoriteAt ?? {};
  return {
    v: FAVORITES_BLOB_VERSION,
    favorites: prefs.favorites.map((ref) => ({
      kind: ref.kind,
      id: ref.id,
      at: stamps[favoriteKey(ref)] ?? 0,
    })),
    removed: tombstoneList(prefs.removed ?? []),
  };
}

/** Local prefs carrying `blob`'s favorites (muted and the rest untouched). */
export function prefsWithBlob(
  prefs: ChannelPrefs,
  blob: FavoritesBlob,
): ChannelPrefs {
  const favoriteAt: Record<string, number> = {};
  for (const entry of blob.favorites) {
    favoriteAt[favoriteKey(entry)] = entry.at;
  }
  return {
    ...prefs,
    favorites: blob.favorites.map(({ kind, id }) => ({ kind, id })),
    favoriteAt,
    removed: blob.removed,
  };
}

/** Byte-for-byte comparable form (order matters for favorites). */
export function canonicalFavoritesBlob(blob: FavoritesBlob): string {
  return JSON.stringify({
    v: blob.v,
    favorites: blob.favorites.map(({ kind, id, at }) => ({ kind, id, at })),
    removed: tombstoneList(blob.removed).map(({ kind, id, at }) => ({
      kind,
      id,
      at,
    })),
  });
}

/**
 * Merge the relay's set with this device's. Null `remote` = the relay has
 * none yet, which merges exactly like an empty set: local survives whole.
 */
export function mergeFavorites(
  remote: FavoritesBlob | null,
  local: FavoritesBlob,
): FavoritesBlob {
  const theirs = remote ?? emptyFavoritesBlob();
  const favAt = new Map<string, number>();
  const tombAt = new Map<string, number>();
  for (const entry of [...theirs.favorites, ...local.favorites]) {
    const key = favoriteKey(entry);
    favAt.set(key, Math.max(favAt.get(key) ?? -1, entry.at));
  }
  for (const tomb of [...theirs.removed, ...local.removed]) {
    const key = favoriteKey(tomb);
    tombAt.set(key, Math.max(tombAt.get(key) ?? -1, tomb.at));
  }
  // Per key: the newest stamp wins; a tie keeps the favorite.
  const alive = (key: string) =>
    favAt.has(key) && (favAt.get(key) ?? 0) >= (tombAt.get(key) ?? -1);

  const favorites: StampedFavorite[] = [];
  const placed = new Set<string>();
  for (const entry of [...theirs.favorites, ...local.favorites]) {
    const key = favoriteKey(entry);
    if (placed.has(key) || !alive(key)) {
      continue;
    }
    placed.add(key);
    favorites.push({ kind: entry.kind, id: entry.id, at: favAt.get(key) ?? 0 });
  }
  const removed: FavoriteTombstone[] = [];
  for (const tomb of [...theirs.removed, ...local.removed]) {
    const key = favoriteKey(tomb);
    if (placed.has(key)) {
      continue;
    }
    placed.add(key);
    removed.push({ kind: tomb.kind, id: tomb.id, at: tombAt.get(key) ?? 0 });
  }
  return {
    v: FAVORITES_BLOB_VERSION,
    favorites,
    removed: tombstoneList(removed),
  };
}

/** What one sync round decided, for the engine to act on. */
export interface FavoritesSyncPlan {
  merged: FavoritesBlob;
  /** The merge changed this device's favorites: save and re-render. */
  localChanged: boolean;
  /** The relay's copy is missing or behind the merge: publish `merged`. */
  publish: boolean;
}

/**
 * One sync round. `remote` is the decrypted relay copy (null when the relay
 * has none). Publishing an empty set over an absent one is skipped — there
 * is nothing another device could gain from it.
 */
export function planFavoritesSync(
  remote: FavoritesBlob | null,
  local: FavoritesBlob,
): FavoritesSyncPlan {
  const merged = mergeFavorites(remote, local);
  const mergedText = canonicalFavoritesBlob(merged);
  const empty = merged.favorites.length === 0 && merged.removed.length === 0;
  return {
    merged,
    localChanged: mergedText !== canonicalFavoritesBlob(local),
    publish:
      remote === null ? !empty : mergedText !== canonicalFavoritesBlob(remote),
  };
}
