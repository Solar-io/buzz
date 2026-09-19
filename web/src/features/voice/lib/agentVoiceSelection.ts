/**
 * Buzz agent-voice selection (kind 30182) — the wire format, mirroring the
 * relay's ingest rules rather than guessed.
 *
 * Source of truth, in order:
 *
 *  - `crates/buzz-core/src/kind.rs` — `KIND_AGENT_VOICE: u32 = 30182`, an
 *    agent's own speaking-voice binding: parameterized-replaceable at the
 *    FIXED `d` tag `agent-voice` (one row per author; the author pubkey IS
 *    the agent identity), community-global, public-read — every
 *    participant's browser must read it to honor the agent's chosen voice.
 *  - `crates/buzz-relay/src/handlers/ingest.rs` — `validate_agent_voice_…`:
 *    engine ∈ {`local-synth`, `pocket`}; `local-synth` requires a non-empty
 *    `voiceURI`; `pocket` requires a key in the catalog's own key grammar
 *    (`isValidVoiceKey` in `voiceCatalog.ts`), minus the banned
 *    `pocket:eve`.
 *
 * Unlike the 30181 reader (where the relay never parses content), this
 * parser drops everything the relay would refuse: the fold must match the
 * store. The selected engine/voice shape is the contract the speak-time seam
 * (`speechVoiceProfile(…, selected?)`) will consume.
 */

import {
  EVE_VOICE_KEY,
  isValidVoiceKey,
  type VoiceCatalogContent,
} from "./voiceCatalog.ts";

/** Buzz agent-voice selection. `crates/buzz-core/src/kind.rs`. */
export const KIND_AGENT_VOICE = 30182;

/** The fixed NIP-33 `d` tag — ONE row per author, by construction. */
export const AGENT_VOICE_D_TAG = "agent-voice";

/**
 * An engine-tagged voice selection — the agreed contract between the
 * selection store, the picker, and the speak-time seam. `local-synth` is a
 * `speechSynthesis` voiceURI from the caller's local English pool; `pocket`
 * is a kind:30181 catalog row key synthesized server-side by the tts bridge
 * (preset slug keys); `eleven` is an ElevenLabs voice id synthesized
 * server-side by the same bridge.
 */
export type AgentVoiceSelection =
  | { engine: "local-synth"; voiceURI: string }
  | { engine: "pocket"; key: string }
  | { engine: "eleven"; key: string };

/** The JSON body of a kind:30182 event. */
export interface AgentVoiceSelectionContent {
  version: number;
  engine: string;
  label: string;
  voiceURI?: string;
  key?: string;
}

/** One validated selection with its event provenance. */
export interface AgentVoiceSelectionRow {
  /** Author pubkey (hex) — the agent identity the selection belongs to. */
  pubkey: string;
  /** The event's `created_at`, unix seconds — LWW within the coordinate. */
  createdAt: number;
  selection: AgentVoiceSelection;
  label: string;
}

/** The subset of a signed event this module reads. */
export interface AgentVoiceEventLike {
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
}

// C0 control characters plus DEL. Checked by code point rather than a
// regex literal so the source stays printable: a newline in a label would
// break line-oriented log consumers.
function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function dTagValues(tags: string[][]): string[] {
  const values: string[] = [];
  for (const tag of tags) {
    if (Array.isArray(tag) && tag[0] === "d" && typeof tag[1] === "string") {
      values.push(tag[1]);
    }
  }
  return values;
}

/** Non-empty, char-bounded, control-free text within a selection body. */
function isBoundedText(value: string, maxChars: number): boolean {
  return value.length > 0 && value.length <= maxChars && !hasControlChar(value);
}

/**
 * The catalog key grammar, shape-only: `pocket:<slug>` (non-empty slug of
 * `[a-z0-9_-]`) or the full `pocket:imported:<64 lowercase hex>` form.
 *
 * `isValidVoiceKey` additionally pins an imported key to its row's
 * `contentHash` — a rule about the row's OWN publication. A selection only
 * NAMES a row, so the probe passes a body whose key and hash agree by
 * construction; the grammar is what is being checked.
 */
function isValidSelectionKey(key: string): boolean {
  const probe = {
    key,
    contentHash: key.startsWith("pocket:imported:")
      ? key.slice("pocket:imported:".length)
      : "",
  } as VoiceCatalogContent;
  return isValidVoiceKey(probe);
}

/**
 * ElevenLabs key grammar: `eleven:<voice id>` where the id is the vendor's
 * alphanumeric voice identifier (observed 20 chars; bounded 10-36 — the
 * relay's own ingest grammar, crates/buzz-relay/src/handlers/ingest.rs).
 * The parser must refuse what the relay refuses, so the bounds mirror it
 * exactly rather than guessing a future id shape.
 */
function isValidElevenKey(key: string): boolean {
  return /^eleven:[A-Za-z0-9]{10,36}$/.test(key);
}

/**
 * Read one kind:30182 event. Returns `null` for anything the reader refuses:
 * unparseable content, a `version` other than 1, an unknown engine, a
 * `local-synth` body without a usable `voiceURI`, a `pocket` body whose key
 * is not a catalog key or is the banned `pocket:eve`, a missing/over-long
 * label, or a `d` tag that is not the fixed `agent-voice` constant.
 */
export function parseAgentVoiceEvent(
  event: AgentVoiceEventLike,
): AgentVoiceSelectionRow | null {
  const dTags = dTagValues(event.tags);
  if (dTags.length !== 1 || dTags[0] !== AGENT_VOICE_D_TAG) {
    return null;
  }
  let content: AgentVoiceSelectionContent;
  try {
    content = JSON.parse(event.content) as AgentVoiceSelectionContent;
  } catch {
    return null;
  }
  if (
    content === null ||
    typeof content !== "object" ||
    content.version !== 1 ||
    typeof content.label !== "string" ||
    !isBoundedText(content.label, 128)
  ) {
    return null;
  }
  if (content.engine === "local-synth") {
    if (
      typeof content.voiceURI !== "string" ||
      !isBoundedText(content.voiceURI, 256)
    ) {
      return null;
    }
    return {
      pubkey: event.pubkey,
      createdAt: event.created_at,
      selection: { engine: "local-synth", voiceURI: content.voiceURI },
      label: content.label,
    };
  }
  if (content.engine === "pocket") {
    if (typeof content.key !== "string" || content.key === EVE_VOICE_KEY) {
      return null;
    }
    if (!isValidSelectionKey(content.key)) {
      return null;
    }
    return {
      pubkey: event.pubkey,
      createdAt: event.created_at,
      selection: { engine: "pocket", key: content.key },
      label: content.label,
    };
  }
  if (content.engine === "eleven") {
    if (typeof content.key !== "string" || !isValidElevenKey(content.key)) {
      return null;
    }
    return {
      pubkey: event.pubkey,
      createdAt: event.created_at,
      selection: { engine: "eleven", key: content.key },
      label: content.label,
    };
  }
  return null;
}

/**
 * Fold a stream of selection events into one row per agent pubkey.
 *
 * Newer `created_at` wins — NIP-33 replacement keeps one head server-side,
 * but a live subscription plus a historical replay can deliver both orders.
 * Keys are LOWERCASED pubkeys: the speech path classifies authors with
 * `toLowerCase()` (huddleAgentSpeech.ts), so a mixed-case hex collision must
 * not fork an agent into two selection slots. Rows the parser refuses are
 * dropped, not fatal.
 */
export function reduceAgentVoiceEvents(
  events: readonly AgentVoiceEventLike[],
): Map<string, AgentVoiceSelectionRow> {
  const rows = new Map<string, AgentVoiceSelectionRow>();
  for (const event of events) {
    const row = parseAgentVoiceEvent(event);
    if (row === null) {
      continue;
    }
    const key = row.pubkey.toLowerCase();
    const existing = rows.get(key);
    if (existing && existing.createdAt >= row.createdAt) {
      continue;
    }
    rows.set(key, row);
  }
  return rows;
}
