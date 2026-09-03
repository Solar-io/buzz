/**
 * The composer's idle hint.
 *
 * The web composer said "Message — @ to mention, Shift+Enter for newline":
 * two keyboard tips and no context. The desktop says where you are and who you
 * are answering (`MessageComposer.tsx`):
 *
 *   Edit your message
 *   Reply to <author> in #<channel>
 *   Message #<channel>
 *
 * and its thread panel overrides with `Reply in thread to <author>`. Those are
 * reproduced verbatim, with one deliberate divergence: a DM channel takes no
 * `#`, because "Message #Sam Gallant" reads as a channel that does not exist.
 *
 * Where the name comes from. The main channel composer is mounted by
 * `app/routes/repos.tsx`, which passes the channel *id* (as `draftKey`) and no
 * name. Rather than thread a new prop through the route, the name is resolved
 * from the channel seed `useChannels` already write-throughs to localStorage —
 * a synchronous read of data that is present on every render after the first
 * channel list arrives. A caller that has the name (the thread panel, the
 * forum views) passes it directly and skips the lookup entirely.
 */

// Relative, not the `@/` alias: this module is exercised by a `node --test`
// spec, and that runner has no path-alias resolver.
import { loadSeed } from "../../../shared/lib/localSeed.ts";
import type { ChannelSummary } from "./channelFromEvent.ts";

/** Same key `useChannels` merges its write-through seed under. */
const CHANNEL_SEED_KEY = "channels:v1";

export interface ChannelLabel {
  name: string;
  isDm: boolean;
}

/**
 * Look a channel's display name up from the seeded channel list.
 *
 * Returns null when the seed has not been written yet (a first-ever load, or
 * private-mode storage). The caller falls back to a generic hint rather than
 * rendering "Message #undefined".
 */
export function channelLabelFromSeed(
  channelId: string | null | undefined,
): ChannelLabel | null {
  if (!channelId) {
    return null;
  }
  let entry: unknown;
  try {
    entry = loadSeed(CHANNEL_SEED_KEY)[channelId];
  } catch {
    return null;
  }
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const summary = entry as Partial<ChannelSummary>;
  if (typeof summary.name !== "string" || summary.name.trim() === "") {
    return null;
  }
  return { name: summary.name, isDm: summary.type === "dm" };
}

/** "#general", or "Sam Gallant" for a DM. */
export function channelMention(label: ChannelLabel): string {
  return label.isDm ? label.name : `#${label.name}`;
}

export interface PlaceholderInput {
  /** An explicit override from the caller (forum views set their own). */
  override?: string;
  /** True while the composer holds a message being edited. */
  editing?: boolean;
  /** The channel being written to, when it is known. */
  channel?: ChannelLabel | null;
  /** Author of the message this reply is aimed at, when there is one. */
  replyToAuthor?: string | null;
}

/**
 * Build the placeholder. Ordering matches the desktop: edit wins over
 * everything, then an explicit override, then reply context, then the channel.
 */
export function composerPlaceholder(input: PlaceholderInput): string {
  if (input.editing) {
    return "Edit your message";
  }
  if (input.override) {
    return input.override;
  }
  if (input.replyToAuthor && input.channel) {
    return `Reply to ${input.replyToAuthor} in ${channelMention(input.channel)}`;
  }
  if (input.replyToAuthor) {
    return `Reply to ${input.replyToAuthor}`;
  }
  if (input.channel) {
    return `Message ${channelMention(input.channel)}`;
  }
  // No channel name yet (seed not written, or a surface with no channel).
  return "Message — @ to mention, Shift+Enter for newline";
}
