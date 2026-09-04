/**
 * Parser and search over the packed Unicode emoji table.
 *
 * The table itself is generated data (see ./unicodeEmojiData.ts). Everything
 * here is pure: the picker calls `unicodeEmojiCategories()` for the browse
 * grid and `searchUnicodeEmoji()` for the search grid, and neither touches the
 * DOM, React, or the relay.
 */

import {
  PACKED_EMOJI_CATEGORIES,
  type PackedEmojiCategory,
} from "./unicodeEmojiData.ts";

export interface UnicodeEmoji {
  /** Stable shortcode-style id (`thumbsup`, `star-struck`). Also the key. */
  id: string;
  /** Default glyph, with no skin-tone modifier applied. */
  glyph: string;
  /**
   * Space-separated search terms. The id's own words are deliberately absent —
   * {@link matchRank} searches the id directly, so repeating them in the table
   * would only cost bytes.
   */
  keywords: string;
  /**
   * The five skin-tone variants, lightest first, or an empty array for an
   * emoji with none.
   *
   * Stored rather than derived. Inserting the tone modifier after the first
   * codepoint reproduces 298 of the 305 tone-capable sequences, but the seven
   * multi-person ones (`people_holding_hands`, the kiss/couple family) carry a
   * modifier on EACH person and would come out wrong. A rule with a seven-case
   * exception list is worse than a table.
   */
  tones: readonly string[];
}

export interface UnicodeEmojiCategory {
  id: string;
  label: string;
  emoji: readonly UnicodeEmoji[];
}

/** Number of skin-tone variants an emoji has when it has any. */
export const SKIN_TONE_COUNT = 5;

/** Labels for the tone chooser; index 0 is the default (no modifier). */
export const SKIN_TONE_LABELS: readonly string[] = [
  "Default",
  "Light",
  "Medium-light",
  "Medium",
  "Medium-dark",
  "Dark",
];

/** Swatches for the tone chooser, aligned with {@link SKIN_TONE_LABELS}. */
export const SKIN_TONE_SWATCHES: readonly string[] = [
  "✋",
  "✋🏻",
  "✋🏼",
  "✋🏽",
  "✋🏾",
  "✋🏿",
];

/**
 * Decode one packed category table into records.
 *
 * Malformed records (missing the id or the glyph) are skipped rather than
 * throwing: the table is generated, but a truncated one must degrade to a
 * smaller picker, never to a blank screen.
 */
export function parseEmojiTable(table: string): UnicodeEmoji[] {
  const emoji: UnicodeEmoji[] = [];
  if (table === "") {
    return emoji;
  }
  for (const record of table.split(";")) {
    const [id, glyph, keywords, tones] = record.split("|");
    if (!id || !glyph) {
      continue;
    }
    emoji.push({
      id,
      glyph,
      keywords: keywords ?? "",
      tones: tones ? splitTones(tones) : [],
    });
  }
  return emoji;
}

/**
 * Split the tone field back into its five glyphs.
 *
 * The generator joins them with commas precisely so this is a `split`: a tone
 * variant is a base sequence plus a modifier, so a concatenated blob could
 * only be taken apart by grapheme segmentation, and a wrong split renders
 * mojibake. A field that does not hold exactly five entries is treated as
 * having none, so a truncated table costs the tone chooser and nothing else.
 */
function splitTones(blob: string): string[] {
  const tones = blob.split(",");
  return tones.length === SKIN_TONE_COUNT ? tones : [];
}

let cachedCategories: UnicodeEmojiCategory[] | null = null;

/**
 * Every category, in picker order, decoded once and cached.
 *
 * Decoding ~1,900 records costs a couple of milliseconds; doing it on every
 * picker open would be visible on a slow machine, and the result is immutable.
 */
export function unicodeEmojiCategories(): readonly UnicodeEmojiCategory[] {
  if (!cachedCategories) {
    cachedCategories = PACKED_EMOJI_CATEGORIES.map(
      (category: PackedEmojiCategory) => ({
        id: category.id,
        label: category.label,
        emoji: parseEmojiTable(category.table),
      }),
    );
  }
  return cachedCategories;
}

/** Flat list across every category, in category order. */
export function allUnicodeEmoji(): readonly UnicodeEmoji[] {
  return unicodeEmojiCategories().flatMap((category) => category.emoji);
}

/**
 * Rank of `emoji` against `query`, or -1 for no match. Lower is better, so a
 * stable sort by rank puts exact ids first and loose keyword hits last.
 */
export function matchRank(emoji: UnicodeEmoji, query: string): number {
  const needle = query
    .trim()
    .toLowerCase()
    .replace(/^:+|:+$/g, "");
  if (needle === "") {
    return -1;
  }
  const id = emoji.id.toLowerCase();
  if (id === needle) {
    return 0;
  }
  if (id.startsWith(needle)) {
    return 1;
  }
  const words = emoji.keywords.split(" ");
  if (words.some((word) => word === needle)) {
    return 2;
  }
  if (id.includes(needle)) {
    return 3;
  }
  if (words.some((word) => word.startsWith(needle))) {
    return 4;
  }
  if (emoji.keywords.includes(needle)) {
    return 5;
  }
  return -1;
}

/**
 * Search the whole table, best matches first, capped at `limit`.
 *
 * Ties keep table order (Unicode order within a category), which is what makes
 * the result grid stable as the query grows a character at a time.
 */
export function searchUnicodeEmoji(query: string, limit = 90): UnicodeEmoji[] {
  const scored: { emoji: UnicodeEmoji; rank: number; index: number }[] = [];
  let index = 0;
  for (const emoji of allUnicodeEmoji()) {
    const rank = matchRank(emoji, query);
    if (rank >= 0) {
      scored.push({ emoji, rank, index });
    }
    index += 1;
  }
  scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return scored.slice(0, limit).map((entry) => entry.emoji);
}

/**
 * The glyph for `emoji` at `tone` (0 = default). Falls back to the default
 * glyph when the emoji has no tone variants, so callers never branch.
 */
export function toneGlyph(emoji: UnicodeEmoji, tone: number): string {
  if (tone <= 0 || emoji.tones.length !== SKIN_TONE_COUNT) {
    return emoji.glyph;
  }
  return emoji.tones[tone - 1] ?? emoji.glyph;
}
