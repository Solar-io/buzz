import {
  canonicalChannelName,
  type UnsignedEventTemplate,
} from "../../channel-templates/lib/applyTemplate.ts";

/** Lifetime presets use the relay's idle TTL, in seconds. Zero means ongoing. */
export const CHANNEL_LIFETIMES = [
  { label: "Ongoing", seconds: 0 },
  { label: "24 h", seconds: 86400 },
  { label: "72 h", seconds: 259200 },
  { label: "7 days", seconds: 604800 },
  { label: "30 days", seconds: 2592000 },
] as const;

/** A creation lifetime selection; ongoing is represented by zero. */
export type ChannelLifetime = (typeof CHANNEL_LIFETIMES)[number]["seconds"];

/** Build the same create request as buzz-sdk's build_create_channel. */
export function newChannelRequest(input: {
  channelId: string;
  name: string;
  about: string;
  isPrivate: boolean;
  type: "stream" | "forum";
  lifetime: ChannelLifetime;
}): { event: UnsignedEventTemplate } | { error: string } {
  const name = canonicalChannelName(input.name);
  if (!name) return { error: "Channel name is required." };
  if (!input.channelId) return { error: "Channel id is required." };
  if (!CHANNEL_LIFETIMES.some(({ seconds }) => seconds === input.lifetime)) {
    return { error: "Choose a channel lifetime from the list." };
  }
  const tags = [
    ["h", input.channelId],
    ["name", name],
    ["visibility", input.isPrivate ? "private" : "open"],
    ["channel_type", input.type],
  ];
  if (input.about.trim()) tags.push(["about", input.about.trim()]);
  if (input.lifetime > 0) tags.push(["ttl", String(input.lifetime)]);
  return { event: { kind: 9007, tags, content: "" } };
}
