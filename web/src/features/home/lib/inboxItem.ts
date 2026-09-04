/**
 * Inbox items: the rows of the home screen.
 *
 * An item is a CONVERSATION, not a message — a thread the viewer was pulled
 * into, or a DM. Several messages collapse into one row so that ten replies
 * under one mention do not bury nine other conversations, which is the same
 * grouping the desktop client does (`desktop/src/features/home/lib/inbox.ts`,
 * `buildInboxItems`). The representative message shown on the row is the
 * OLDEST UNREAD one when there is one, so opening the row lands where the
 * viewer stopped reading rather than at the end.
 *
 * Everything here is pure: read state arrives as an injected predicate so the
 * derivation can be tested without localStorage or a relay.
 */

import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";

/** Why this conversation is in the inbox. */
export type InboxCategory = "mention" | "dm";

/** Channel kinds the inbox can label. Mirrors `ChannelSummary["type"]`. */
export type InboxChannelType = "stream" | "forum" | "dm";

/** The bits of a channel the inbox needs; `ChannelSummary` satisfies it. */
export interface InboxChannelInfo {
  id: string;
  name: string;
  type: InboxChannelType;
}

export interface InboxItem {
  /**
   * Stable conversation identity. For a channel thread it is the NIP-10 root
   * (so a new reply does not move the row to a new key); for a DM it is the
   * DM channel itself, because every message in a DM is the same conversation.
   */
  conversationId: string;
  channelId: string;
  channelName: string;
  channelType: InboxChannelType;
  /** "dm" first when both apply — a mention inside a DM is still a DM row. */
  categories: InboxCategory[];
  /** Oldest unread message, or the newest one when everything is read. */
  message: TimelineMessage;
  /** Every inbox-eligible message in this conversation, oldest first. */
  messages: TimelineMessage[];
  /** Newest activity in the conversation — the sort key. */
  latestActivityAt: number;
  unreadCount: number;
}

/** Predicate deciding whether one message has already been read. */
export type InboxReadPredicate = (message: TimelineMessage) => boolean;

/**
 * Conversation key for one message.
 *
 * DMs collapse to the channel. Channel messages use the NIP-10 root, then the
 * immediate parent, then the message's own id (a top-level mention is the root
 * of its own thread).
 */
export function inboxConversationId(
  message: Pick<TimelineMessage, "id" | "channelId" | "rootId" | "replyToId">,
  channelType: InboxChannelType,
): string {
  if (channelType === "dm") {
    return `dm:${message.channelId}`;
  }
  return message.rootId ?? message.replyToId ?? message.id;
}

/**
 * Why this message reached the inbox. Empty means it should not have: the
 * caller filters those out rather than showing an unexplained row.
 */
export function inboxCategories(
  message: Pick<TimelineMessage, "mentionPubkeys">,
  channelType: InboxChannelType,
  selfPubkey: string,
): InboxCategory[] {
  const categories: InboxCategory[] = [];
  if (channelType === "dm") {
    categories.push("dm");
  }
  if (message.mentionPubkeys.includes(selfPubkey)) {
    categories.push("mention");
  }
  return categories;
}

/** The label a row shows for where the conversation lives. */
export function inboxItemChannelLabel(item: InboxItem): string {
  return item.channelType === "dm" ? item.channelName : `#${item.channelName}`;
}

interface Draft {
  conversationId: string;
  channel: InboxChannelInfo;
  categories: Set<InboxCategory>;
  messages: TimelineMessage[];
}

function resolveChannel(
  channelId: string,
  channels: ReadonlyMap<string, InboxChannelInfo>,
): InboxChannelInfo {
  return (
    channels.get(channelId) ?? {
      id: channelId,
      // An unknown channel is still worth showing — the message is real and
      // addressed to the viewer. Naming it by id beats dropping it silently.
      name: channelId,
      type: "stream",
    }
  );
}

/**
 * Fold raw inbox-eligible messages into conversation rows, newest first.
 *
 * Dropped: the viewer's own messages (an inbox of your own posts is noise),
 * deleted messages, and anything that is neither a DM nor a mention of the
 * viewer — the relay filters carry both conditions, but a `#h` DM filter also
 * returns other people's chatter in a DM the viewer is in, which IS inbox
 * material, and the same filter returns the viewer's own sends, which is not.
 */
export function buildInboxItems(options: {
  messages: readonly TimelineMessage[];
  channels: readonly InboxChannelInfo[];
  selfPubkey: string | null;
  isRead: InboxReadPredicate;
}): InboxItem[] {
  const { messages, channels, selfPubkey, isRead } = options;
  if (!selfPubkey) {
    return [];
  }
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const drafts = new Map<string, Draft>();
  const seenMessageIds = new Set<string>();

  for (const message of messages) {
    if (seenMessageIds.has(message.id)) {
      continue;
    }
    seenMessageIds.add(message.id);
    if (message.deleted || message.authorPubkey === selfPubkey) {
      continue;
    }
    const channel = resolveChannel(message.channelId, channelById);
    const categories = inboxCategories(message, channel.type, selfPubkey);
    if (categories.length === 0) {
      continue;
    }
    const conversationId = inboxConversationId(message, channel.type);
    const draft = drafts.get(conversationId) ?? {
      conversationId,
      channel,
      categories: new Set<InboxCategory>(),
      messages: [],
    };
    for (const category of categories) {
      draft.categories.add(category);
    }
    draft.messages.push(message);
    drafts.set(conversationId, draft);
  }

  const items: InboxItem[] = [];
  for (const draft of drafts.values()) {
    const ordered = draft.messages
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const unread = ordered.filter((message) => !isRead(message));
    const representative = unread[0] ?? ordered[ordered.length - 1];
    items.push({
      conversationId: draft.conversationId,
      channelId: draft.channel.id,
      channelName: draft.channel.name,
      channelType: draft.channel.type,
      categories: (["dm", "mention"] as const).filter((category) =>
        draft.categories.has(category),
      ),
      message: representative,
      messages: ordered,
      latestActivityAt: ordered[ordered.length - 1].createdAt,
      unreadCount: unread.length,
    });
  }

  // Newest conversation first; the id tiebreak keeps same-second rows stable
  // across renders so React keys do not shuffle.
  return items.sort(
    (a, b) =>
      b.latestActivityAt - a.latestActivityAt ||
      a.conversationId.localeCompare(b.conversationId),
  );
}

/** Total unread messages across every row — the sidebar badge. */
export function inboxUnreadTotal(items: readonly InboxItem[]): number {
  return items.reduce((total, item) => total + item.unreadCount, 0);
}
