/**
 * The context the detail pane shows around a selected inbox row: enough of
 * the surrounding conversation to act on it without leaving the inbox.
 *
 * The buffer this reads is the live channel timeline
 * (`useChannelMessages`), so the detail pane is not a second message store —
 * it is a view over the same one the channel view uses.
 */

import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import type { InboxItem } from "./inboxItem.ts";

/** Messages either side of the selection in a DM, and after it in a thread. */
export const INBOX_CONTEXT_LIMIT = 30;

/** The thread root a channel item hangs from. */
export function inboxThreadRootId(item: InboxItem): string {
  const message = item.message;
  return message.rootId ?? message.replyToId ?? message.id;
}

function belongsToThread(message: TimelineMessage, rootId: string): boolean {
  return (
    message.id === rootId ||
    message.rootId === rootId ||
    (message.rootId === null && message.replyToId === rootId)
  );
}

/**
 * Context messages for one inbox row, oldest first.
 *
 * - DM: the tail of the DM channel, because in a DM the conversation IS the
 *   channel and a NIP-10 root would slice it arbitrarily.
 * - Channel: the thread root plus its replies.
 *
 * Falls back to the item's own messages when the live buffer has not arrived
 * (or the root is older than the loaded page), so the pane always renders the
 * message the row promised rather than an empty panel.
 */
export function inboxThreadContext(
  item: InboxItem,
  buffer: readonly TimelineMessage[],
  limit = INBOX_CONTEXT_LIMIT,
): TimelineMessage[] {
  const inChannel = buffer.filter(
    (message) => message.channelId === item.channelId && !message.deleted,
  );
  const selected =
    item.channelType === "dm"
      ? inChannel
      : inChannel.filter((message) =>
          belongsToThread(message, inboxThreadRootId(item)),
        );

  const byId = new Map<string, TimelineMessage>();
  for (const message of selected.slice(-limit)) {
    byId.set(message.id, message);
  }
  // The row's own messages are guaranteed present even before the channel
  // subscription replays — this is what makes the pane render immediately.
  for (const message of item.messages) {
    if (!message.deleted && !byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }
  return Array.from(byId.values()).sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}

/**
 * Whether a context row should render grouped (no avatar/name header) under
 * the row above it: same author, within five minutes. Same rule as the
 * channel timeline's grouping.
 */
export const INBOX_GROUPING_WINDOW_SECONDS = 5 * 60;

export function inboxContextGrouped(
  message: TimelineMessage,
  previous: TimelineMessage | undefined,
): boolean {
  if (!previous) {
    return false;
  }
  return (
    previous.authorPubkey === message.authorPubkey &&
    message.createdAt - previous.createdAt < INBOX_GROUPING_WINDOW_SECONDS
  );
}
