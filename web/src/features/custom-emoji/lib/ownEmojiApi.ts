/**
 * Relay side of "my own custom emoji set".
 *
 * Thin on purpose: every decision about what the next set should contain is
 * made by the pure functions in `ownEmojiSet.ts`. This file only does the two
 * things that need a relay — read my latest kind:30030 back, and publish a
 * replacement — so the logic worth testing is testable without one.
 *
 * The read is a one-shot REQ rather than a subscription. The palette store
 * already holds a live subscription for the community union; a settings card
 * that opens once and edits deliberately wants a snapshot it can compute
 * against, and re-reading before every publish is what makes the
 * read-modify-write safe against an edit made in another tab.
 */

import { queryOnce } from "@/features/channels/lib/unreact.ts";
import type { RelaySession } from "@/shared/api/relay-session";
import { signNostrEvent } from "@/shared/lib/nostr-signer";

import {
  customEmojiFromTags,
  CUSTOM_EMOJI_SET_D_TAG,
  KIND_EMOJI_SET,
  type CustomEmoji,
} from "./customEmoji.ts";
import { ownEmojiSetTags } from "./ownEmojiSet.ts";

/** The caller's OWN latest set. Empty when they have never published one. */
export async function fetchOwnEmoji(
  session: RelaySession,
  pubkey: string,
): Promise<CustomEmoji[]> {
  const events = await queryOnce(session, {
    kinds: [KIND_EMOJI_SET],
    "#d": [CUSTOM_EMOJI_SET_D_TAG],
    authors: [pubkey],
    limit: 1,
  });
  // The relay keeps only the latest per (pubkey, d_tag), but a reconnect can
  // still deliver more than one; take the newest by created_at rather than
  // trusting arrival order.
  const latest = events.reduce<(typeof events)[number] | null>(
    (best, event) =>
      best === null || event.created_at > best.created_at ? event : best,
    null,
  );
  return latest ? customEmojiFromTags(latest.tags) : [];
}

/**
 * Publish the caller's replaced set.
 *
 * Throws on a relay refusal rather than returning a flag: every caller here
 * is a mutation whose only sensible response to "the relay said no" is to
 * surface the relay's own message, and a thrown error carries it without each
 * call site re-deriving one.
 */
export async function publishOwnEmojiSet(
  session: RelaySession,
  emoji: ReadonlyArray<CustomEmoji>,
): Promise<void> {
  const event = await signNostrEvent({
    kind: KIND_EMOJI_SET,
    content: "",
    tags: ownEmojiSetTags(emoji),
  });
  const result = await session.publish(event);
  if (!result.ok) {
    throw new Error(result.message || "The relay rejected the emoji set.");
  }
}
