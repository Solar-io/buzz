/**
 * Local nicknames — "what I call this person", stored only in this browser.
 *
 * Nostr display names are self-asserted and mutable: two people can publish
 * "alice", and the one you know can change theirs tomorrow. A local label is
 * the client-side answer, and it must never be published — renaming somebody
 * in your own client is a private note, not an assertion about them, and
 * writing it to a relay would broadcast a judgement the user did not make.
 * So this is `localStorage` and nothing else.
 *
 * A label is a *preference*, never an identity: `labelledName` falls back to
 * the published name and finally to the truncated key, and callers still show
 * the npub, so a nickname cannot be used to impersonate.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

export const USER_LABELS_STORAGE_KEY = "buzz:user-labels.v1";
/** Keeps a hand-maintained list from growing without bound. */
export const MAX_USER_LABELS = 500;
/** Long enough for a real name, short enough not to be a note. */
export const MAX_USER_LABEL_LENGTH = 48;

export interface UserLabelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type UserLabels = Record<string, string>;

function normalizeKey(pubkey: string): string {
  return pubkey.trim().toLowerCase();
}

/** Trim and clamp a typed label; empty means "no label". */
export function normalizeLabel(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_USER_LABEL_LENGTH);
}

export function readUserLabels(
  storage: UserLabelStorage | null | undefined,
): UserLabels {
  if (!storage) {
    return {};
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(USER_LABELS_STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const labels: UserLabels = {};
    for (const [pubkey, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        continue;
      }
      const label = normalizeLabel(value);
      if (label.length > 0) {
        labels[normalizeKey(pubkey)] = label;
      }
    }
    return labels;
  } catch {
    return {};
  }
}

export function writeUserLabels(
  storage: UserLabelStorage | null | undefined,
  labels: UserLabels,
): void {
  if (!storage) {
    return;
  }
  try {
    const entries = Object.entries(labels).slice(0, MAX_USER_LABELS);
    if (entries.length === 0) {
      storage.removeItem(USER_LABELS_STORAGE_KEY);
      return;
    }
    storage.setItem(
      USER_LABELS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // Private mode or quota — labels are a convenience, never load-bearing.
  }
}

/** Set or clear one label. An empty label removes the entry entirely. */
export function setUserLabel(
  labels: UserLabels,
  pubkey: string,
  rawLabel: string,
): UserLabels {
  const key = normalizeKey(pubkey);
  const label = normalizeLabel(rawLabel);
  const next = { ...labels };
  if (label.length === 0) {
    delete next[key];
    return next;
  }
  next[key] = label;
  return next;
}

/**
 * The name to show: the local label wins, then the published name, then the
 * truncated key the caller supplies.
 */
export function labelledName(
  labels: UserLabels,
  pubkey: string,
  publishedName: string | null | undefined,
  fallback: string,
): string {
  const label = labels[normalizeKey(pubkey)];
  if (label) {
    return label;
  }
  const published = publishedName?.trim();
  return published && published.length > 0 ? published : fallback;
}

/** True when a local label is standing in for a different published name. */
export function isRenamed(
  labels: UserLabels,
  pubkey: string,
  publishedName: string | null | undefined,
): boolean {
  const label = labels[normalizeKey(pubkey)];
  if (!label) {
    return false;
  }
  return label !== publishedName?.trim();
}
