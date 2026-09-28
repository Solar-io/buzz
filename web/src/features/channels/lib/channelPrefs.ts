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
 */

const PREFS_KEY = "buzz.channel-prefs.v1";

export type FavoriteKind = "channel" | "link";

export interface FavoriteRef {
  kind: FavoriteKind;
  id: string;
}

export interface ChannelPrefs {
  /** Favorited conversations and links, in the order they were added. */
  favorites: FavoriteRef[];
  muted: string[];
}

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
    const key = `${ref.kind}:${ref.id}`;
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
    };
  } catch {
    return emptyPrefs();
  }
}

function savePrefs(prefs: ChannelPrefs): void {
  try {
    globalThis.localStorage?.setItem(
      PREFS_KEY,
      JSON.stringify({
        favorites: prefs.favorites,
        muted: prefs.muted,
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
): ChannelPrefs {
  if (isFavorite(prefs, ref) === favorite) {
    return prefs;
  }
  const favorites = favorite
    ? [...prefs.favorites, { kind: ref.kind, id: ref.id }]
    : prefs.favorites.filter((entry) => !sameRef(entry, ref));
  const next = { ...prefs, favorites };
  savePrefs(next);
  return next;
}

export function toggleFavorite(
  prefs: ChannelPrefs,
  ref: FavoriteRef,
): ChannelPrefs {
  return setFavorite(prefs, ref, !isFavorite(prefs, ref));
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
): ChannelPrefs {
  const next = {
    favorites: prefs.favorites.filter(
      (ref) => !(ref.kind === "channel" && ref.id === channelId),
    ),
    muted: prefs.muted.filter((id) => id !== channelId),
  };
  savePrefs(next);
  return next;
}
