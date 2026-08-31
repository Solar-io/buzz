/**
 * Presence over kind-20001: each user publishes their own status ("online" /
 * "away" / "offline"); the relay keeps it in Redis and synthesizes snapshot
 * events for author-scoped subscriptions. Bare strings are the current wire
 * shape; the legacy JSON form ({"status":"online"}) still arrives from older
 * publishers.
 */

import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

export const PRESENCE_KIND = 20001;

export type PresenceStatus = "online" | "away" | "offline" | "unknown";

export interface PresenceEntry {
  pubkey: string;
  status: PresenceStatus;
  updatedAt: number;
}

export function statusFromContent(content: string): PresenceStatus {
  let raw = content.trim();
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { status?: unknown };
      if (typeof parsed.status === "string") {
        raw = parsed.status;
      }
    } catch {
      // Malformed JSON → unknown below.
    }
  }
  if (raw === "online" || raw === "away" || raw === "offline") {
    return raw;
  }
  return "unknown";
}

export function presenceFromEvent(
  event: SignedNostrEvent,
): PresenceEntry | null {
  if (event.kind !== PRESENCE_KIND) {
    return null;
  }
  return {
    pubkey: event.pubkey,
    status: statusFromContent(event.content),
    updatedAt: event.created_at,
  };
}

/** Latest event per author wins. */
export function mergePresence(
  current: Map<string, PresenceEntry>,
  entry: PresenceEntry,
): Map<string, PresenceEntry> {
  const existing = current.get(entry.pubkey);
  if (existing && existing.updatedAt >= entry.updatedAt) {
    return current;
  }
  const next = new Map(current);
  next.set(entry.pubkey, entry);
  return next;
}

/** Sidebar dot color class for a status. */
export function presenceDotClass(status: PresenceStatus): string {
  switch (status) {
    case "online":
      return "bg-emerald-500";
    case "away":
      return "bg-amber-400";
    default:
      return "bg-muted-foreground/40";
  }
}
