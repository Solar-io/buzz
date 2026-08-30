import { useEffect, useMemo, useState } from "react";
import type { RelaySession } from "@/shared/api/relay-session";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import type { ChannelSummary } from "@/features/channels/lib/channelFromEvent.ts";
import { dmActivityFromEvents, type DmLastMessage } from "./lib/dmActivity.ts";
import { extractOpenDmChannelId } from "./lib/dmInput.ts";

export interface DmSummary {
  channel: ChannelSummary;
  /** Last kind:9 timestamp seen for this DM (0 = never sampled). */
  lastActivity: number;
  /** Newest sampled message (author + excerpt) for the sidebar preview row. */
  lastMessage: DmLastMessage | null;
}

/**
 * Split the channel list into DMs (relay `t` tag) with activity ordering.
 * One subscription's worth of recency (see useDmActivity) drives the sort;
 * channels with no sampled activity fall back to metadata recency.
 */
export function useDms(channels: ChannelSummary[]): {
  dms: DmSummary[];
  channelsWithoutDms: ChannelSummary[];
} {
  const dmIds = useMemo(
    () => channels.filter((c) => c.type === "dm").map((c) => c.id),
    [channels],
  );
  const activity = useDmActivity(dmIds);
  const dms = useMemo(() => {
    const list = channels
      .filter((c) => c.type === "dm")
      .map((channel) => ({
        channel,
        lastActivity: activity.get(channel.id)?.created_at ?? 0,
        lastMessage: activity.get(channel.id) ?? null,
      }));
    list.sort(
      (a, b) =>
        Math.max(b.lastActivity, b.channel.updatedAt) -
          Math.max(a.lastActivity, a.channel.updatedAt) ||
        a.channel.name.localeCompare(b.channel.name),
    );
    return list;
  }, [channels, activity]);
  const channelsWithoutDms = useMemo(
    () => channels.filter((c) => c.type !== "dm"),
    [channels],
  );
  return { dms, channelsWithoutDms };
}

/**
 * Recency sample across every known DM: ONE kind:9 subscription with an
 * #h filter over all DM ids. Resubscribes only when the DM id SET changes
 * (joined key), so a growing DM list stays cheap.
 */
function useDmActivity(dmIds: string[]): Map<string, DmLastMessage> {
  const { session } = useRelaySession();
  const [events, setEvents] = useState<SignedNostrEvent[]>([]);
  // Pubkeys are comma-free, so the join is a lossless set key.
  const idsKey = useMemo(
    () => Array.from(new Set(dmIds)).sort().join(","),
    [dmIds],
  );
  useEffect(() => {
    const ids = idsKey ? idsKey.split(",") : [];
    if (ids.length === 0) {
      setEvents([]);
      return;
    }
    setEvents([]);
    return session.subscribe(
      { kinds: [9], "#h": ids, limit: 100 },
      {
        onEvent: (event) => {
          setEvents((previous) => [...previous, event]);
        },
      },
    );
  }, [session, idsKey]);
  return useMemo(() => dmActivityFromEvents(events), [events]);
}

export interface OpenDmResult {
  ok: boolean;
  /** Relay-derived channel id; null when the relay accepted but named nothing. */
  channelId: string | null;
  message: string;
}

/**
 * Open (or re-open — this also un-hides) a DM: sign kind 41010 with one p
 * tag per other participant, no d tag (buzz-sdk build_dm_open shape; the
 * relay derives the channel id from the participant set and returns it in
 * the OK message).
 */
export async function openDm(
  session: RelaySession,
  otherPubkeys: string[],
): Promise<OpenDmResult> {
  const event = await signNostrEvent({
    kind: 41010,
    tags: otherPubkeys.map((pubkey) => ["p", pubkey]),
    content: "",
  });
  const result = await session.publish(event);
  return {
    ok: result.ok,
    channelId: result.ok ? extractOpenDmChannelId(result.message) : null,
    message: result.message,
  };
}
