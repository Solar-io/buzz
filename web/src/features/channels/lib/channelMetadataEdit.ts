import { canonicalChannelName } from "./channelAdmin.ts";
import { channelFromEvent } from "./channelFromEvent.ts";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/** Lifetime choices; null clears the TTL, matching the desktop writer. */
export const TTL_PRESETS = [
  { seconds: null, label: "Ongoing" },
  { seconds: 86400, label: "Temporary · 24 hours" },
  { seconds: 259200, label: "Temporary · 72 hours" },
  { seconds: 604800, label: "Temporary · 7 days" },
  { seconds: 2592000, label: "Temporary · 30 days" },
] as const;

export interface ChannelMetadataPatch {
  name?: string;
  purpose?: string;
  visibility?: "open" | "private";
  ttl?: number | null;
  archived?: boolean;
}

/** Only explicitly edited fields are sent. Never overwrite scratch about. */
export function editMetadataTags(
  channelId: string,
  patch: ChannelMetadataPatch,
): string[][] {
  const tags = [["h", channelId]];
  if (patch.name !== undefined) {
    const name = canonicalChannelName(patch.name);
    if (!name) throw new Error("Channel name is required.");
    tags.push(["name", name]);
  }
  if (patch.purpose !== undefined) tags.push(["purpose", patch.purpose.trim()]);
  if (patch.visibility !== undefined)
    tags.push(["visibility", patch.visibility]);
  if (patch.ttl !== undefined) {
    if (
      patch.ttl !== null &&
      (!Number.isInteger(patch.ttl) || patch.ttl <= 0 || patch.ttl > 2147483647)
    ) {
      throw new Error("Lifetime must be a positive number of seconds.");
    }
    tags.push(["ttl", patch.ttl === null ? "" : String(patch.ttl)]);
  }
  if (patch.archived !== undefined)
    tags.push(["archived", String(patch.archived)]);
  if (tags.length === 1) throw new Error("Choose a channel detail to change.");
  return tags;
}

/** Parse the relay's channel metadata, including the read-only joining rule. */
export function parseChannelAbout(event: SignedNostrEvent) {
  if (event.kind !== 39000) return null;
  const channel = channelFromEvent(event);
  if (!channel) return null;
  return {
    name: channel.name,
    purpose: channel.purpose,
    visibility: channel.isPrivate ? "private" : "open",
    ttl: channel.ttlSeconds,
    type: channel.type,
    archived: channel.archived,
    joining: channel.joining ?? "invite",
  };
}
