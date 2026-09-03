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
