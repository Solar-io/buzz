/**
 * Per-channel huddle preferences: the voice an agent is rendered with IN
 * THIS BROWSER, and the duplex discipline the mic follows.
 *
 * Scope is the PARENT channel, not the ephemeral huddle channel. A huddle
 * channel lives an hour; the DM or channel it hangs off is the thing a
 * person means when they say "she should sound like this in here". Keying
 * on the ephemeral id would throw the choice away at the end of every call.
 *
 * Storage is localStorage under `buzz.huddle.prefs.<parentChannelId>`. It is
 * deliberately a LOCAL override, not a published event: the kind-30182
 * selection is the agent's own published voice and belongs to the agent,
 * while this is one listener's preference for one room. Nothing here ever
 * writes to the relay.
 *
 * RESOLUTION ORDER (the whole point of the module):
 *
 *   1. this channel's override (pocket / eleven only),
 *   2. the agent's published kind-30182 selection,
 *   3. nothing — the caller's derived Pocket default speaks.
 *
 * With one deliberate subtraction at step 2: a published `local-synth` row
 * resolves like NO selection. The on-device `speechSynthesis` engine was
 * dropped from the UI (Sam, 2026-09-18: "engines offered: Pocket and
 * ElevenLabs only"), and an old published row naming an OS voice must not
 * be the one thing that still drags the robot back into a call. The variant
 * stays in the type and the parser so those rows still decode — they just
 * no longer decide anything.
 *
 * Import-free apart from the TYPE-only selection import (erased at runtime),
 * so `node --test` loads it.
 */

import type { AgentVoiceSelection } from "../../voice/lib/agentVoiceSelection.ts";

/**
 * Half-duplex mutes the mic while the agent talks; barge-in leaves it hot
 * and lets speech cut her off. Half is the default (Sam, 2026-09-18).
 */
export type HuddleDuplexMode = "half" | "barge";

/** The engines a per-channel override may name — the two the bridge runs. */
export type HuddleVoiceEngine = "pocket" | "eleven";

/** A per-channel voice override, in the same shape the bridge consumes. */
export interface HuddleVoiceOverride {
  engine: HuddleVoiceEngine;
  key: string;
}

export interface HuddlePrefs {
  /** null = "use default (Settings)", i.e. fall through to step 2. */
  voice: HuddleVoiceOverride | null;
  duplex: HuddleDuplexMode;
}

export const DEFAULT_HUDDLE_PREFS: HuddlePrefs = {
  voice: null,
  duplex: "half",
};

/** localStorage key prefix; the parent channel id completes it. */
export const HUDDLE_PREFS_PREFIX = "buzz.huddle.prefs.";

export function huddlePrefsKey(parentChannelId: string): string {
  return `${HUDDLE_PREFS_PREFIX}${parentChannelId}`;
}

/** The slice of `Storage` this module uses (injected so tests need no DOM). */
export interface HuddlePrefsStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function parseVoice(raw: unknown): HuddleVoiceOverride | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as { engine?: unknown; key?: unknown };
  if (candidate.engine !== "pocket" && candidate.engine !== "eleven") {
    return null;
  }
  if (typeof candidate.key !== "string" || candidate.key === "") {
    return null;
  }
  return { engine: candidate.engine, key: candidate.key };
}

function parseDuplex(raw: unknown): HuddleDuplexMode {
  return raw === "barge" ? "barge" : "half";
}

/**
 * Read one channel's prefs. Anything unreadable — absent key, malformed
 * JSON, a store that throws (private mode, blocked site data) — reads as
 * the default rather than throwing into a render.
 */
export function loadHuddlePrefs(
  store: HuddlePrefsStore | null,
  parentChannelId: string,
): HuddlePrefs {
  if (store === null || parentChannelId === "") {
    return DEFAULT_HUDDLE_PREFS;
  }
  let raw: string | null = null;
  try {
    raw = store.getItem(huddlePrefsKey(parentChannelId));
  } catch {
    return DEFAULT_HUDDLE_PREFS;
  }
  if (raw === null) {
    return DEFAULT_HUDDLE_PREFS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_HUDDLE_PREFS;
  }
  if (parsed === null || typeof parsed !== "object") {
    return DEFAULT_HUDDLE_PREFS;
  }
  const record = parsed as { voice?: unknown; duplex?: unknown };
  return {
    voice: parseVoice(record.voice),
    duplex: parseDuplex(record.duplex),
  };
}

/**
 * Write one channel's prefs. A write that throws is swallowed for the same
 * reason the read is: a full or blocked store must not break a live call.
 */
export function saveHuddlePrefs(
  store: HuddlePrefsStore | null,
  parentChannelId: string,
  prefs: HuddlePrefs,
): void {
  if (store === null || parentChannelId === "") {
    return;
  }
  try {
    store.setItem(
      huddlePrefsKey(parentChannelId),
      JSON.stringify({ voice: prefs.voice, duplex: prefs.duplex }),
    );
  } catch {
    // Preferences are a convenience; the call keeps running without them.
  }
}

/** Forget one channel's prefs entirely (back to the shipped defaults). */
export function clearHuddlePrefs(
  store: HuddlePrefsStore | null,
  parentChannelId: string,
): void {
  if (store === null || parentChannelId === "") {
    return;
  }
  try {
    store.removeItem(huddlePrefsKey(parentChannelId));
  } catch {
    // Same reason as the write.
  }
}

/**
 * The selection an agent speaks with in this browser, for this channel —
 * the three-step order documented in the module header.
 *
 * Returns `undefined` for "nothing chose a voice", which is exactly the
 * input `speakRoute` already treats as the derived Pocket default. That is
 * why this function is the whole seam: `speakRoute` is untouched.
 */
export function resolveHuddleVoice(
  override: HuddleVoiceOverride | null | undefined,
  published: AgentVoiceSelection | undefined,
): AgentVoiceSelection | undefined {
  if (override !== null && override !== undefined) {
    return { engine: override.engine, key: override.key };
  }
  if (published === undefined) {
    return undefined;
  }
  if (published.engine === "local-synth") {
    // Dropped engine: decodes, does not decide. See the module header.
    return undefined;
  }
  return published;
}
