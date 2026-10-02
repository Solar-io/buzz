/**
 * Local channel preferences (favorites / muted), persisted in localStorage.
 * These are viewer-side prefs — the desktop keeps them in its local DB; the
 * web's equivalent local store is localStorage.
 *
 * FAVORITES replaced the channel-only "starred" list. A favorite is a typed
 * reference so it can point at more than channels:
 *   - `channel` — any relay conversation id: a stream, a forum or a DM (they
 *     share one id space; the row kind is read off the live data, so a
 *     favorite follows a channel whose type changes).
 *   - `link` — a sidebar shortcut, by its stable `ShortcutDef.id` (`sc:<n>`),
 *     never by its label.
 * The array is kept in the order favorites were added.
 *
 * MIGRATION: the key and file are unchanged. A stored value without
 * `favorites` (every value written before this change) loads its `starred`
 * channel ids as channel favorites, in their stored order, with no user
 * action. Saves also write `starred` (the channel favorites) so a build from
 * before this change, on the same device, still sees its stars.
 *
 * CROSS-DEVICE SYNC (`favoritesSync.ts`): this file stays the offline cache
 * and the only writer of favorites on this device. Each add stamps
 * `favoriteAt[key]`, each removal leaves a tombstone in `removed`, so the
 * sync merge can tell a fresh unfavorite from a stale device's old copy. A
 * favorite stored before sync existed carries no stamp and merges as time 0:
 * it survives every merge except an explicit, later removal.
 */

const PREFS_KEY = "buzz.channel-prefs.v1";

export type FavoriteKind = "channel" | "link";

export interface FavoriteRef {
  kind: FavoriteKind;
  id: string;
}

/** An unfavorite, remembered so a stale device cannot resurrect it. */
export interface FavoriteTombstone extends FavoriteRef {
  /** Epoch ms of the removal. */
  at: number;
}

export interface ChannelPrefs {
  /** Favorited conversations and links, in the order they were added. */
  favorites: FavoriteRef[];
  muted: string[];
  /** Epoch ms each favorite was added, by {@link favoriteKey}; absent = 0. */
  favoriteAt?: Record<string, number>;
  /** Removed favorites (sync tombstones), oldest first. */
  removed?: FavoriteTombstone[];
}

/** The identity of a favorite across devices: `kind:id`. */
export function favoriteKey(ref: FavoriteRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** Tombstones kept per user; the oldest fall off first. */
export const MAX_FAVORITE_TOMBSTONES = 200;

function emptyPrefs(): ChannelPrefs {
  return { favorites: [], muted: [] };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
}

function isFavoriteRef(value: unknown): value is FavoriteRef {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { kind, id } = value as { kind?: unknown; id?: unknown };
  return (kind === "channel" || kind === "link") && typeof id === "string";
}

/** Drop duplicates, keeping the FIRST occurrence (the add order). */
function dedupeRefs(refs: FavoriteRef[]): FavoriteRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = favoriteKey(ref);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function loadChannelPrefs(): ChannelPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY);
    if (!raw) {
      return emptyPrefs();
    }
    const parsed = JSON.parse(raw) as {
      favorites?: unknown;
      starred?: unknown;
      muted?: unknown;
      favoriteAt?: unknown;
      removed?: unknown;
    };
    const favorites = Array.isArray(parsed.favorites)
      ? parsed.favorites
          .filter(isFavoriteRef)
          .map(({ kind, id }) => ({ kind, id }))
      : // Pre-favorites shape: starred channel ids become channel favorites.
        stringList(parsed.starred).map((id) => ({
          kind: "channel" as const,
          id,
        }));
    return {
      favorites: dedupeRefs(favorites),
      muted: stringList(parsed.muted),
      favoriteAt: stampMap(parsed.favoriteAt),
      removed: tombstoneList(parsed.removed),
    };
  } catch {
    return emptyPrefs();
  }
}

function isStamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function stampMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return out;
  }
  for (const [key, at] of Object.entries(value)) {
    if (isStamp(at)) {
      out[key] = at;
    }
  }
  return out;
}

/** Valid tombstones, one per key (the newest), oldest first, capped. */
export function tombstoneList(value: unknown): FavoriteTombstone[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const byKey = new Map<string, FavoriteTombstone>();
  for (const entry of value) {
    if (!isFavoriteRef(entry) || !isStamp((entry as { at?: unknown }).at)) {
      continue;
    }
    const tomb = {
      kind: entry.kind,
      id: entry.id,
      at: (entry as FavoriteTombstone).at,
    };
    const key = favoriteKey(tomb);
    const held = byKey.get(key);
    if (!held || held.at < tomb.at) {
      byKey.set(key, tomb);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_FAVORITE_TOMBSTONES);
}

/** Persist prefs as-is (the sync merge's write path; mutators call it too). */
export function saveChannelPrefs(prefs: ChannelPrefs): void {
  savePrefs(prefs);
}

function savePrefs(prefs: ChannelPrefs): void {
  try {
    globalThis.localStorage?.setItem(
      PREFS_KEY,
      JSON.stringify({
        favorites: prefs.favorites,
        muted: prefs.muted,
        favoriteAt: prefs.favoriteAt ?? {},
        removed: prefs.removed ?? [],
        // Back-compat mirror for older builds; never read when favorites is.
        starred: favoriteChannelIds(prefs),
      }),
    );
  } catch {
    // Best-effort by design.
  }
}

function sameRef(a: FavoriteRef, b: FavoriteRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export function isFavorite(prefs: ChannelPrefs, ref: FavoriteRef): boolean {
  return prefs.favorites.some((entry) => sameRef(entry, ref));
}

/** Channel ids (streams, forums, DMs) the viewer favorited, in add order. */
export function favoriteChannelIds(prefs: ChannelPrefs): string[] {
  return prefs.favorites
    .filter((ref) => ref.kind === "channel")
    .map((ref) => ref.id);
}

export function isMuted(prefs: ChannelPrefs, channelId: string): boolean {
  return prefs.muted.includes(channelId);
}

/**
 * Idempotent add / remove — returns the next prefs (the same object when
 * nothing changes); the caller puts them in React state. Adding appends, so
 * favorites keep their add order; removing keeps the rest in place.
 */
export function setFavorite(
  prefs: ChannelPrefs,
  ref: FavoriteRef,
  favorite: boolean,
  now: number = Date.now(),
): ChannelPrefs {
  if (isFavorite(prefs, ref) === favorite) {
    return prefs;
  }
  const next = favorite
    ? withFavoriteAdded(prefs, ref, now)
    : withFavoriteRemoved(prefs, ref, now);
  savePrefs(next);
  return next;
}

/** Append `ref`, stamp it, and lift any tombstone it had. */
function withFavoriteAdded(
  prefs: ChannelPrefs,
  ref: FavoriteRef,
  now: number,
): ChannelPrefs {
  const key = favoriteKey(ref);
  // Stamp past the tombstone this device holds, so a clock running behind
  // the device that removed it cannot lose the re-add in the merge.
  const tomb = (prefs.removed ?? []).find((t) => favoriteKey(t) === key);
  const at = tomb ? Math.max(now, tomb.at + 1) : now;
  return {
    ...prefs,
    favorites: [...prefs.favorites, { kind: ref.kind, id: ref.id }],
    favoriteAt: { ...prefs.favoriteAt, [key]: at },
    removed: (prefs.removed ?? []).filter((tomb) => favoriteKey(tomb) !== key),
  };
}

/** Drop `ref` and leave a tombstone so the removal syncs. */
function withFavoriteRemoved(
  prefs: ChannelPrefs,
  ref: FavoriteRef,
  now: number,
): ChannelPrefs {
  const key = favoriteKey(ref);
  const favoriteAt = { ...prefs.favoriteAt };
  // Stamp past the add this device saw (it may come from a device whose
  // clock runs ahead), or the merge would resurrect the favorite.
  const at = Math.max(now, (favoriteAt[key] ?? -1) + 1);
  delete favoriteAt[key];
  return {
    ...prefs,
    favorites: prefs.favorites.filter((entry) => !sameRef(entry, ref)),
    favoriteAt,
    removed: tombstoneList([
      ...(prefs.removed ?? []),
      { kind: ref.kind, id: ref.id, at },
    ]),
  };
}

export function toggleFavorite(
  prefs: ChannelPrefs,
  ref: FavoriteRef,
  now: number = Date.now(),
): ChannelPrefs {
  return setFavorite(prefs, ref, !isFavorite(prefs, ref), now);
}

export function toggleMuted(
  prefs: ChannelPrefs,
  channelId: string,
): ChannelPrefs {
  const muted = prefs.muted.includes(channelId)
    ? prefs.muted.filter((id) => id !== channelId)
    : [...prefs.muted, channelId];
  const next = { ...prefs, muted };
  savePrefs(next);
  return next;
}

/** Remove every trace of a channel (after leaving it). */
export function forgetChannel(
  prefs: ChannelPrefs,
  channelId: string,
  now: number = Date.now(),
): ChannelPrefs {
  const ref: FavoriteRef = { kind: "channel", id: channelId };
  // A favorite of a channel left behind is unfavorited everywhere.
  const base = isFavorite(prefs, ref)
    ? withFavoriteRemoved(prefs, ref, now)
    : prefs;
  const next = {
    ...base,
    muted: prefs.muted.filter((id) => id !== channelId),
  };
  savePrefs(next);
  return next;
}
