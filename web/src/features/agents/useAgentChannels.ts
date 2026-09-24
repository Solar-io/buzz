import { useEffect, useMemo, useRef, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  type ChannelSummary,
  useChannels,
} from "@/features/channels/useChannels";
import { memberChannelIds } from "./lib/agentChannels.ts";

/**
 * The viewer-visible channels split by whether `agentPubkey` is a member.
 * Reads kind-39002 member snapshots with `#d` = every visible channel id —
 * the same read `useChannelMembers` does, widened to many channels. `#p` is
 * deliberately NOT used: relay-built 39002 rows are inserted directly and
 * whether their mentions are indexed is unverified. The live subscription
 * moves a channel into `member` as soon as a new snapshot lands.
 */
export function useAgentChannels(agentPubkey: string): {
  member: ChannelSummary[];
  others: ChannelSummary[];
} {
  const { session } = useRelaySession();
  const { channels } = useChannels();
  const eventsRef = useRef(new Map<string, SignedNostrEvent>());
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());

  const idsKey = useMemo(
    () =>
      channels
        .map((channel) => channel.id)
        .sort()
        .join(","),
    [channels],
  );

  useEffect(() => {
    eventsRef.current = new Map();
    setMemberIds(new Set());
    const ids = idsKey ? idsKey.split(",") : [];
    if (ids.length === 0) {
      return;
    }
    return session.subscribe(
      { kinds: [39002], "#d": ids, limit: 500 },
      {
        onEvent: (event: SignedNostrEvent) => {
          eventsRef.current.set(event.id, event);
          setMemberIds(
            memberChannelIds([...eventsRef.current.values()], agentPubkey),
          );
        },
      },
    );
  }, [session, idsKey, agentPubkey]);

  return useMemo(() => {
    const member: ChannelSummary[] = [];
    const others: ChannelSummary[] = [];
    for (const channel of channels) {
      if (memberIds.has(channel.id)) {
        member.push(channel);
      } else if (!channel.archived && channel.type !== "dm") {
        others.push(channel);
      }
    }
    const byName = (a: ChannelSummary, b: ChannelSummary) =>
      a.name.localeCompare(b.name);
    return { member: member.sort(byName), others: others.sort(byName) };
  }, [channels, memberIds]);
}
