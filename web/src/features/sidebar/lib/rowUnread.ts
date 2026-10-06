import {
  type ChannelActivityMap,
  type ChannelUnreadCounts,
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
  /**
   * The conversation-activity store's live counts (I4). Once a window has
   * derived a count, the row is unread exactly when that count is above 0 —
   * the newest sample is only the fallback before then. Keying on the sample
   * hid a still-unread message the moment the viewer's own newer message
   * (sent from another device) became the sample (QA #12b).
   */
  unreadCounts?: ChannelUnreadCounts;
}

/** The store's count verdict, or null when no window has derived one yet. */
function countVerdict(
  input: Pick<RowUnreadInput, "unreadCounts">,
  id: string,
): boolean | null {
  const count = input.unreadCounts?.get(id);
  return count === undefined ? null : count > 0;
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
  if (isMuted(input.prefs, channel.id)) {
    return false;
  }
  const counted = countVerdict(input, channel.id);
  if (counted !== null) {
    return counted;
  }
  return isChannelRowUnread({
    read: input.read,
    channelId: channel.id,
    updatedAt: channel.updatedAt,
    activity: input.activity.get(channel.id),
    selfPubkey: input.selfPubkey,
  });
}

/**
 * DM rows: the newest sampled message vs the marker. Own messages (e.g. sent
 * from another device) never dot your row — parity with channel rows, whose
 * signal ignores self-authored activity. Muted DMs never read as unread,
 * exactly like muted channels (left-nav QA #6).
 */
export function dmRowUnread(
  dm: DmSummary,
  input: Pick<RowUnreadInput, "read" | "selfPubkey" | "prefs" | "unreadCounts">,
): boolean {
  const { channel, lastMessage } = dm;
  if (isMuted(input.prefs, channel.id)) {
    return false;
  }
  const counted = countVerdict(input, channel.id);
  if (counted !== null) {
    return counted;
  }
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
