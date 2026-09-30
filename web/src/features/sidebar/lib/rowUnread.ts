import {
  type ChannelActivityMap,
  isChannelRowUnread,
} from "@/features/channels/lib/channelActivity.ts";
import {
  type ChannelPrefs,
  isMuted,
} from "@/features/channels/lib/channelPrefs.ts";
import { isUnread, type ReadState } from "@/features/channels/lib/readState.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { DmSummary } from "@/features/dms/hooks";

/**
 * Which sidebar rows read as unread — ONE definition, shared by the rows
 * themselves (ChannelSidebar) and the phone tab bar's Channels badge, so the
 * badge can never count a conversation the list does not mark.
 */
export interface RowUnreadInput {
  prefs: ChannelPrefs;
  read: ReadState;
  activity: ChannelActivityMap;
  selfPubkey: string | null;
}

/**
 * Channel / forum rows: read marker vs the newest sampled MESSAGE
 * (self-authored samples excluded — see channelUnreadSignal), falling back to
 * metadata for unsampled channels. Muted rows never read as unread.
 */
export function channelRowUnread(
  channel: ChannelSummary,
  input: RowUnreadInput,
): boolean {
  return (
    !isMuted(input.prefs, channel.id) &&
    isChannelRowUnread({
      read: input.read,
      channelId: channel.id,
      updatedAt: channel.updatedAt,
      activity: input.activity.get(channel.id),
      selfPubkey: input.selfPubkey,
    })
  );
}

/**
 * DM rows keep their own activity feed and stay on lastMessage logic. Own
 * messages (e.g. sent from another device) never dot your row — parity with
 * channel rows, whose signal ignores self-authored activity.
 */
export function dmRowUnread(
  dm: DmSummary,
  input: Pick<RowUnreadInput, "read" | "selfPubkey">,
): boolean {
  const { channel, lastMessage } = dm;
  return lastMessage && lastMessage.authorPubkey !== input.selfPubkey
    ? isUnread(input.read, channel.id, lastMessage.created_at)
    : false;
}

/** Conversations with something unread — the phone Channels tab's badge. */
export function unreadConversationCount(
  channels: readonly ChannelSummary[],
  dms: readonly DmSummary[],
  input: RowUnreadInput,
): number {
  return (
    channels.filter((channel) => channelRowUnread(channel, input)).length +
    dms.filter((dm) => dmRowUnread(dm, input)).length
  );
}
