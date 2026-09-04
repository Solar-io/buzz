/**
 * Editing the caller's OWN kind:30030 emoji set.
 *
 * The community palette is a read-only union of every member's set
 * (`customEmoji.ts`); the only thing a member can publish is their own. So
 * every management action — add, rename, remove — is the same shape:
 * read my own set, compute the next one, republish it under
 * `(pubkey, 30030, "buzz:custom-emoji")`, and let NIP-33 replacement do the
 * rest. There is no delete-one operation on the wire.
 *
 * That "compute the next one" step is the part worth testing, so it lives
 * here as a pure function over arrays. This module reaches for no relay, no
 * signer, no DOM and no React — `node --test` loads it directly.
 *
 * RENAME is the operation the desktop client does not have. On the wire it is
 * not a distinct action either: it is the same republish with one entry's
 * shortcode changed, which is why it belongs here rather than in the API
 * layer. The rules it has to enforce are the interesting part — a rename onto
 * an existing shortcode of my own would silently destroy that entry, and a
 * rename to an invalid shortcode would be rejected by the relay at ingest
 * (`validate_custom_emoji_tags`, crates/buzz-relay/src/handlers/ingest.rs).
 */

import {
  CUSTOM_EMOJI_SET_D_TAG,
  normalizeShortcode,
  type CustomEmoji,
} from "./customEmoji.ts";

/**
 * Suggest a shortcode from an uploaded filename, as the desktop client's
 * `suggestShortcodeFromFilename` does: strip any directory and extension,
 * lowercase, collapse runs of illegal characters to a single underscore, and
 * trim leading/trailing separators. Returns null when nothing legal is left.
 */
export function suggestShortcodeFromFilename(filename: string): string | null {
  const basename = filename
    .trim()
    .replace(/^.*[/\\]/, "")
    .replace(/\.[^.]*$/, "");
  const suggested = basename
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return normalizeShortcode(suggested);
}

/** The tags of a member's own 30030, in publish order. */
export function ownEmojiSetTags(emoji: ReadonlyArray<CustomEmoji>): string[][] {
  return [
    ["d", CUSTOM_EMOJI_SET_D_TAG],
    ...emoji.map(({ shortcode, url }) => ["emoji", shortcode, url]),
  ];
}

/** Sort by shortcode so a republish is stable regardless of edit order. */
function sorted(emoji: ReadonlyArray<CustomEmoji>): CustomEmoji[] {
  return [...emoji].sort((a, b) => a.shortcode.localeCompare(b.shortcode));
}

export type EmojiEditError =
  | "invalid-shortcode"
  | "missing-url"
  | "not-found"
  | "shortcode-taken"
  | "unchanged";

export type EmojiEditResult =
  | { ok: true; next: CustomEmoji[]; shortcode: string }
  | { ok: false; error: EmojiEditError };

/**
 * Add an emoji, or replace the image of one I already have.
 *
 * Replacing in place is deliberate and matches the desktop: a member who
 * uploads a new image under a name they already use means "use this one now",
 * and two entries under one shortcode is a state the palette cannot represent
 * (downstream identity is shortcode-only).
 */
export function addOwnEmoji(
  own: ReadonlyArray<CustomEmoji>,
  rawShortcode: string,
  url: string,
): EmojiEditResult {
  const shortcode = normalizeShortcode(rawShortcode);
  if (!shortcode) {
    return { ok: false, error: "invalid-shortcode" };
  }
  if (!url.trim()) {
    return { ok: false, error: "missing-url" };
  }
  const existing = own.find((entry) => entry.shortcode === shortcode);
  if (existing?.url === url) {
    return { ok: false, error: "unchanged" };
  }
  return {
    ok: true,
    shortcode,
    next: sorted([
      ...own.filter((entry) => entry.shortcode !== shortcode),
      { shortcode, url },
    ]),
  };
}

/**
 * Rename one of my own emoji, keeping its image.
 *
 * Refuses to overwrite another of my entries. Renaming onto a shortcode that
 * only exists in SOMEONE ELSE's set is allowed — that is a collision the
 * palette already resolves deterministically (`unionCustomEmoji`), and
 * forbidding it would let any member reserve names across the community.
 */
export function renameOwnEmoji(
  own: ReadonlyArray<CustomEmoji>,
  fromShortcode: string,
  rawTo: string,
): EmojiEditResult {
  const from = normalizeShortcode(fromShortcode);
  const to = normalizeShortcode(rawTo);
  if (!to) {
    return { ok: false, error: "invalid-shortcode" };
  }
  const entry = from
    ? own.find((candidate) => candidate.shortcode === from)
    : undefined;
  if (!entry) {
    return { ok: false, error: "not-found" };
  }
  if (to === from) {
    return { ok: false, error: "unchanged" };
  }
  if (own.some((candidate) => candidate.shortcode === to)) {
    return { ok: false, error: "shortcode-taken" };
  }
  return {
    ok: true,
    shortcode: to,
    next: sorted([
      ...own.filter((candidate) => candidate.shortcode !== from),
      { shortcode: to, url: entry.url },
    ]),
  };
}

/** Remove one of my own emoji. A shortcode I do not own is `not-found`. */
export function removeOwnEmoji(
  own: ReadonlyArray<CustomEmoji>,
  rawShortcode: string,
): EmojiEditResult {
  const shortcode = normalizeShortcode(rawShortcode);
  const next = shortcode
    ? own.filter((entry) => entry.shortcode !== shortcode)
    : [...own];
  if (!shortcode || next.length === own.length) {
    return { ok: false, error: "not-found" };
  }
  return { ok: true, shortcode, next: sorted(next) };
}

/** Human-readable reason for a refused edit. */
export function emojiEditMessage(error: EmojiEditError): string {
  switch (error) {
    case "invalid-shortcode":
      return "Use only letters, numbers, hyphen, or underscore.";
    case "missing-url":
      return "Upload an image first.";
    case "not-found":
      return "That emoji is not in your set.";
    case "shortcode-taken":
      return "You already have an emoji with that name.";
    case "unchanged":
      return "Nothing to change.";
  }
}
