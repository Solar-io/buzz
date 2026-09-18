/**
 * Per-huddle armed voice state that survives a page reload.
 *
 * The V2 defect: voice mode (Listening) and read-agent-replies are
 * in-session React state only, so a reload disarms them with no signal —
 * and because the reload also broke the rejoin (V1b), the user could not
 * even re-arm. sessionStorage is the right scope: it survives reloads of
 * the tab (the survival that matters — a call interrupted by a refresh or
 * a webview reload) and dies with the tab, so nothing armed here leaks
 * into tomorrow's session.
 *
 * Pure and storage-injected so `node --test` can exercise every path —
 * including the malformed-entry reads that a private-browsing quota error
 * or a hand-edited value can produce. Those read as "nothing saved", never
 * as a crash.
 */

/** sessionStorage key prefix, keyed per huddle backing channel. */
const KEY_PREFIX = "buzz-huddle-voice:";

/** The armed state a huddle's controls persist. */
export interface HuddleVoicePersisted {
  /** Voice mode (Listening) was on. */
  voiceMode: boolean;
  /** Read-agent-replies was on. */
  readAgentReplies: boolean;
}

/** The slice of Storage this module needs — injectable for tests. */
export interface VoiceStateStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function keyFor(channelId: string): string {
  return `${KEY_PREFIX}${channelId}`;
}

function isPersistedState(value: unknown): value is HuddleVoicePersisted {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as HuddleVoicePersisted).voiceMode === "boolean" &&
    typeof (value as HuddleVoicePersisted).readAgentReplies === "boolean"
  );
}

/**
 * Save the armed state for a huddle. Storage failures (quota, private
 * mode) are swallowed: an unpersisted armed state is the pre-existing
 * behavior, not a new error to raise mid-call.
 */
export function saveHuddleVoiceState(
  store: VoiceStateStore,
  channelId: string,
  state: HuddleVoicePersisted,
): void {
  try {
    store.setItem(keyFor(channelId), JSON.stringify(state));
  } catch {
    // Best effort by design.
  }
}

/** The saved armed state for a huddle, or null when none or malformed. */
export function loadHuddleVoiceState(
  store: VoiceStateStore,
  channelId: string,
): HuddleVoicePersisted | null {
  try {
    const raw = store.getItem(keyFor(channelId));
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return isPersistedState(parsed) ? parsed : null;
  } catch {
    // Unparsable entry reads as "nothing saved" — never a crash.
    return null;
  }
}

/** Forget a huddle's armed state (deliberate disarm, or a failed restore). */
export function clearHuddleVoiceState(
  store: VoiceStateStore,
  channelId: string,
): void {
  try {
    store.removeItem(keyFor(channelId));
  } catch {
    // Best effort by design.
  }
}

/**
 * What the restore toast says, for the state that WILL actually be
 * applied. Restoring is never silent — the V2 defect was the silent part
 * — but the wording names exactly what came back, and a saved state that
 * arms nothing (both flags off) announces nothing.
 */
export function voiceRestoreAnnouncement(
  state: HuddleVoicePersisted,
): { title: string; description: string } | null {
  if (state.voiceMode) {
    return {
      title: "Voice mode restored — Listening",
      description: state.readAgentReplies
        ? "Reading agent replies is on, as you left it."
        : "Reading agent replies is off, as you left it.",
    };
  }
  if (state.readAgentReplies) {
    return {
      title: "Reading agent replies restored",
      description: "As you left it in this huddle.",
    };
  }
  return null;
}

/** The toast when a saved state cannot be applied (dead huddle, no rejoin). */
export const VOICE_RESTORE_FAILED = {
  title: "Saved voice settings could not be restored",
  description: "This huddle has ended.",
} as const;
