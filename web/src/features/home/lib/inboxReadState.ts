/**
 * Whether an inbox message counts as read.
 *
 * ## Why this is not just `readState.ts`
 *
 * `features/channels/lib/readState.ts` holds ONE marker per channel — the
 * newest `created_at` the viewer has seen there — and `app/routes/repos.tsx`
 * advances it to the newest message the moment a channel is opened. That is
 * the right primitive for a sidebar dot, and it is the answer the inbox must
 * agree with: if you have opened #general and read to the bottom, the mention
 * that was in it is read, and the inbox must not claim otherwise.
 *
 * But one number per channel cannot express either of the two things an inbox
 * needs. Clearing ONE row must not mark the whole channel read (that would
 * swallow every other unread message in it), and marking a row unread again —
 * the "come back to this" gesture an inbox lives on — has nothing to write,
 * because the channel marker is already past it and moving it backwards would
 * resurrect unrelated messages.
 *
 * So this adds a per-MESSAGE overlay with BOTH directions, stored separately
 * so nothing here can corrupt the channel badges:
 *
 *     read  ⟺  ¬ explicitly-unread
 *              ∧ ( explicitly-read  ∨  createdAt ≤ channel marker )
 *
 * The channel marker remains the default answer; the overlay only records the
 * places the viewer has deliberately disagreed with it. The desktop client
 * has the same two-source shape (`isItemUnread` in
 * `desktop/src/features/home/lib/inbox.ts` takes a channel `readAt` and a
 * `getMessageReadAt` lookup); the explicit-unread half is the web's own.
 */

import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import type { ReadState } from "../../channels/lib/readState.ts";
import { isUnread } from "../../channels/lib/readState.ts";

const INBOX_READ_KEY = "buzz.inbox-read.v1";

/**
 * Cap on remembered markers per direction. The channel marker already covers
 * the common case; the overlay only has to remember deliberate disagreements,
 * so a few hundred is generous.
 */
export const INBOX_READ_MAX_ENTRIES = 500;

/** messageId → the message's `created_at`, used for pruning oldest-first. */
export type InboxReadMarkers = Record<string, number>;

export interface InboxReadState {
  /** Explicitly read, overriding a channel marker that has not reached it. */
  read: InboxReadMarkers;
  /** Explicitly unread, overriding a channel marker that has passed it. */
  unread: InboxReadMarkers;
}

export const EMPTY_INBOX_READ_STATE: InboxReadState = { read: {}, unread: {} };

function markerRecord(value: unknown): InboxReadMarkers {
  if (!value || typeof value !== "object") {
    return {};
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );
  return Object.fromEntries(entries);
}

export function loadInboxReadState(): InboxReadState {
  try {
    const raw = globalThis.localStorage?.getItem(INBOX_READ_KEY);
    if (!raw) {
      return EMPTY_INBOX_READ_STATE;
    }
    const parsed = JSON.parse(raw) as Partial<InboxReadState>;
    return {
      read: markerRecord(parsed?.read),
      unread: markerRecord(parsed?.unread),
    };
  } catch {
    return EMPTY_INBOX_READ_STATE;
  }
}

export function saveInboxReadState(state: InboxReadState): void {
  try {
    globalThis.localStorage?.setItem(INBOX_READ_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable — the overlay stays session-local, and the channel
    // marker still carries the common case.
  }
}

/** Keep the newest {@link INBOX_READ_MAX_ENTRIES} markers in one direction. */
export function pruneInboxMarkers(
  markers: InboxReadMarkers,
  max = INBOX_READ_MAX_ENTRIES,
): InboxReadMarkers {
  const entries = Object.entries(markers);
  if (entries.length <= max) {
    return markers;
  }
  entries.sort(([, left], [, right]) => right - left);
  return Object.fromEntries(entries.slice(0, max));
}

/**
 * Move messages between the two overlay directions.
 *
 * Setting one direction always clears the other — a message cannot be both —
 * and the result is the same reference when nothing changed, so a React state
 * update is a no-op.
 */
function setDirection(
  state: InboxReadState,
  messages: readonly Pick<TimelineMessage, "id" | "createdAt">[],
  direction: "read" | "unread",
): InboxReadState {
  const opposite = direction === "read" ? "unread" : "read";
  const changed = messages.filter(
    (message) =>
      !(message.id in state[direction]) || message.id in state[opposite],
  );
  if (changed.length === 0) {
    return state;
  }
  const target = { ...state[direction] };
  const other = { ...state[opposite] };
  for (const message of messages) {
    target[message.id] = message.createdAt;
    delete other[message.id];
  }
  const next = {
    read: direction === "read" ? pruneInboxMarkers(target) : other,
    unread: direction === "unread" ? pruneInboxMarkers(target) : other,
  };
  return next;
}

/** Record messages as read, clearing any explicit-unread marker on them. */
export function markInboxMessagesRead(
  state: InboxReadState,
  messages: readonly Pick<TimelineMessage, "id" | "createdAt">[],
): InboxReadState {
  return setDirection(state, messages, "read");
}

/**
 * Record messages as unread again — the "come back to this" gesture. This has
 * to be an explicit marker rather than a rewind of the channel marker, which
 * would drag unrelated messages back to unread with it.
 */
export function markInboxMessagesUnread(
  state: InboxReadState,
  messages: readonly Pick<TimelineMessage, "id" | "createdAt">[],
): InboxReadState {
  return setDirection(state, messages, "unread");
}

/**
 * The read question, answered from both sources. An explicit unread marker
 * wins over everything; otherwise an explicit read marker or the channel
 * marker will do.
 */
export function isInboxMessageRead(
  message: Pick<TimelineMessage, "id" | "channelId" | "createdAt">,
  channelRead: ReadState,
  inboxRead: InboxReadState,
): boolean {
  if (message.id in inboxRead.unread) {
    return false;
  }
  if (message.id in inboxRead.read) {
    return true;
  }
  return !isUnread(channelRead, message.channelId, message.createdAt);
}

/** Curried form, for `buildInboxItems`. */
export function inboxReadPredicate(
  channelRead: ReadState,
  inboxRead: InboxReadState,
): (
  message: Pick<TimelineMessage, "id" | "channelId" | "createdAt">,
) => boolean {
  return (message) => isInboxMessageRead(message, channelRead, inboxRead);
}
