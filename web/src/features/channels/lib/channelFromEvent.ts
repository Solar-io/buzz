import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

export interface ChannelSummary {
  id: string;
  name: string;
  about: string;
  updatedAt: number;
  /** Channel type from the relay's `t` tag; "stream" when absent. */
  type: "stream" | "forum" | "dm";
  /**
   * True when the relay's `archived` tag is set — the relay's own comment on
   * the tag: "clients use this to hide channels from the sidebar" (expired
   * ephemeral/huddle channels land here once their TTL deadline passes).
   */
  archived: boolean;
  /** Relay `private` tag on the 39000 — drives the padlock glyph. */
  isPrivate: boolean;
  /**
   * Relay `topic` tag. Separate from `about`: the relay stores topic,
   * description and purpose as three columns and emits three tags. The
   * header renders the first non-empty one — see lib/channelDescription.ts.
   */
  topic: string;
  /** Relay `purpose` tag. */
  purpose: string;
  /**
   * Relay `ttl_deadline` tag (RFC-3339) — when this ephemeral channel gets
   * archived. `ttlSeconds` says a channel is temporary; only the deadline
   * says when, so the countdown badge needs this one.
   */
  ttlDeadline: string | null;
  /**
   * Ephemeral-channel TTL seconds from the relay's `ttl` tag; null = permanent.
   * Huddle backing channels carry 3600 — group them apart from real channels.
   */
  ttlSeconds: number | null;
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
  const archived = tags.some((tag) => tag[0] === "archived");
  const isPrivate = tags.some(
    (tag) =>
      tag[0] === "private" &&
      (tag.length === 1 || tag[1] === undefined || tag[1] === ""),
  );
  const rawTtl = tags.find((tag) => tag[0] === "ttl")?.[1];
  const parsedTtl =
    typeof rawTtl === "string" && /^\d+$/.test(rawTtl)
      ? Number.parseInt(rawTtl, 10)
      : null;
  const participantPubkeys = tags
    .filter((tag) => tag[0] === "p" && typeof tag[1] === "string")
    .map((tag) => tag[1]);
  return {
    id,
    name: name || id,
    about,
    updatedAt: event.created_at,
    type,
    archived,
    isPrivate,
    topic: tags.find((tag) => tag[0] === "topic")?.[1] ?? "",
    purpose: tags.find((tag) => tag[0] === "purpose")?.[1] ?? "",
    ttlDeadline: tags.find((tag) => tag[0] === "ttl_deadline")?.[1] ?? null,
    ttlSeconds: parsedTtl,
    participantPubkeys,
  };
}
