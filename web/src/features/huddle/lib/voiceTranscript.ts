/**
 * Pure logic for huddle voice mode: gating STT bridge finals into
 * publishable transcripts, and the voice-mode lifecycle state machine.
 *
 * REACHABILITY, because the feature stands on one wire fact: the ONLY event
 * that wakes an agent in a huddle is the kind-9 channel message, and whether
 * it wakes one depends on its `p` tags. A default-config agent harness
 * (`--subscribe=mentions`, the default in crates/buzz-acp/src/config.rs:348)
 * subscribes with a relay-side `#p: [agent_pubkey]` filter
 * (crates/buzz-acp/src/relay.rs:3211-3213), so a message that does not p-tag
 * the agent is never delivered to it at all. The desktop's STT pipeline
 * therefore p-tags EVERY current huddle agent on EVERY transcript
 * (desktop/src-tauri/src/huddle/pipeline.rs:661-668), and the web already
 * does the same for DM peers for exactly this reason — "a web-sent DM once
 * arrived untagged and the agent never reacted to it"
 * (web/src/features/channels/lib/useMessageActions.ts:196-206).
 *
 * So the publish path in `useHuddleVoiceMode`'s caller passes the huddle's
 * bot roster as `mentionPubkeys` through the channel's ordinary `send`.
 * The transcript text itself carries no prefix and no decoration — the
 * p tags are addressing, not content, and do not render as mention chips
 * (highlighting comes from @tokens in the text, lib/mentions.ts:4-5; every
 * DM message proves a bare p tag renders as an ordinary message).
 *
 * Interim results are collected (for live display) but never published.
 *
 * Import-free, so `node --test` loads it.
 */

/** Finals shorter than this are noise ("ok", "hm") and are not published. */
export const MIN_TRANSCRIPT_CHARS = 3;

/**
 * How many recent finals the duplicate check remembers. A resumed STT
 * session can emit the same final twice — and a reconnect can replay the
 * previous session's final as its first result — both are caught by an
 * exact match against this window. Three covers a double-emit plus a
 * replay without suppressing a legitimately repeated phrase minutes later.
 */
export const DUPLICATE_WINDOW = 3;

export type VoiceModeStatus = "idle" | "starting" | "listening" | "error";

/**
 * Collapse every whitespace run (spaces, newlines, tabs — transcripts
 * arrive with erratic spacing) to a single space, and trim.
 */
export function normalizeTranscript(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export type TranscriptGateResult =
  | { ok: true; text: string }
  | { ok: false; reason: "blank" | "too_short" | "duplicate" };

/**
 * Decide whether one final transcript becomes a published message.
 *
 * Publishes the NORMALIZED text (collapsed whitespace, trimmed) — what is
 * spoken is what is sent, minus whitespace noise. Rejections:
 *  - `blank`: nothing survived normalization;
 *  - `too_short`: under {@link MIN_TRANSCRIPT_CHARS} characters;
 *  - `duplicate`: exact match against the recent-final window.
 */
export function gateFinalTranscript(
  raw: string,
  recentFinals: readonly string[],
): TranscriptGateResult {
  const text = normalizeTranscript(raw);
  if (text.length === 0) {
    return { ok: false, reason: "blank" };
  }
  if (text.length < MIN_TRANSCRIPT_CHARS) {
    return { ok: false, reason: "too_short" };
  }
  if (recentFinals.includes(text)) {
    return { ok: false, reason: "duplicate" };
  }
  return { ok: true, text };
}

/**
 * Error codes that are part of normal continuous operation and must NOT
 * surface as a fault: `no-speech` precedes every silence restart, and
 * `aborted` is what a deliberate stop produces. Every other code leaves
 * recognition unusable — those clear the UI state instead of
 * auto-restarting into the same wall. (The STT bridge reports failures as
 * fatal error events with message strings, which never carry these codes;
 * the set survives from the browser engine for lifecycle parity.)
 */
const BENIGN_ERROR_CODES: ReadonlySet<string> = new Set([
  "no-speech",
  "aborted",
]);

export type VoiceLifecycleEvent =
  | { type: "start" }
  | { type: "stop" }
  | { type: "audio_started" }
  | { type: "ended" }
  | { type: "errored"; code: string };

/**
 * Pure transition function for the voice-mode lifecycle. The hook owns the
 * engine (WebSocket, timers); this decides what the UI state is.
 *
 *  - `start` from idle/error → starting (a retry after a fatal error is a
 *    fresh user toggle, which is the only path back from error);
 *  - `audio_started` → listening (the engine is live — for the bridge,
 *    the session-ready ack);
 *  - `ended` → idle unconditionally — whether to RESTART is policy the hook
 *    applies (user toggle still on), not state;
 *  - `errored` → error for fatal codes, unchanged for benign ones (a
 *    `no-speech` flash between restarts would look like a fault).
 */
export function nextVoiceStatus(
  status: VoiceModeStatus,
  event: VoiceLifecycleEvent,
): VoiceModeStatus {
  switch (event.type) {
    case "start":
      return status === "idle" || status === "error" ? "starting" : status;
    case "stop":
      return "idle";
    case "audio_started":
      return status === "starting" ? "listening" : status;
    case "ended":
      return "idle";
    case "errored":
      return BENIGN_ERROR_CODES.has(event.code) ? status : "error";
  }
}
