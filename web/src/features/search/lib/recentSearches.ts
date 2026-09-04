/**
 * Recent searches — the one thing here the desktop does not have.
 *
 * The desktop's ⌘K keeps no history at all, so re-running yesterday's query
 * means retyping it. This is a browser-local list, most recent first, capped
 * and de-duplicated case-insensitively. It is deliberately *not* synced: a
 * search history is a record of what someone was looking for, and publishing
 * that to a relay for every device to read is a privacy decision nobody asked
 * for.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

export const RECENT_SEARCHES_MAX = 8;
export const RECENT_SEARCHES_STORAGE_KEY = "buzz:recent-searches.v1";

export interface RecentSearchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Add a query to the front of the list.
 *
 * Case-insensitive de-duplication, but the **new** casing wins: the user just
 * typed it, so that is the spelling they will recognize.
 */
export function rememberSearch(
  recent: readonly string[],
  query: string,
): string[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [...recent];
  }
  const needle = trimmed.toLowerCase();
  const rest = recent.filter((entry) => entry.trim().toLowerCase() !== needle);
  return [trimmed, ...rest].slice(0, RECENT_SEARCHES_MAX);
}

export function forgetSearch(
  recent: readonly string[],
  query: string,
): string[] {
  const needle = query.trim().toLowerCase();
  return recent.filter((entry) => entry.trim().toLowerCase() !== needle);
}

export function readRecentSearches(
  storage: RecentSearchStorage | null | undefined,
): string[] {
  if (!storage) {
    return [];
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(RECENT_SEARCHES_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .slice(0, RECENT_SEARCHES_MAX);
  } catch {
    return [];
  }
}

export function writeRecentSearches(
  storage: RecentSearchStorage | null | undefined,
  recent: readonly string[],
): void {
  if (!storage) {
    return;
  }
  try {
    if (recent.length === 0) {
      storage.removeItem(RECENT_SEARCHES_STORAGE_KEY);
      return;
    }
    storage.setItem(
      RECENT_SEARCHES_STORAGE_KEY,
      JSON.stringify(recent.slice(0, RECENT_SEARCHES_MAX)),
    );
  } catch {
    // Private mode or quota — the panel works, it just forgets.
  }
}
