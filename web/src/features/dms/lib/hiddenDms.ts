/**
 * Local DM hiding — the desktop's hide_dm equivalent. DMs are participant-
 * keyed, not relay channels, so "remove from list" is a client-side hide:
 * the set of hidden channel ids persists in localStorage and re-opening the
 * DM (via the new-DM flow) un-hides it. Import-free for the node test runner.
 */

const STORAGE_KEY = "buzz:dm-hidden";

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
    // Quota/private-mode failures just lose the hide — never fatal.
  }
}

export function hideDm(ids: string[], channelId: string): string[] {
  return ids.includes(channelId) ? ids : [...ids, channelId];
}

export function unhideDm(ids: string[], channelId: string): string[] {
  return ids.filter((id) => id !== channelId);
}
