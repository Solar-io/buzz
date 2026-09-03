/**
 * Per-thread read markers.
 *
 * WHY THIS IS A SEPARATE MODULE, stated plainly because it is a finding:
 * `lib/readState.ts` cannot answer "how many unread replies does this thread
 * have". It stores exactly one number per CHANNEL — the newest `created_at`
 * the viewer has seen — and `app/routes/repos.tsx` advances that marker to the
 * newest message in the channel as soon as the channel is opened. By the time
 * a thread panel is on screen the channel marker is already at the newest
 * message, so any thread-scoped count derived from it is identically zero.
 * Its own `isUnread` comment says as much: it returns a dot, not a count,
 * "counts need the full buffer, which the sidebar doesn't hold".
 *
 * So this adds the one thing the channel marker cannot express: when the
 * viewer last had THIS thread open. The count the panel shows is "replies that
 * arrived since you last looked at this thread", captured once when the panel
 * mounts and then advanced — which is why the number stays on screen instead
 * of blinking to zero the instant it is rendered.
 *
 * Storage is deliberately separate from `buzz.read-state.v1` so nothing here
 * can corrupt channel badges, and so a future server-side read model can
 * replace it without touching the channel marker.
 */

const THREAD_READ_KEY = "buzz.thread-read.v1";

/** threadRootId → newest reply `created_at` the viewer has seen. */
export interface ThreadReadState {
  [rootId: string]: number;
}

export function loadThreadReadState(): ThreadReadState {
  try {
    const raw = globalThis.localStorage?.getItem(THREAD_READ_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as ThreadReadState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveThreadReadState(state: ThreadReadState): void {
  try {
    globalThis.localStorage?.setItem(THREAD_READ_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable — thread read state stays session-local.
  }
}

/** Advance a thread's marker. Returns the same object when nothing moved. */
export function markThreadSeen(
  state: ThreadReadState,
  rootId: string,
  createdAt: number,
): ThreadReadState {
  if ((state[rootId] ?? 0) >= createdAt) {
    return state;
  }
  return { ...state, [rootId]: createdAt };
}

/**
 * Replies newer than the marker.
 *
 * `seenAt` of 0 (a thread never opened) counts every reply, which is the right
 * answer: the viewer has not read any of them.
 */
export function threadUnreadCount(
  replies: readonly { createdAt: number }[],
  seenAt: number,
): number {
  let count = 0;
  for (const reply of replies) {
    if (reply.createdAt > seenAt) {
      count += 1;
    }
  }
  return count;
}

/** Read a single thread's marker (0 when the thread was never opened). */
export function threadSeenAt(state: ThreadReadState, rootId: string): number {
  return state[rootId] ?? 0;
}
