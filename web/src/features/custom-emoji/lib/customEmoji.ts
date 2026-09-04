/**
 * Community custom emoji — the NIP-30 wire format, as the relay defines it.
 *
 * Every member publishes their OWN kind:30030 parameterized-replaceable event,
 * signed as themselves and keyed by `(pubkey, 30030, "buzz:custom-emoji")`.
 * The community palette is the client-side UNION of every member's set,
 * collapsed to one entry per shortcode — a view computed on read, never stored
 * state.
 *
 * Contract, read off the Rust rather than inferred:
 * - `crates/buzz-core/src/kind.rs:52` — `KIND_EMOJI_SET = 30030`, documented as
 *   "the workspace emoji palette is the client-side union of everyone's sets".
 * - `crates/buzz-sdk/src/builders.rs:514` — `CUSTOM_EMOJI_SET_D_TAG =
 *   "buzz:custom-emoji"`.
 * - `crates/buzz-sdk/src/builders.rs:132` —
 *   `normalize_custom_emoji_shortcode`: trim, strip surrounding colons, reject
 *   empty, reject over 64 bytes, allow only ASCII alphanumerics plus `-` and
 *   `_`, then lowercase.
 * - `crates/buzz-relay/src/handlers/ingest.rs:145` —
 *   `validate_custom_emoji_tags` runs that normalizer over every `emoji` tag
 *   on a 30030/10030, so an invalid shortcode is rejected at ingest.
 *
 * NOTE for other NIP-30 clients: NIP-30 itself says a shortcode is
 * alphanumerics and underscores; Buzz additionally allows `-`. This module
 * follows the relay, because the relay is what accepts or rejects the event.
 */

/** NIP-30 / NIP-51 emoji set (parameterized-replaceable). */
export const KIND_EMOJI_SET = 30030;

/** d-tag under which a member publishes their own custom emoji set. */
export const CUSTOM_EMOJI_SET_D_TAG = "buzz:custom-emoji";

/** Longest shortcode the relay will accept, in bytes. */
export const MAX_SHORTCODE_LENGTH = 64;

export interface CustomEmoji {
  /** Canonical lowercase shortcode, WITHOUT surrounding colons. */
  shortcode: string;
  /** Image URL, as published in the `emoji` tag. */
  url: string;
}

/** The subset of a signed event this module reads. */
export interface EmojiSetEvent {
  tags: string[][];
  created_at: number;
}

const SHORTCODE_RE = /^[a-z0-9_-]+$/;

/**
 * Normalize a shortcode exactly as `normalize_custom_emoji_shortcode` does.
 * Returns null when the relay would reject it.
 */
export function normalizeShortcode(raw: string): string | null {
  const stripped = raw.trim().replace(/^:+/, "").replace(/:+$/, "");
  const lower = stripped.toLowerCase();
  if (lower.length === 0 || lower.length > MAX_SHORTCODE_LENGTH) {
    return null;
  }
  return SHORTCODE_RE.test(lower) ? lower : null;
}

/**
 * Parse the NIP-30 `["emoji", shortcode, url]` tags of ONE event.
 * Malformed entries are skipped; within a single event the first occurrence of
 * a shortcode wins.
 */
export function customEmojiFromTags(
  tags: ReadonlyArray<ReadonlyArray<string>>,
): CustomEmoji[] {
  const seen = new Set<string>();
  const emoji: CustomEmoji[] = [];
  for (const tag of tags) {
    const [name, rawShortcode, url] = tag;
    if (name !== "emoji" || !rawShortcode || !url) {
      continue;
    }
    const shortcode = normalizeShortcode(rawShortcode);
    if (!shortcode || seen.has(shortcode)) {
      continue;
    }
    seen.add(shortcode);
    emoji.push({ shortcode, url });
  }
  return emoji;
}

/**
 * Union every member's set into the community palette, one entry per
 * shortcode.
 *
 * When two members claim the same shortcode the most recently published set
 * wins; equal timestamps tie-break to the lexicographically smaller URL. Both
 * inputs are signed event data, so the palette is a pure function of the event
 * set and does not depend on the order they arrived in. Output is sorted by
 * shortcode.
 */
export function unionCustomEmoji(
  events: ReadonlyArray<EmojiSetEvent>,
): CustomEmoji[] {
  const byShortcode = new Map<string, { url: string; createdAt: number }>();
  for (const event of events) {
    for (const { shortcode, url } of customEmojiFromTags(event.tags)) {
      const winner = byShortcode.get(shortcode);
      if (
        winner === undefined ||
        event.created_at > winner.createdAt ||
        (event.created_at === winner.createdAt && url < winner.url)
      ) {
        byShortcode.set(shortcode, { url, createdAt: event.created_at });
      }
    }
  }
  return [...byShortcode]
    .map(([shortcode, { url }]) => ({ shortcode, url }))
    .sort((a, b) => a.shortcode.localeCompare(b.shortcode));
}

/** Index a palette by shortcode for O(1) resolution during rendering. */
export function emojiUrlMap(
  emoji: ReadonlyArray<CustomEmoji>,
): Map<string, string> {
  return new Map(emoji.map((entry) => [entry.shortcode, entry.url]));
}

/**
 * Resolve the image for a reaction whose content is a custom-emoji
 * `:shortcode:`. Returns undefined for a unicode reaction or an unknown
 * shortcode — in which case the chip renders the literal text, exactly as it
 * does today.
 */
export function reactionEmojiUrl(
  emoji: string,
  set: ReadonlyArray<CustomEmoji> | undefined,
): string | undefined {
  if (!set || !emoji.startsWith(":") || !emoji.endsWith(":")) {
    return undefined;
  }
  const shortcode = normalizeShortcode(emoji);
  if (!shortcode) {
    return undefined;
  }
  return set.find((entry) => entry.shortcode === shortcode)?.url;
}

/**
 * Custom emoji whose shortcode contains `query`, exact match first, then
 * prefix, then substring; ties by shortcode.
 *
 * Deliberately shortcode-only. A custom emoji has no keywords — the shortcode
 * IS its name — so a looser match would surface emoji the searcher cannot
 * connect to what they typed.
 */
export function searchCustomEmoji(
  palette: ReadonlyArray<CustomEmoji>,
  query: string,
): CustomEmoji[] {
  const needle = query
    .trim()
    .toLowerCase()
    .replace(/^:+|:+$/g, "");
  if (needle === "") {
    return [];
  }
  const rank = (code: string) =>
    code === needle ? 0 : code.startsWith(needle) ? 1 : 2;
  return palette
    .filter((entry) => entry.shortcode.includes(needle))
    .sort(
      (a, b) =>
        rank(a.shortcode) - rank(b.shortcode) ||
        a.shortcode.localeCompare(b.shortcode),
    );
}

/**
 * The Nostr filter for the community palette. `limit` is a member count, not a
 * history depth: the relay keeps only the latest 30030 per `(pubkey, d_tag)`.
 */
export function communityEmojiFilter(limit = 500) {
  return {
    kinds: [KIND_EMOJI_SET],
    "#d": [CUSTOM_EMOJI_SET_D_TAG],
    limit,
  };
}
