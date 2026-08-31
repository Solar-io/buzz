/**
 * Local channel preferences (starred / muted), persisted in localStorage.
 * These are viewer-side prefs — the desktop keeps them in its local DB; the
 * web's equivalent local store is localStorage.
 */

const PREFS_KEY = "buzz.channel-prefs.v1";

export interface ChannelPrefs {
  starred: string[];
  muted: string[];
}

export function loadChannelPrefs(): ChannelPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(PREFS_KEY);
    if (!raw) {
      return { starred: [], muted: [] };
    }
    const parsed = JSON.parse(raw) as Partial<ChannelPrefs>;
    const starred = Array.isArray(parsed.starred)
      ? parsed.starred.filter((id): id is string => typeof id === "string")
      : [];
    const muted = Array.isArray(parsed.muted)
      ? parsed.muted.filter((id): id is string => typeof id === "string")
      : [];
    return { starred, muted };
  } catch {
    return { starred: [], muted: [] };
  }
}

function savePrefs(prefs: ChannelPrefs): void {
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Best-effort by design.
  }
}

export function isStarred(prefs: ChannelPrefs, channelId: string): boolean {
  return prefs.starred.includes(channelId);
}

export function isMuted(prefs: ChannelPrefs, channelId: string): boolean {
  return prefs.muted.includes(channelId);
}

/** Returns the next prefs — the caller persists them to React state. */
export function toggleStarred(
  prefs: ChannelPrefs,
  channelId: string,
): ChannelPrefs {
  const starred = prefs.starred.includes(channelId)
    ? prefs.starred.filter((id) => id !== channelId)
    : [...prefs.starred, channelId];
  const next = { ...prefs, starred };
  savePrefs(next);
  return next;
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
    starred: prefs.starred.filter((id) => id !== channelId),
    muted: prefs.muted.filter((id) => id !== channelId),
  };
  savePrefs(next);
  return next;
}
