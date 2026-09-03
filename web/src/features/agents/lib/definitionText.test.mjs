import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgentDefinitionText } from "./definitionText.ts";

/**
 * Rust test vectors, ported VERBATIM from
 * `desktop/src-tauri/src/managed_agents/definition_validation.rs` (#[cfg(test)]
 * mod tests). Every case below names its Rust test. The vectors are the
 * rule-12 contract shared by the snapshot and catalog surfaces — if one of
 * these fails after an edit, the web mirror has drifted from the Rust
 * persistence boundary.
 *
 * Every invisible character is written as an explicit escape so this file
 * stays byte-inspectable (a literal soft hyphen in source is exactly the kind
 * of concealment rule 12 exists to prevent).
 */

// rejects_default_ignorable_characters_in_name_or_prompt — the eight chars:
// U+00AD, U+034F, U+200B, U+202E, U+2060, U+2066, U+3164, U+E007F.
const REJECTED_IGNORABLE = [
  "\u00AD",
  "\u034F",
  "\u200B",
  "\u202E",
  "\u2060",
  "\u2066",
  "\u3164",
  "\u{E007F}",
];

// rejects_detached_or_text_embedded_emoji_formatting — the three strings.
const DETACHED_FORMATTING = [
  "Review\uFE0Fer",
  "Review\u200Der",
  "Review code.\u200D",
];

// rejects_emoji_tag_sequences — the Scottish-flag emoji tag sequence.
const TAGGED_FLAG =
  "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";

// rejects_non_layout_control_characters — NUL, CR, BEL, NEL.
const NON_LAYOUT_CONTROLS = ["\u0000", "\u000D", "\u0007", "\u0085"];

// accepts_rendered_emoji_sequences_in_names_and_prompts — the six sequences.
const ACCEPTED_EMOJI = [
  "\u2764\uFE0F", // heart + variation selector
  "\u2615\uFE0F", // coffee + variation selector
  "\u{1F469}\u200D\u{1F4BB}", // woman technologist
  "\u{1F9D1}\u{1F3FD}\u200D\u{1F4BB}", // medium-skin-tone technologist
  "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}", // family
  "1\uFE0F\u20E3", // keycap 1
];

function ok(displayName, systemPrompt) {
  const result = validateAgentDefinitionText(displayName, systemPrompt);
  assert.equal(result.ok, true, JSON.stringify(result));
}

function rejected(displayName, systemPrompt) {
  const result = validateAgentDefinitionText(displayName, systemPrompt);
  assert.equal(
    result.ok,
    false,
    `expected rejection for ${JSON.stringify(displayName)} / ${JSON.stringify(systemPrompt)}`,
  );
}

test("accepts plain multiline instructions (Rust: accepts_plain_multiline_instructions)", () => {
  // "Code Reviewer 🐝" — the bee is a plain pictograph with no formatting.
  ok("Code Reviewer \u{1F41D}", "Review changes.\n\tCall out security risks.");
});

test("accepts rendered emoji sequences in names and prompts (Rust: accepts_rendered_emoji_sequences_in_names_and_prompts)", () => {
  for (const emoji of ACCEPTED_EMOJI) {
    ok(`Reviewer ${emoji}`, `Review changes ${emoji}`);
  }
});

test("rejects default-ignorable characters in name or prompt (Rust: rejects_default_ignorable_characters_in_name_or_prompt)", () => {
  for (const character of REJECTED_IGNORABLE) {
    rejected(`Review${character}er`, "Review code.");
    rejected("Reviewer", `Review code.${character}`);
  }
});

test("rejects detached or text-embedded emoji formatting (Rust: rejects_detached_or_text_embedded_emoji_formatting)", () => {
  for (const value of DETACHED_FORMATTING) {
    rejected(value, "Review code.");
    rejected("Reviewer", value);
  }
});

test("rejects emoji tag sequences (Rust: rejects_emoji_tag_sequences)", () => {
  rejected(`Reviewer ${TAGGED_FLAG}`, "Review code.");
  rejected("Reviewer", `Review code. ${TAGGED_FLAG}`);
});

test("rejects non-layout control characters (Rust: rejects_non_layout_control_characters)", () => {
  for (const character of NON_LAYOUT_CONTROLS) {
    rejected("Reviewer", `Review${character}code`);
  }
});

test("enforces display name and prompt bounds (Rust: enforces_display_name_and_prompt_bounds)", () => {
  rejected("a".repeat(129), "prompt");
  rejected("Reviewer", "a".repeat(64 * 1024 + 1));
});

test("blank display name is required-error, exactly the Rust wording", () => {
  assert.deepEqual(validateAgentDefinitionText("   ", "Review code."), {
    ok: false,
    error: "Display name is required",
  });
});

test("prohibited-character error names the field and code point, Rust wording", () => {
  assert.deepEqual(
    validateAgentDefinitionText("Review\u200Ber", "Review code."),
    {
      ok: false,
      error:
        "Display name contains prohibited invisible or formatting character U+200B",
    },
  );
  assert.deepEqual(
    validateAgentDefinitionText("Reviewer", "Review code.\u202E"),
    {
      ok: false,
      error:
        "Agent instructions contains prohibited invisible or formatting character U+202E",
    },
  );
  // Astral code point formats to five hex digits (Rust {:04X} widens, never
  // truncates).
  assert.deepEqual(validateAgentDefinitionText("Reviewer", "x\u{E007F}"), {
    ok: false,
    error:
      "Agent instructions contains prohibited invisible or formatting character U+E007F",
  });
});

test("bound errors carry the measured counts, Rust wording", () => {
  assert.deepEqual(validateAgentDefinitionText("a".repeat(129), "prompt"), {
    ok: false,
    error: "Display name is too long (129 characters, max 128)",
  });
  // 64*1024+1 ASCII characters are exactly 65537 UTF-8 bytes.
  assert.deepEqual(
    validateAgentDefinitionText("Reviewer", "a".repeat(64 * 1024 + 1)),
    {
      ok: false,
      error: "Agent instructions are too long (65537 bytes, max 65536)",
    },
  );
});

test("byte cap counts UTF-8 bytes, not UTF-16 units (mirror pin)", () => {
  // 21,846 × "é" (U+00E9, 2 UTF-8 bytes) = 43,692 bytes — under the cap;
  // 32,769 × "é" = 65,538 bytes — over the cap while its .length (32,769)
  // would still read as "under" against 65,536. Pins that the cap is the
  // Rust byte cap, not a JS character count.
  ok("Reviewer", "é".repeat(21846));
  rejected("Reviewer", "é".repeat(32769));
});

test("layout controls allowed only in the prompt, never the name (mirror pin)", () => {
  // \n and \t pass in instructions (allow_layout_controls=true)…
  ok("Reviewer", "line one\nline two\tindented");
  // …but the identical characters are prohibited in a display name.
  rejected("Bad\nName", "Review code.");
  rejected("Bad\tName", "Review code.");
});

test("line and paragraph separators are accepted like Rust (mirror pin)", () => {
  // U+2028/U+2029 are Zl/Zp — outside Cc and the default-ignorable table —
  // so the Rust validator accepts them in a prompt. Pinning this so a future
  // "broaden the rejection" edit cannot drift silently from Rust.
  ok("Reviewer", "one\u2028two\u2029three");
});

test("ZWJ chain across modifiers composes legally; detached ZWJ rejected", () => {
  // The skin-tone modifier between base and ZWJ must not break the
  // has_preceding_emoji_base walk (the 🧑🏽‍💻 path).
  ok(
    "Reviewer \u{1F9D1}\u{1F3FD}\u200D\u{1F4BB}",
    "Do work \u{1F469}\u{1F3FB}\u200D\u{1F4BC}",
  );
  // A ZWJ whose preceding run walks off the string start is detached.
  rejected("\u200Der", "Review code.");
  // Trailing ZWJ with no following pictographic is detached.
  rejected("Reviewer", "Review code.\u200D");
});
