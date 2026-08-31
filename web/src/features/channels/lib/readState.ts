/**
 * Client-side read state: the last message id (and timestamp) the user has
 * seen per channel, persisted in localStorage. Unread = messages newer than
 * the marker; badges and the timeline unread divider derive from it.
 */

const READ_STATE_KEY = "buzz.read-state.v1";

export interface ReadState {
  /** channelId → newest SEEN message createdAt (unix seconds). */
  [channelId: string]: number;
}

export function loadReadState(): ReadState {
  try {
    const raw = globalThis.localStorage?.getItem(READ_STATE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as ReadState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveReadState(state: ReadState): void {
  try {
    globalThis.localStorage?.setItem(READ_STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable — read state stays session-local.
  }
}

/** Mark everything up to `createdAt` as seen for a channel. */
export function markSeen(
  state: ReadState,
  channelId: string,
  createdAt: number,
): ReadState {
  if ((state[channelId] ?? 0) >= createdAt) {
    return state;
  }
  return { ...state, [channelId]: createdAt };
}

/**
 * Count unread messages given a channel's newest message timestamp and its
 * read marker. This is the cheap badge form: unread when newest > marker.
 * Returns 0 or 1 (a dot) rather than a count — counts need the full buffer,
 * which the sidebar doesn't hold.
 */
export function isUnread(
  state: ReadState,
  channelId: string,
  newestCreatedAt: number,
): boolean {
  return newestCreatedAt > (state[channelId] ?? 0);
}
