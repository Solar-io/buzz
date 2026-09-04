/**
 * Huddle emoji reactions — kind 24810.
 *
 * `KIND_HUDDLE_REACTION = 24810` (crates/buzz-core/src/kind.rs:497) is an
 * EPHEMERAL kind: 20000–29999 is "Redis pub/sub only, never stored"
 * (kind.rs:474). Two consequences the wire shape here has to respect.
 *
 * 1. There is no history. `handle_ephemeral_event`
 *    (crates/buzz-relay/src/handlers/event.rs:795) publishes to
 *    `EventTopic::Channel(ch_id)` and fans out to local subscribers, and
 *    nothing writes a row. A REQ that opens after the burst gets nothing —
 *    so `since` on the live filter is a courtesy, not a backfill, and a
 *    reaction missed while disconnected is simply gone. That is the desktop's
 *    behaviour too (HuddleBar.tsx:423).
 * 2. The `h` tag is load-bearing twice. It is what
 *    `super::ingest::extract_channel_id` reads to run the membership check
 *    (event.rs:850) — no `h`, no channel scope, and the event takes the
 *    channel-less "global" path where nobody in the huddle is listening. And
 *    on the read side the relay resolves subscription scope PER REQ: a filter
 *    without `#h` registers the whole subscription as global and then never
 *    matches a channel-carrying event. Same trap `huddleRegistry.ts`
 *    documents for 48100/48103.
 *
 * Wire shape mirrors the desktop's `huddleReactionTags` /
 * `parseHuddleReactionEvent` (desktop/src/features/huddle/components/
 * HuddleBar.tsx:104-144) exactly, so a browser burst and a desktop burst are
 * the same event:
 *
 *   kind    24810
 *   content the emoji (unicode glyph, or `:shortcode:`)
 *   tags    ["h", ephemeralChannelId]
 *           ["reaction", emoji]           — read in preference to content
 *           ["sender_name", displayName]  — clamped to 48 chars
 *           ["emoji", shortcode, url]     — NIP-30, custom emoji only
 *
 * Import-free apart from sibling `.ts` modules, so `node --test` loads it.
 */

/** `KIND_HUDDLE_REACTION` — crates/buzz-core/src/kind.rs:497. */
export const HUDDLE_REACTION_KIND = 24810;

/**
 * Desktop's `HUDDLE_REACTION_NAME_MAX` (HuddleBar.tsx:72). A sender name is
 * attacker-controlled text rendered in an overlay; the cap is what keeps a
 * 4 kB "name" from painting over the call.
 */
export const HUDDLE_REACTION_NAME_MAX = 48;

/** The minimum event shape this module reads. */
export interface ReactionEventLike {
  kind: number;
  pubkey: string;
  content: string;
  tags: string[][];
}

export interface HuddleReaction {
  /** Unicode glyph, or `:shortcode:` for a custom emoji. */
  emoji: string;
  /** Image URL when `emoji` is a known custom-emoji shortcode, else null. */
  emojiUrl: string | null;
  /** Clamped display name of whoever sent it. */
  senderName: string;
}

function firstTagValue(event: ReactionEventLike, name: string): string | null {
  return event.tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

/**
 * `:shortcode:` → `shortcode`, lowercased; null for a unicode glyph.
 * Matches the desktop's `customEmojiShortcode` (HuddleBar.tsx:87).
 */
export function reactionShortcode(emoji: string): string | null {
  const trimmed = emoji.trim();
  if (!trimmed.startsWith(":") || !trimmed.endsWith(":")) {
    return null;
  }
  const shortcode = trimmed.slice(1, -1).trim().toLowerCase();
  return shortcode.length > 0 ? shortcode : null;
}

/** Trim, then ellipsize past the cap — desktop `clampReactionName`. */
export function clampReactionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= HUDDLE_REACTION_NAME_MAX) {
    return trimmed;
  }
  return `${trimmed.slice(0, HUDDLE_REACTION_NAME_MAX - 1).trimEnd()}…`;
}

/**
 * Decode one 24810 into something renderable, or null when it is not a
 * reaction we can draw (wrong kind, or no emoji anywhere).
 *
 * `reaction` tag wins over `content` because that is the desktop's order;
 * both carry the same glyph on anything this client sent.
 */
export function huddleReactionFromEvent(
  event: ReactionEventLike,
  fallbackName: (pubkey: string) => string,
): HuddleReaction | null {
  if (event.kind !== HUDDLE_REACTION_KIND) {
    return null;
  }
  const emoji = (firstTagValue(event, "reaction") ?? event.content).trim();
  if (!emoji) {
    return null;
  }
  const shortcode = reactionShortcode(emoji);
  const emojiUrl =
    shortcode === null
      ? null
      : (event.tags.find(
          (tag) =>
            tag[0] === "emoji" &&
            tag[1]?.toLowerCase() === shortcode &&
            typeof tag[2] === "string" &&
            tag[2].length > 0,
        )?.[2] ?? null);
  const senderName = clampReactionName(
    firstTagValue(event, "sender_name") ?? fallbackName(event.pubkey),
  );
  return { emoji, emojiUrl, senderName };
}

/** The unsigned event template for one outgoing reaction. */
export interface UnsignedReactionEvent {
  kind: number;
  tags: string[][];
  content: string;
}

/**
 * Build the outgoing 24810, or an error for input the relay would reject.
 *
 * An empty emoji is refused rather than sent: the relay accepts it (nothing
 * validates 24810 content) and every client then draws nothing, which reads
 * as a dropped reaction rather than a refused one.
 */
export function buildHuddleReactionEvent(input: {
  channelId: string;
  emoji: string;
  senderName: string;
  /** Resolved custom-emoji image URL; only used for a `:shortcode:` emoji. */
  emojiUrl?: string | null;
}): { event: UnsignedReactionEvent } | { error: string } {
  const emoji = input.emoji.trim();
  if (emoji.length === 0) {
    return { error: "an emoji is required" };
  }
  if (input.channelId.length === 0) {
    return { error: "channel id is required" };
  }
  const tags: string[][] = [
    ["h", input.channelId],
    ["reaction", emoji],
    ["sender_name", clampReactionName(input.senderName)],
  ];
  const shortcode = reactionShortcode(emoji);
  if (shortcode !== null && input.emojiUrl) {
    tags.push(["emoji", shortcode, input.emojiUrl]);
  }
  return { event: { kind: HUDDLE_REACTION_KIND, tags, content: emoji } };
}

/**
 * The live REQ filter for one huddle's reactions.
 *
 * `#h` is mandatory (see the module note). `since` is "from now": there is no
 * stored history to replay, and a stale `since` would only widen the window
 * in which a relay that DID buffer could repaint an old burst.
 */
export function huddleReactionFilter(
  channelId: string,
  sinceSeconds: number,
): { kinds: number[]; "#h": string[]; since: number; limit: number } {
  return {
    kinds: [HUDDLE_REACTION_KIND],
    "#h": [channelId],
    since: sinceSeconds,
    limit: 100,
  };
}
