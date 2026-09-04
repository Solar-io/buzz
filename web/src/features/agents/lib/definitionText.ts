/**
 * Rule-12 definition-text validation — the web mirror of the Rust rejection
 * boundary at `desktop/src-tauri/src/managed_agents/definition_validation.rs`
 * (shared instructions must be reviewable byte-for-byte; AGENTS.md rule 12).
 *
 * Shared definitions are executable configuration: `system_prompt` is shown to
 * a person, then delivered verbatim to an ACP harness. Characters that consume
 * input bytes without a visible glyph break that review invariant and are
 * REJECTED here — never silently stripped — exactly as the Rust persistence /
 * import boundary rejects them. The reviewed string must equal the executed
 * string; this file exists so the web snapshot and catalog surfaces enforce
 * the same contract before rendering or installing anything.
 *
 * SYNC DUTY: every range, bound, and error string below is a deliberate
 * hand-mirror of that Rust file. When `definition_validation.rs` changes,
 * change this file and `definitionText.test.mjs` (which carries the Rust test
 * vectors verbatim) in the same commit. The Rust vectors are the source of
 * truth; do not "improve" them here.
 *
 * Divergence notes (mechanical, not behavioral):
 * - Rust `char::is_control()` (Unicode Cc) is `/\p{Cc}/u` here.
 * - Rust `char::is_whitespace()` (Unicode White_Space) trims via
 *   `\p{White_Space}` so the "required" check matches Rust `str::trim()`.
 * - `system_prompt.len()` is BYTES in Rust — counted through TextEncoder.
 * - `Extended_Pictographic` property data comes from each engine's Unicode
 *   tables (V8 here, the regex crate there); the vectors in the test suite
 *   are stable across Unicode versions both engines ship.
 */

export const MAX_DISPLAY_NAME_CHARS = 128;
export const MAX_SYSTEM_PROMPT_BYTES = 64 * 1024;

const EMOJI_VARIATION_SELECTOR = 0xfe0f;
const ZERO_WIDTH_JOINER = 0x200d;
const EMOJI_MODIFIER_FIRST = 0x1f3fb;
const EMOJI_MODIFIER_LAST = 0x1f3ff;

const IS_CONTROL = /\p{Cc}/u;
const IS_EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const RUST_TRIM = /^[\p{White_Space}]+|[\p{White_Space}]+$/gu;

export type DefinitionTextResult = { ok: true } | { ok: false; error: string };

/**
 * Validate the human-visible fields of an agent definition. Returns
 * `{ ok: true }` or `{ ok: false, error }` with the Rust wording verbatim.
 */
export function validateAgentDefinitionText(
  displayName: string,
  systemPrompt: string,
): DefinitionTextResult {
  if (displayName.replace(RUST_TRIM, "") === "") {
    return { ok: false, error: "Display name is required" };
  }
  const displayNameChars = Array.from(displayName).length;
  if (displayNameChars > MAX_DISPLAY_NAME_CHARS) {
    return {
      ok: false,
      error: `Display name is too long (${displayNameChars} characters, max ${MAX_DISPLAY_NAME_CHARS})`,
    };
  }
  const systemPromptBytes = new TextEncoder().encode(systemPrompt).length;
  if (systemPromptBytes > MAX_SYSTEM_PROMPT_BYTES) {
    return {
      ok: false,
      error: `Agent instructions are too long (${systemPromptBytes} bytes, max ${MAX_SYSTEM_PROMPT_BYTES})`,
    };
  }

  const nameCheck = validateVisibleText(displayName, "Display name", false);
  if (!nameCheck.ok) {
    return nameCheck;
  }
  return validateVisibleText(systemPrompt, "Agent instructions", true);
}

function validateVisibleText(
  value: string,
  label: string,
  allowLayoutControls: boolean,
): DefinitionTextResult {
  const characters = Array.from(value);
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    const allowedLayoutControl =
      allowLayoutControls && (character === "\n" || character === "\t");
    const allowedEmojiFormat = isAllowedEmojiFormat(characters, index);
    if (
      (!allowedLayoutControl && IS_CONTROL.test(character)) ||
      (isDefaultIgnorable(codePoint) && !allowedEmojiFormat)
    ) {
      return {
        ok: false,
        error: `${label} contains prohibited invisible or formatting character U+${formatCodePoint(codePoint)}`,
      };
    }
  }
  return { ok: true };
}

function formatCodePoint(codePoint: number): string {
  // Rust `{:04X}` — uppercase hex, at least four digits.
  return codePoint.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * The narrow contextual exception for rendered emoji composition (FE0F after
 * a variation base; ZWJ between an emoji base and a following pictographic).
 * Detached selectors and every other default-ignorable character are rejected.
 */
function isAllowedEmojiFormat(characters: string[], index: number): boolean {
  const codePoint = characters[index].codePointAt(0);
  if (codePoint === EMOJI_VARIATION_SELECTOR) {
    const previous = index > 0 ? characters[index - 1] : undefined;
    return previous !== undefined && isEmojiVariationBase(previous);
  }
  if (codePoint === ZERO_WIDTH_JOINER) {
    return (
      hasPrecedingEmojiBase(characters, index) &&
      index + 1 < characters.length &&
      isExtendedPictographic(characters[index + 1])
    );
  }
  return false;
}

function hasPrecedingEmojiBase(characters: string[], index: number): boolean {
  for (let previous = index - 1; previous >= 0; previous--) {
    const character = characters[previous];
    const codePoint = character.codePointAt(0);
    if (codePoint !== EMOJI_VARIATION_SELECTOR && !isEmojiModifier(character)) {
      return isExtendedPictographic(character);
    }
  }
  return false;
}

function isEmojiVariationBase(character: string): boolean {
  return (
    character === "#" ||
    character === "*" ||
    (character >= "0" && character <= "9") ||
    isExtendedPictographic(character)
  );
}

function isEmojiModifier(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    codePoint >= EMOJI_MODIFIER_FIRST &&
    codePoint <= EMOJI_MODIFIER_LAST
  );
}

function isExtendedPictographic(character: string): boolean {
  return IS_EXTENDED_PICTOGRAPHIC.test(character);
}

/**
 * Unicode `Default_Ignorable_Code_Point` ranges (DerivedCoreProperties).
 * Mirrors `is_default_ignorable` in definition_validation.rs exactly — every
 * range, in the same order. Joiners and variation selectors remain in this
 * set; only the contextual emoji exception above can let one through.
 */
export function isDefaultIgnorable(codePoint: number): boolean {
  return (
    codePoint === 0x00ad ||
    codePoint === 0x034f ||
    codePoint === 0x061c ||
    (codePoint >= 0x115f && codePoint <= 0x1160) ||
    (codePoint >= 0x17b4 && codePoint <= 0x17b5) ||
    (codePoint >= 0x180b && codePoint <= 0x180f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0x3164 ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0xfeff ||
    codePoint === 0xffa0 ||
    (codePoint >= 0xfff0 && codePoint <= 0xfff8) ||
    (codePoint >= 0x1bca0 && codePoint <= 0x1bca3) ||
    (codePoint >= 0x1d173 && codePoint <= 0x1d17a) ||
    (codePoint >= 0xe0000 && codePoint <= 0xe0fff)
  );
}
