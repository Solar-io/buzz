/**
 * NIP-30 `["emoji", <shortcode>, <url>]` tag construction for outgoing events.
 *
 * A custom emoji only survives the trip to another client if the event carries
 * the tag: the content is just `:shortcode:` text, and a receiving client has
 * no way to resolve it otherwise. So the tag set is derived from the FINAL
 * content at send time, the same way @mentions become `p` tags.
 *
 * Shapes, from the spec and from the relay that enforces it:
 * - NIP-30 tag: exactly `["emoji", shortcode, image-url]` — three elements, in
 *   that order, and the content references it as `:shortcode:`.
 * - `crates/buzz-relay/src/handlers/ingest.rs:145` rejects any `emoji` tag
 *   whose shortcode fails `normalize_custom_emoji_shortcode`.
 * - `crates/buzz-sdk/src/builders.rs:494` (`build_custom_emoji_reaction`) is
 *   the reaction shape: kind 7, content `":shortcode:"`, tags `["e", target]`
 *   and `["emoji", shortcode, url]`.
 * - `crates/buzz-relay/src/handlers/ingest.rs:160` (`validate_reaction_emoji`)
 *   accepts a reaction over 64 characters ONLY when it is a canonical
 *   lowercase `:shortcode:` AND the event carries a matching `emoji` tag —
 *   so for a long shortcode the tag is not decoration, it is admission.
 */

import { normalizeShortcode, type CustomEmoji } from "./customEmoji.ts";

/** Scans content for `:shortcode:` tokens, case-insensitively. */
const SHORTCODE_SCAN = /:([a-z0-9_-]+):/gi;

/**
 * One `["emoji", shortcode, url]` tag per DISTINCT known custom emoji that
 * appears in `content`.
 *
 * Shortcodes are matched case-insensitively against the (lowercase) palette
 * and emitted in canonical lowercase. Unknown `:foo:` sequences are ignored —
 * tagging them would claim an image the community does not have. Order follows
 * first appearance.
 */
export function buildCustomEmojiTags(
  content: string,
  palette: ReadonlyArray<CustomEmoji>,
): string[][] {
  if (palette.length === 0) {
    return [];
  }
  const urlByShortcode = new Map(
    palette.map((entry) => [entry.shortcode, entry.url]),
  );
  const emitted = new Set<string>();
  const tags: string[][] = [];

  SHORTCODE_SCAN.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while (true) {
    match = SHORTCODE_SCAN.exec(content);
    if (!match) {
      break;
    }
    const shortcode = normalizeShortcode(match[1]);
    if (!shortcode || emitted.has(shortcode)) {
      continue;
    }
    const url = urlByShortcode.get(shortcode);
    if (!url) {
      continue;
    }
    emitted.add(shortcode);
    tags.push(["emoji", shortcode, url]);
  }
  return tags;
}

/**
 * The `emoji` tag for a kind:7 reaction whose content is `:shortcode:`, or
 * null when the reaction is a plain unicode glyph or names an emoji this
 * community does not have.
 *
 * Returns a single tag rather than a list because NIP-25 reaction content is
 * one emoji: there is never a second one to tag.
 */
export function buildReactionEmojiTag(
  reaction: string,
  palette: ReadonlyArray<CustomEmoji>,
): string[] | null {
  if (!reaction.startsWith(":") || !reaction.endsWith(":")) {
    return null;
  }
  const shortcode = normalizeShortcode(reaction);
  if (!shortcode) {
    return null;
  }
  const url = palette.find((entry) => entry.shortcode === shortcode)?.url;
  return url ? ["emoji", shortcode, url] : null;
}
