/**
 * When the viewer last wrote in each conversation — the "most recently
 * used" half of the sidebar order (Sam, 2026-10-04: "If I just
 * communicated with you then you should be at the top of the list until I
 * communicate with other people who bump you from that top 4 spot").
 *
 * Built from the viewer's OWN signed messages on the relay, so a reply sent
 * from the phone moves the desktop list too. Opening a channel to read it
 * does not count; writing in it does.
 */

import {
  FORUM_COMMENT_KIND,
  FORUM_POST_KIND,
} from "@/features/channels/lib/forum.ts";

/** Kinds that count as the viewer talking in a conversation. */
export const OWN_MESSAGE_KINDS = [
  9,
  40002,
  FORUM_POST_KIND,
  FORUM_COMMENT_KIND,
] as const;

/** Conversation id → newest own message `created_at` (unix seconds). */
export type OwnLastSent = ReadonlyMap<string, number>;

interface MessageLike {
  kind: number;
  created_at: number;
  tags: readonly (readonly string[])[];
}

/**
 * Fold one own event in. Returns the SAME map when nothing changed (an
 * older or foreign-kind event), so React state skips the re-render.
 */
export function noteOwnMessage(
  last: OwnLastSent,
  event: MessageLike,
): OwnLastSent {
  if (!(OWN_MESSAGE_KINDS as readonly number[]).includes(event.kind)) {
    return last;
  }
  const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
  if (!channelId) {
    return last;
  }
  const previous = last.get(channelId) ?? 0;
  if (event.created_at <= previous) {
    return last;
  }
  const next = new Map(last);
  next.set(channelId, event.created_at);
  return next;
}
