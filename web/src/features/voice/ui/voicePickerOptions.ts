/**
 * What the voice picker offers, derived from its two sources.
 *
 * Pure and import-free so `node --test` loads it: catalog rows in, local
 * voices in, options out. The dialog (VoicePickerDialog.tsx) renders these;
 * the settings card feeds them.
 */

/** The subset of a `SpeechSynthesisVoice` the picker and preview depend on. */
export interface PickerVoiceLike {
  name: string;
  lang: string;
  voiceURI: string;
}

/**
 * RULED for v1 (Evie, 2026-09-17 08:46): the utterance text is English, so
 * the voice must be an English voice — a non-English voice reads English
 * text as unintelligible murmur, which is exactly the drift class
 * `speechVoiceProfile` was written to prevent. The invariant GENERALIZES,
 * it does not get torn out: when non-English utterances arrive, this flips
 * to "voice locale matches the utterance locale", so keep the filter a
 * single predicate, never a hardcoded assumption in the option shapes.
 *
 * The speak-time module enforces the same invariant independently: a
 * non-English SELECTION (e.g. a local-synth voiceURI naming a French voice)
 * is rejected there and the profile is marked `selected-rejected` rather
 * than silently falling back.
 */
export const ENGLISH_ONLY = true;

/** One selectable row in the picker, engine-tagged like the store. */
export type VoicePickerOption =
  | { engine: "pocket"; key: string; label: string }
  | { engine: "eleven"; key: string; label: string }
  | { engine: "local-synth"; voiceURI: string; label: string };

/**
 * The local `speechSynthesis` half of the list: English-only while
 * {@link ENGLISH_ONLY} holds, otherwise every voice; stable name order so
 * identical voice sets render identically everywhere.
 */
export function localVoiceOptions(
  voices: readonly PickerVoiceLike[],
): VoicePickerOption[] {
  const pool = ENGLISH_ONLY
    ? voices.filter((voice) => voice.lang.toLowerCase().startsWith("en"))
    : voices;
  return [...pool]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((voice) => ({
      engine: "local-synth" as const,
      voiceURI: voice.voiceURI || voice.name,
      label: voice.name,
    }));
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

/**
 * Compare an option against a stored selection — same engine AND same
 * target. Takes the selection's structural shape (no `label`), so the
 * dialog can ask "is this row the one I already speak with?".
 */
export function sameOption(
  a: { engine: string; voiceURI?: string; key?: string } | undefined,
  b: { engine: string; voiceURI?: string; key?: string } | undefined,
): boolean {
  if (a === undefined || b === undefined || a.engine !== b.engine) {
    return false;
  }
  if (a.engine === "local-synth") {
    return a.voiceURI === b.voiceURI;
  }
  return (a.engine === "pocket" || a.engine === "eleven") && a.key === b.key;
}

/**
 * Speak a short sample line through the option's OWN engine.
 *
 * `local-synth` goes through the injected synthesizer surface (the shape of
 * `window.speechSynthesis` this feature uses) so tests can stub it.
 *
 * `pocket` is a STUB by design: live pocket audio needs the server-side
 * proxy leg that does not exist in this browser, and wiring network TTS here
 * is exactly the half-broken path the huddle speech module refuses. TODO(D-005
 * follow-up): route a pocket preview through the same relay proxy the desktop
 * uses once that leg exists; until then a pocket preview is silent.
 */
export const PREVIEW_SAMPLE_TEXT = "Hi, this is my agent voice.";

export function speakPreview(
  option: VoicePickerOption,
  synth: {
    cancel: () => void;
    speak: (utterance: {
      text: string;
      voiceURI: string | null;
      lang: string;
    }) => void;
  },
): void {
  synth.cancel();
  if (option.engine === "local-synth") {
    synth.speak({
      text: PREVIEW_SAMPLE_TEXT,
      voiceURI: option.voiceURI,
      lang: "en",
    });
    return;
  }
  // Pocket preview is silent (see TODO above) — still cancel whatever is
  // mid-utterance so a preview never overlaps a previous one.
}
