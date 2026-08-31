/**
 * Typing indicators (kind 20002, KIND_TYPING_INDICATOR). The relay routes
 * them ephemeral; each carries an h channel tag and optional root/parent e
 * tags (see HarnessRelay::build_typing_event). We surface "who is typing in
 * this channel" with a short expiry — frames stop when the peer's composer
 * goes idle.
 */

import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

export const TYPING_KIND = 20002;
const TYPING_TTL_MS = 6000;

export interface TypingEntry {
  pubkey: string;
  lastSeenAt: number;
}

export type TypingMap = Map<string, TypingEntry>;

export function typingFromEvent(
  event: SignedNostrEvent,
): { channelId: string } | null {
  if (event.kind !== TYPING_KIND) {
    return null;
  }
  const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
  return channelId ? { channelId } : null;
}

export function recordTyping(
  map: TypingMap,
  channelId: string,
  pubkey: string,
  nowMs: number,
): TypingMap {
  const next = new Map(map);
  next.set(`${channelId}:${pubkey}`, { pubkey, lastSeenAt: nowMs });
  return next;
}

/** Pubkeys with a fresh typing frame in this channel (self excluded). */
export function activeTyping(
  map: TypingMap,
  channelId: string,
  selfPubkey: string | null,
  nowMs: number,
): string[] {
  const out: string[] = [];
  for (const [key, entry] of map) {
    if (nowMs - entry.lastSeenAt > TYPING_TTL_MS) {
      continue;
    }
    if (key.startsWith(`${channelId}:`) && entry.pubkey !== selfPubkey) {
      out.push(entry.pubkey);
    }
  }
  return out;
}
