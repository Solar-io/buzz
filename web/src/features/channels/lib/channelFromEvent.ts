import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

export interface ChannelSummary {
  id: string;
  name: string;
  about: string;
  updatedAt: number;
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
  return {
    id,
    name: name || id,
    about,
    updatedAt: event.created_at,
  };
}
