import type { ChannelSummary } from "../../channels/lib/channelFromEvent.ts";
import type {
  ChannelActivity,
  ChannelActivityMap,
} from "../../channels/lib/channelActivity.ts";

/*
 * DM recency, derived from the conversation-activity store's samples
 * (features/activity). DMs used to run their own per-DM sampler here — a
 * twin of the toast feed with its own idea of "new" (left-nav review,
 * 2026-10-05); the store's handlers now carry its rules (kind-9 only,
 * newest-wins, a wake for someone else never becomes the sample).
 */

export interface DmLastMessage {
  channelId: string;
  /** Author pubkey of the newest sampled message. */
  authorPubkey: string;
  /** Plain-text excerpt of the newest sampled message content. */
  excerpt: string;
  created_at: number;
}

export interface DmRecencyRank {
  /** Newest sampled message time; 0 when the DM has never been messaged. */
  lastActivity: number;
  /** Channel metadata (39000) time — re-opens bump this without a message. */
  updatedAt: number;
  name: string;
}

/**
 * Most-recent-ACTIVITY ordering for the DM list. A real message beats a
 * metadata touch, so re-opening an old DM cannot float it over a
 * conversation that was actually messaged more recently; never-messaged
 * DMs fall back to their metadata (creation) time, ties break by name.
 */
export function compareDmRecency(a: DmRecencyRank, b: DmRecencyRank): number {
  return (
    (b.lastActivity || b.updatedAt) - (a.lastActivity || a.updatedAt) ||
    a.name.localeCompare(b.name)
  );
}

/** Sidebar preview length (the store keeps a longer one for toasts). */
const DM_EXCERPT_MAX = 80;

/** The DM row's view of one conversation-activity sample. */
export function dmLastMessage(sample: ChannelActivity): DmLastMessage {
  return {
    channelId: sample.channelId,
    authorPubkey: sample.pubkey,
    excerpt: sample.preview.slice(0, DM_EXCERPT_MAX),
    created_at: sample.createdAt,
  };
}

/** One DM, as the sidebar and the landing pick read it. */
export interface DmSummary {
  channel: ChannelSummary;
  /** Last kind:9 timestamp seen for this DM (0 = never sampled). */
  lastActivity: number;
  /** Newest sampled message (author + excerpt) for the sidebar preview row. */
  lastMessage: DmLastMessage | null;
}

/**
 * The DM channels in `channels`, newest activity first (Sam 2026-09-02:
 * "they should sort based on most recent activity"); a DM with no sample
 * falls back to its metadata time.
 */
export function dmSummaries(
  channels: readonly ChannelSummary[],
  activity: ChannelActivityMap,
): DmSummary[] {
  const list = channels
    .filter((channel) => channel.type === "dm")
    .map((channel) => {
      const sample = activity.get(channel.id);
      return {
        channel,
        lastActivity: sample?.createdAt ?? 0,
        lastMessage: sample ? dmLastMessage(sample) : null,
      };
    });
  list.sort((a, b) =>
    compareDmRecency(
      {
        lastActivity: a.lastActivity,
        updatedAt: a.channel.updatedAt,
        name: a.channel.name,
      },
      {
        lastActivity: b.lastActivity,
        updatedAt: b.channel.updatedAt,
        name: b.channel.name,
      },
    ),
  );
  return list;
}
