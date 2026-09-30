import { truncatePubkey } from "@/shared/lib/pubkey";
import type { Profile } from "../hooks.ts";

/**
 * Display name for a pubkey, falling back to its truncated hex. Lives in lib
 * so the row components can use it without importing back through
 * ChannelTimeline (which re-exports it for the existing call sites).
 */
export function authorLabel(
  pubkey: string,
  profiles: Map<string, Profile>,
): string {
  return profiles.get(pubkey)?.displayName ?? truncatePubkey(pubkey);
}

/** Author labels for relay-authored `buzz-system` messages, by tag value. */
const BUZZ_SYSTEM_LABELS: Record<string, string> = {
  "call-transcript": "Call transcript",
};

/**
 * Author label for a timeline row. A relay-authored `buzz-system` message
 * (the huddle call transcript) is labelled by what it is — the relay key has
 * no profile, so `authorLabel` would show its truncated hex. Everything else
 * is `authorLabel`.
 */
export function messageAuthorLabel(
  message: { authorPubkey: string; buzzSystem?: string | null },
  profiles: Map<string, Profile>,
): string {
  if (message.buzzSystem) {
    return BUZZ_SYSTEM_LABELS[message.buzzSystem] ?? "Buzz";
  }
  return authorLabel(message.authorPubkey, profiles);
}
