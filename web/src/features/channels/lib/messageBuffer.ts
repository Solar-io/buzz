import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

/** Kinds that render in a channel timeline (mirrors the CLI list filter). */
export const TIMELINE_KINDS = [9, 40002, 40008, 45001, 45003] as const;

export interface TimelineMessage {
  id: string;
  channelId: string;
  authorPubkey: string;
  createdAt: number;
  content: string;
  kind: number;
  /** NIP-10 thread root event id, when this message is a reply. */
  rootId: string | null;
  /** Immediate parent event id, when this message is a reply. */
  replyToId: string | null;
  /** Mentioned pubkeys from p tags. */
  mentionPubkeys: string[];
}

export function timelineMessageFromEvent(
  event: SignedNostrEvent,
): TimelineMessage | null {
  const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
  if (!channelId) {
    return null;
  }
  // NIP-10: last e tag wins for positional parsing, but Buzz emits marker
  // tags — prefer explicit root/reply markers, fall back to the single e.
  let rootId: string | null = null;
  let replyToId: string | null = null;
  for (const tag of event.tags) {
    if (tag[0] !== "e" || typeof tag[1] !== "string") {
      continue;
    }
    const marker = tag[3];
    if (marker === "root") {
      rootId = tag[1];
    } else if (marker === "reply") {
      replyToId = tag[1];
    }
  }
  if (!rootId && !replyToId) {
    const single = event.tags.find((tag) => tag[0] === "e")?.[1];
    if (single) {
      replyToId = single;
    }
  }

  return {
    id: event.id,
    channelId,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    content: event.content,
    kind: event.kind,
    rootId,
    replyToId,
    mentionPubkeys: event.tags
      .filter((tag) => tag[0] === "p" && typeof tag[1] === "string")
      .map((tag) => tag[1]),
  };
}

export type MessageBuffer = TimelineMessage[];

/**
 * Insert into the timeline with id-dedupe, keeping chronological order and a
 * rolling cap. Returns the same array reference when nothing changed so React
 * state updates are no-ops for duplicates and stale (older-than-buffer)
 * events.
 */
export function upsertMessage(
  buffer: MessageBuffer,
  message: TimelineMessage,
  cap = 500,
): MessageBuffer {
  const existingIndex = buffer.findIndex((m) => m.id === message.id);
  if (existingIndex !== -1) {
    if (buffer[existingIndex] === message) {
      return buffer;
    }
    const next = buffer.slice();
    next[existingIndex] = message;
    return next;
  }
  const next = buffer.concat(message).sort((a, b) => a.createdAt - b.createdAt);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Replies of a root message, in order. */
export function threadReplies(
  buffer: MessageBuffer,
  rootId: string,
): TimelineMessage[] {
  return buffer.filter(
    (m) => m.rootId === rootId || (m.rootId === null && m.replyToId === rootId),
  );
}

/** Count of replies per root id — cheap sidebar/thread badges. */
export function replyCounts(buffer: MessageBuffer): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of buffer) {
    const root =
      message.rootId ?? (message.replyToId ? message.replyToId : null);
    if (root) {
      counts.set(root, (counts.get(root) ?? 0) + 1);
    }
  }
  return counts;
}
