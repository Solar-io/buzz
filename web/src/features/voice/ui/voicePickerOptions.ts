/**
 * What the voice pickers offer, derived from their two sources.
 *
 * CHATTERBOX + ELEVENLABS (2026-09-27): Pocket became fallback-only at the
 * bridge, and every Pocket preset exists as a Chatterbox voice of the same
 * name cloned from the same clip, so the Pocket tab was replaced by a
 * Chatterbox tab (design §5.2). Before that (Sam, 2026-09-18) the browser's
 * own `speechSynthesis` voices were removed from every picker — the "crap
 * robot" leg. The `local-synth` variant survives in the SELECTION type and
 * parser so old published rows still decode (see `agentVoiceSelection.ts`),
 * but nothing offers it and `voicePrecedence.ts` treats such a row as none.
 *
 * Pure so `node --test` loads it: bridge roster rows in, options out.
 * `VoicePickerDialog.tsx` renders these for Settings and
 * `HuddleSettingsPopover.tsx` for one channel's override.
 */

import {
  isVoiceOfferedFor,
  type ChatterboxVoice,
  type VoicePickerTarget,
} from "../lib/chatterboxRoster.ts";

/** The engines a picker OFFERS: Chatterbox first and default, then ElevenLabs. */
export type VoiceEngine = "chatterbox" | "eleven";

/** Segmented-control order, left to right. */
export const VOICE_ENGINES: readonly VoiceEngine[] = ["chatterbox", "eleven"];

/** Display name for an engine — one spelling, used by every surface. */
export function engineLabel(engine: VoiceEngine): string {
  return engine === "chatterbox" ? "Chatterbox" : "ElevenLabs";
}

/**
 * The tab a picker opens on for a stored selection: ElevenLabs for an
 * eleven row, Chatterbox for everything else (a legacy pocket row is served
 * by its same-named Chatterbox voice).
 */
export function initialEngine(
  current: { engine: string } | null | undefined,
): VoiceEngine {
  return current?.engine === "eleven" ? "eleven" : "chatterbox";
}

/** One selectable row in a picker, engine-tagged like the selection store. */
export interface VoicePickerOption {
  engine: VoiceEngine;
  /** The selection key: `chatterbox:<slug>` or `eleven:<voice id>`. */
  key: string;
  label: string;
  /** Secondary text (gender · style) — Chatterbox rows only. */
  detail?: string;
}

/**
 * The Chatterbox half: bridge-roster rows, minus reserved voices the target
 * may not use (`isVoiceOfferedFor`).
 */
export function chatterboxVoiceOptions(
  voices: readonly ChatterboxVoice[],
  target: VoicePickerTarget | null = null,
): VoicePickerOption[] {
  return voices
    .filter((voice) => isVoiceOfferedFor(voice, target))
    .map((voice) => {
      const detail = [voice.gender, voice.style].filter(Boolean).join(" · ");
      return {
        engine: "chatterbox" as const,
        key: voice.key,
        label: voice.label,
        ...(detail === "" ? {} : { detail }),
      };
    });
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
  chatterboxVoices: readonly ChatterboxVoice[];
  elevenVoices: readonly { id: string; label: string }[];
  /** Whose voice is being chosen; null/absent = the signed-in identity. */
  target?: VoicePickerTarget | null;
}

/**
 * THE ENGINE FILTER. An engine-first picker shows the chosen engine's
 * voices and only those — a flat list was the shape Sam rejected, because
 * with an ElevenLabs library of hundreds the roster becomes unfindable.
 */
export function engineVoiceOptions(
  engine: VoiceEngine,
  sources: VoiceOptionSources,
): VoicePickerOption[] {
  return engine === "chatterbox"
    ? chatterboxVoiceOptions(sources.chatterboxVoices, sources.target ?? null)
    : elevenVoiceOptions(sources.elevenVoices);
}

/** Rows beyond which the list grows a filter box. */
export const FILTER_THRESHOLD = 12;

/** Case-insensitive label/detail filter for the picker's filter box. */
export function filterVoiceOptions(
  options: readonly VoicePickerOption[],
  query: string,
): VoicePickerOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return [...options];
  }
  return options.filter((option) =>
    `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(needle),
  );
}

/**
 * Compare an option against a stored selection — same engine AND same
 * target. A stored `local-synth` row matches nothing here, which is
 * correct: no offered row can be it.
 */
export function sameOption(
  a: { engine: string; key?: string } | undefined,
  b: { engine: string; key?: string } | undefined,
): boolean {
  if (a === undefined || b === undefined || a.engine !== b.engine) {
    return false;
  }
  if (
    a.engine !== "pocket" &&
    a.engine !== "chatterbox" &&
    a.engine !== "eleven"
  ) {
    return false;
  }
  return a.key !== undefined && a.key === b.key;
}

/** The line every Preview button speaks. */
export const PREVIEW_SAMPLE_TEXT = "Hi, this is my agent voice.";
