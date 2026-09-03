import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { imetaByUrl, type ImetaEntry } from "./imetaEntries.ts";
import { linkPreviewsFromTags, type LinkPreview } from "./linkPreview.ts";
import { SYSTEM_MESSAGE_KIND } from "./systemEvent.ts";

/**
 * Kinds that render their own row in a channel timeline.
 *
 * 40099 is a system row, not a message row: joins, leaves and — the one that
 * matters — moderation tombstones. It renders through SystemMessageRow, never
 * through the message row, so any consumer of this list that assumes
 * message-shaped content must exclude it (see MESSAGE_SEARCH_KINDS below).
 */
export const TIMELINE_KINDS = [
  9,
  40002,
  40008,
  SYSTEM_MESSAGE_KIND,
  45001,
  45003,
] as const;

/**
 * Timeline kinds whose content is human prose, for NIP-50 full-text search.
 * 40099 is excluded on purpose: its body is a JSON payload, so including it
 * would surface `{"type":"member_joined",...}` blobs as search hits.
 */
export const MESSAGE_SEARCH_KINDS = TIMELINE_KINDS.filter(
  (kind) => kind !== SYSTEM_MESSAGE_KIND,
);
/** Kind 40003: an edit overlay for an existing message (e tag = target). */
export const EDIT_KIND = 40003;
/** Kind 5: NIP-09 deletion request (e tag = target; h keeps it channel-scoped). */
export const DELETE_KIND = 5;

/** Reference-stable empty map — messages without imeta tags share it. */
const EMPTY_IMETA: Map<string, ImetaEntry> = new Map();
const EMPTY_PREVIEWS: LinkPreview[] = [];

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
  /**
   * NIP-92 attachment metadata (url → entry), read at parse time. Snapshot
   * cards classify their links through this map. A construction-time
   * constant: edits replace content only and never mutate it (overlays copy
   * the field by reference — pinned by the buffer suite).
   */
  imetaByUrl: Map<string, ImetaEntry>;
  /**
   * Sender-authored link previews, from the event's own tags. Rendering these
   * contacts no third-party site — the sender resolved the page, so opening a
   * channel does not fan out requests to every domain anyone has linked.
   * A construction-time constant, like imetaByUrl: edits replace content only.
   */
  linkPreviews: LinkPreview[];
  /** Edit overlay present (renders the "(edited)" marker). */
  edited: boolean;
  /** Deleted via kind 5 — rows hide rather than render. */
  deleted: boolean;
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

  const attachments = event.tags.some((tag) => tag[0] === "imeta")
    ? imetaByUrl(event.tags)
    : EMPTY_IMETA;
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
    imetaByUrl: attachments,
    linkPreviews: event.tags.some((tag) => tag[0] === "link-preview")
      ? linkPreviewsFromTags(event.tags).previews
      : EMPTY_PREVIEWS,
    edited: false,
    deleted: false,
  };
}

/** Target id from the first e tag of an edit (40003) or delete (5) event. */
export function editTargetFromEvent(event: SignedNostrEvent): string | null {
  if (event.kind !== EDIT_KIND && event.kind !== DELETE_KIND) {
    return null;
  }
  const target = event.tags.find((tag) => tag[0] === "e")?.[1];
  return target ?? null;
}

/**
 * Apply an edit/delete overlay event to the buffer. Edits replace the target's
 * content (the relay validated ownership at ingest) and mark it edited;
 * deletes hide the row. Returns the same reference when nothing matched.
 */
export function applyOverlay(
  buffer: MessageBuffer,
  kind: number,
  targetId: string,
  newContent: string | null,
): MessageBuffer {
  // An edit without content (or an already-deleted target) changes nothing —
  // return the same reference so React state updates are no-ops.
  if (kind === EDIT_KIND && newContent === null) {
    return buffer;
  }
  const index = buffer.findIndex((m) => m.id === targetId);
  if (index === -1) {
    return buffer;
  }
  const next = buffer.slice();
  const message = { ...next[index] };
  if (kind === EDIT_KIND) {
    message.content = newContent ?? message.content;
    message.edited = true;
  } else if (kind === DELETE_KIND) {
    message.deleted = true;
  }
  next[index] = message;
  return next;
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
