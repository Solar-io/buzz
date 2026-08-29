import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

export interface ChannelSummary {
  id: string;
  name: string;
  about: string;
  updatedAt: number;
  /** Channel type from the relay's `t` tag; "stream" when absent. */
  type: "stream" | "forum" | "dm";
  /**
   * Participant pubkeys from the relay's `p` tags. The relay includes them
   * on DM metadata precisely so clients can name DMs without a kind:39002
   * fetch; empty on non-DM channels parsed from older emissions.
   */
  participantPubkeys: string[];
}

/**
 * NIP-29 group metadata (kind 39000): d tag = channel id; name/about live in
 * TAGS (matching the relay's own emission), content is not the source.
 */
export function channelFromEvent(
  event: SignedNostrEvent,
): ChannelSummary | null {
  const tags = event.tags.filter(
    (tag): tag is [string, ...string[]] => Array.isArray(tag) && tag.length > 0,
  );
  const id = tags.find((tag) => tag[0] === "d")?.[1];
  if (!id) {
    return null;
  }
  const name = tags.find((tag) => tag[0] === "name")?.[1] ?? "";
  const about = tags.find((tag) => tag[0] === "about")?.[1] ?? "";
  const rawType = tags.find((tag) => tag[0] === "t")?.[1];
  const type: ChannelSummary["type"] =
    rawType === "dm" || rawType === "forum" ? rawType : "stream";
  const participantPubkeys = tags
    .filter((tag) => tag[0] === "p" && typeof tag[1] === "string")
    .map((tag) => tag[1]);
  return {
    id,
    name: name || id,
    about,
    updatedAt: event.created_at,
    type,
    participantPubkeys,
  };
}
