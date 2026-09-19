/**
 * What the voice pickers offer, derived from their two sources.
 *
 * TWO ENGINES, not three (Sam, 2026-09-18): the browser's own
 * `speechSynthesis` voices are gone from every picker. They were the "crap
 * robot" leg — an OS voice list that differs per machine, cannot be
 * previewed consistently, and is not what anyone picked when a bundled
 * Pocket preset was one row away. The `local-synth` variant survives in the
 * SELECTION type and parser so old published kind-30182 rows still decode
 * (see `agentVoiceSelection.ts`), but nothing offers it any more and
 * `resolveHuddleVoice` treats such a row as "no selection".
 *
 * Pure and import-free so `node --test` loads it: catalog rows in, bridge
 * voice rows in, options out. `VoicePickerDialog.tsx` renders these for the
 * Settings page and `HuddleSettingsPopover.tsx` for one channel's override.
 */

/** The engines the tts bridge can actually run. */
export type VoiceEngine = "pocket" | "eleven";

/** Segmented-control order, left to right. */
export const VOICE_ENGINES: readonly VoiceEngine[] = ["pocket", "eleven"];

/** Display name for an engine — one spelling, used by every surface. */
export function engineLabel(engine: VoiceEngine): string {
  return engine === "pocket" ? "Pocket" : "ElevenLabs";
}

/** One selectable row in a picker, engine-tagged like the selection store. */
export interface VoicePickerOption {
  engine: VoiceEngine;
  /** The selection key: `pocket:<slug>` or `eleven:<voice id>`. */
  key: string;
  label: string;
}

/**
 * The catalog half of the list: every kind:30181 row is offered under its
 * display name. Rows the 30181 parser already refused (the banned
 * `pocket:eve` among them) never reach this function — the hook folds them
 * out at parse.
 */
export function pocketVoiceOptions(
  rows: readonly { content: { key: string; displayName: string } }[],
): VoicePickerOption[] {
  return rows.map((row) => ({
    engine: "pocket" as const,
    key: row.content.key,
    label: row.content.displayName,
  }));
}

/**
 * The ElevenLabs half: bridge-served voice-library rows, keyed exactly as
 * the selection store expects (`eleven:<voice id>`).
 */
export function elevenVoiceOptions(
  voices: readonly { id: string; label: string }[],
): VoicePickerOption[] {
  return voices.map((voice) => ({
    engine: "eleven" as const,
    key: `eleven:${voice.id}`,
    label: voice.label,
  }));
}

/** Both engines' source rows, as the pickers hold them. */
export interface VoiceOptionSources {
  catalogRows: readonly { content: { key: string; displayName: string } }[];
  elevenVoices: readonly { id: string; label: string }[];
}

/**
 * THE ENGINE FILTER. An engine-first picker shows the chosen engine's
 * voices and only those — a flat list of both was the shape Sam rejected,
 * because with an ElevenLabs library of hundreds the twelve Pocket presets
 * become unfindable.
 */
export function engineVoiceOptions(
  engine: VoiceEngine,
  sources: VoiceOptionSources,
): VoicePickerOption[] {
  return engine === "pocket"
    ? pocketVoiceOptions(sources.catalogRows)
    : elevenVoiceOptions(sources.elevenVoices);
}

/**
 * Compare an option against a stored selection — same engine AND same
 * target. Takes the selection's structural shape (no `label`), so a picker
 * can ask "is this row the one I already speak with?". A stored
 * `local-synth` row matches nothing here, which is correct: no offered row
 * can be it.
 */
export function sameOption(
  a: { engine: string; key?: string } | undefined,
  b: { engine: string; key?: string } | undefined,
): boolean {
  if (a === undefined || b === undefined || a.engine !== b.engine) {
    return false;
  }
  if (a.engine !== "pocket" && a.engine !== "eleven") {
    return false;
  }
  return a.key !== undefined && a.key === b.key;
}

/** The line every Preview button speaks. */
export const PREVIEW_SAMPLE_TEXT = "Hi, this is my agent voice.";
