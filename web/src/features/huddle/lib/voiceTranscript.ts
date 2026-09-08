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

/**
 * Echo suppression. The avatar's replies are read aloud by this browser's
 * LOCAL speechSynthesis (`useHuddleAgentSpeech`) — that audio never enters
 * the huddle stream, it comes out of the speakers, and on speakers (not
 * headphones) the mic hears the avatar's own voice. The STT bridge then
 * transcribes it and it publishes AS THE VIEWER, p-tagging the agent with
 * its own words, which arrive back as new mentions and get answered: a
 * feedback loop that wastes agent turns and publishes garbage under the
 * viewer's identity. Two browser-side layers close it:
 *
 *  Layer 1 — temporal hold ({@link shouldHoldFinal}). A final that arrives
 *  while the avatar is speaking, or within {@link ECHO_TAIL_MS} of it last
 *  stopping (VAD 400 ms + model latency lands the echo final shortly after
 *  TTS ends), is held, not published. Held finals drain through Layer 2
 *  once the avatar has gone quiet past the tail; teardown discards them.
 *
 *  Layer 2 — similarity gate ({@link isEchoOfUtterances}). A held final
 *  that closely matches one of the avatar's recent utterances is an echo
 *  and is dropped silently; anything else is a barge-in — real speech that
 *  happened to overlap the avatar — and publishes, late but intact.
 *
 *  Layer 2 sees ONLY held finals. A final arriving while the avatar is
 *  silent publishes exactly as `gateFinalTranscript` always allowed: zero
 *  behavior change on the clean path.
 */

/** How long after the avatar stops speaking an echo final can still land. */
export const ECHO_TAIL_MS = 1500;

/**
 * Token-overlap ratio (Jaccard on word sets) at which a held final counts
 * as an echo of an utterance. 0.6 admits one garbled or inserted word in
 * an otherwise verbatim replay while keeping disjoint speech disjoint.
 */
export const ECHO_OVERLAP_RATIO = 0.6;

/**
 * Minimum normalized length for the substring rule: a held final that
 * contains, or is contained in, an utterance of at least this many
 * normalized characters is an echo. Below this, short utterances ("new
 * plan") would swallow unrelated short finals ("a plan") wholesale.
 */
export const ECHO_SUBSTRING_MIN_CHARS = 15;

/** How many recent avatar utterances the echo ring remembers. */
export const RECENT_UTTERANCE_WINDOW = 3;

/** One remembered avatar utterance: its text and when it stopped sounding. */
export interface RecentUtterance {
  text: string;
  /** Epoch ms of the moment this utterance's synthesis settled. */
  at: number;
}

/**
 * Live avatar-speech state, owned by `useHuddleAgentSpeech` and read by
 * `useHuddleVoiceMode` at STT-final arrival time. Kept in a ref (not React
 * state) so synthesis boundaries update it in the same task they happen,
 * with no re-render to wait for and none provoked per utterance.
 */
export interface AgentSpeechActivity {
  /** True while a local utterance is being synthesized right now. */
  speaking: boolean;
  /** Newest-last ring of recent utterances, capped at the window above. */
  utterances: RecentUtterance[];
}

/**
 * Normalize text for echo comparison: lowercase, strip punctuation and
 * symbols (without leaving gaps), collapse whitespace. STT hears "Round"
 * where synthesis said "around"; neither casing nor commas should survive.
 */
export function normalizeForEcho(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wordSet(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter(Boolean));
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) {
    if (b.has(word)) {
      shared += 1;
    }
  }
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Is this held final an echo of one of the avatar's recent utterances?
 *
 * True when the normalized final's token overlap with any normalized
 * utterance reaches {@link ECHO_OVERLAP_RATIO} (Jaccard on word sets), OR
 * the normalized final contains, or is contained in, a normalized
 * utterance of at least {@link ECHO_SUBSTRING_MIN_CHARS} characters.
 * Garbled echoes that share no tokens ("you planet" for "new plan") are
 * accepted misses — Layer 1's hold already kept them out of the channel.
 */
export function isEchoOfUtterances(
  finalText: string,
  utterances: readonly string[],
): boolean {
  const finalNorm = normalizeForEcho(finalText);
  if (finalNorm.length === 0) {
    return false;
  }
  for (const utterance of utterances) {
    const utteranceNorm = normalizeForEcho(utterance);
    if (utteranceNorm.length === 0) {
      continue;
    }
    if (
      tokenOverlap(wordSet(finalNorm), wordSet(utteranceNorm)) >=
      ECHO_OVERLAP_RATIO
    ) {
      return true;
    }
    if (
      utteranceNorm.length >= ECHO_SUBSTRING_MIN_CHARS &&
      (finalNorm.includes(utteranceNorm) || utteranceNorm.includes(finalNorm))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Layer 1's decision: hold this final rather than publish it now?
 *
 * Holds while the avatar is speaking, and for {@link ECHO_TAIL_MS} after
 * it last stopped — at exactly the tail the window has passed, because
 * "within 1500 ms after it stopped" ends at 1500. `msSinceSpoke` is
 * infinite when the avatar has never spoken (or its ring is empty), which
 * is the clean path: hold nothing, publish as before.
 */
export function shouldHoldFinal(
  speaking: boolean,
  msSinceSpoke: number,
): boolean {
  return speaking || msSinceSpoke < ECHO_TAIL_MS;
}

/** Append one utterance to the echo ring, keeping the newest window entries. */
export function recordUtterance(
  ring: readonly RecentUtterance[],
  text: string,
  at: number,
): RecentUtterance[] {
  const next = [...ring, { text, at }];
  return next.length > RECENT_UTTERANCE_WINDOW
    ? next.slice(-RECENT_UTTERANCE_WINDOW)
    : next;
}

/**
 * Milliseconds since the avatar's most recent utterance settled. The ring
 * is newest-last, so the last entry is always the latest. Infinite when
 * the ring is empty — nothing was ever spoken, so nothing can echo.
 */
export function msSinceLastUtterance(
  ring: readonly RecentUtterance[],
  now: number,
): number {
  if (ring.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  return now - ring[ring.length - 1].at;
}
