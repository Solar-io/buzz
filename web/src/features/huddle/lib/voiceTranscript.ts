/**
 * Pure logic for huddle voice mode: gating recognition finals into
 * publishable transcripts, and the recognition lifecycle state machine.
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
 * How many recent finals the duplicate check remembers. Chrome's continuous
 * recognition can emit the same final twice, and a manual restart() can
 * replay the previous final as its first result — both are caught by an
 * exact match against this window. Three covers a double-emit plus a
 * replay without suppressing a legitimately repeated phrase minutes later.
 */
export const DUPLICATE_WINDOW = 3;

export type VoiceModeStatus = "idle" | "starting" | "listening" | "error";

/**
 * Collapse every whitespace run (spaces, newlines, tabs — recognition
 * transcripts arrive with erratic spacing) to a single space, and trim.
 */
export function normalizeTranscript(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export type TranscriptGateResult =
  | { ok: true; text: string }
  | { ok: false; reason: "blank" | "too_short" | "duplicate" };

/**
 * Decide whether one final recognition result becomes a published message.
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
 * The shape of a `SpeechRecognitionEvent` this module consumes, per the DOM
 * spec: `resultIndex` plus a `results` list whose entries expose `isFinal`
 * and index-access to alternatives (`results[i][0].transcript`).
 * `SpeechRecognitionResult`/`SpeechRecognitionResultList` exist in
 * TypeScript's DOM lib, but the controller interface does not, so the event
 * shape is restated here structurally and the spec-derived fixtures in the
 * test file mirror it exactly.
 */
export interface RecognitionResultsLike {
  readonly length: number;
  readonly [index: number]: {
    readonly isFinal: boolean;
    readonly length: number;
    readonly [index: number]: { readonly transcript: string };
  };
}

export interface RecognitionEventLike {
  readonly resultIndex: number;
  readonly results: RecognitionResultsLike;
}

export interface FinalTranscript {
  /** Index into the event's results list; the caller marks it seen. */
  index: number;
  transcript: string;
}

/**
 * Finals from one result event that have not been seen yet.
 *
 * Walks the WHOLE results list, not just from `resultIndex`: `resultIndex`
 * is "the lowest index that changed", but a final at an earlier index in
 * the same batch would be skipped by a `resultIndex`-anchored walk, and
 * Chrome does deliver more than one finalized result per event. Idempotent
 * against the caller's `seen` set, so re-delivery of an unchanged prefix
 * (which is exactly what Chrome sends while a later result is still
 * interim) publishes nothing.
 */
export function finalTranscriptsFromEvent(
  event: RecognitionEventLike,
  seen: ReadonlySet<number>,
): FinalTranscript[] {
  const finals: FinalTranscript[] = [];
  const { results } = event;
  for (let index = 0; index < results.length; index += 1) {
    if (seen.has(index)) {
      continue;
    }
    const result = results[index];
    if (!result.isFinal || result.length === 0) {
      continue;
    }
    finals.push({ index, transcript: result[0].transcript });
  }
  return finals;
}

/**
 * The latest interim (non-final) transcript in an event, or "" when every
 * result is final. This is display-only — it is never published.
 */
export function latestInterimTranscript(event: RecognitionEventLike): string {
  const { results } = event;
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!result.isFinal && result.length > 0) {
      return result[0].transcript;
    }
  }
  return "";
}

/**
 * Recognition error codes that are part of normal continuous operation and
 * must NOT surface as a fault: `no-speech` precedes every onend restart on
 * silence, and `aborted` is what a deliberate stop() produces. Every other
 * code (`not-allowed`, `audio-capture`, `network`, `service-not-allowed`,
 * `language-not-supported`) leaves the mic unusable — those clear the UI
 * state instead of auto-restarting into the same wall.
 */
export function isBenignRecognitionError(code: string): boolean {
  return code === "no-speech" || code === "aborted";
}

export type VoiceLifecycleEvent =
  | { type: "start" }
  | { type: "stop" }
  | { type: "audio_started" }
  | { type: "ended" }
  | { type: "errored"; code: string };

/**
 * Pure transition function for the recognition lifecycle. The hook owns the
 * recognizer instance and timers; this decides what the UI state is.
 *
 *  - `start` from idle/error → starting (a retry after a fatal error is a
 *    fresh user toggle, which is the only path back from error);
 *  - `audio_started` → listening (the mic is live);
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
      return isBenignRecognitionError(event.code) ? status : "error";
  }
}

/** Human sentences for the fatal codes, keyed by `SpeechRecognitionErrorEvent.error`. */
export const RECOGNITION_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "not-allowed":
    "Microphone access was denied — allow it in the browser and try again.",
  "audio-capture": "No microphone was found — connect one and try again.",
  network: "Speech recognition lost its network connection.",
  "service-not-allowed": "This browser's speech service is not allowed to run.",
  "language-not-supported":
    "This browser's speech service does not support en-US.",
};

export function recognitionErrorMessage(code: string): string {
  return (
    RECOGNITION_ERROR_MESSAGES[code] ?? `Speech recognition failed (${code}).`
  );
}
