import { useMemo } from "react";
import type { RelaySession } from "@/shared/api/relay-session";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import type { ChannelSummary } from "@/features/channels/lib/channelFromEvent.ts";
import type { ChannelActivityMap } from "@/features/channels/lib/channelActivity.ts";
import { type DmSummary, dmSummaries } from "./lib/dmActivity.ts";
import { extractOpenDmChannelId } from "./lib/dmInput.ts";

export type { DmSummary } from "./lib/dmActivity.ts";

/**
 * Split the channel list into DMs (relay `t` tag) with activity ordering.
 *
 * A pure selector over the conversation-activity store's samples
 * (features/activity): DMs ride the same subscription family as every other
 * conversation, so the row, its pill and its toast can never read different
 * feeds again (LEFT_NAV_ARCHITECTURE_REVIEW.md, phase 1 — this hook used to
 * own a twin per-DM sampler).
 */
export function useDms(
  channels: ChannelSummary[],
  activity: ChannelActivityMap,
): {
  dms: DmSummary[];
  channelsWithoutDms: ChannelSummary[];
} {
  const dms = useMemo(
    () => dmSummaries(channels, activity),
    [channels, activity],
  );
  const channelsWithoutDms = useMemo(
    () => channels.filter((c) => c.type !== "dm"),
    [channels],
  );
  return { dms, channelsWithoutDms };
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
