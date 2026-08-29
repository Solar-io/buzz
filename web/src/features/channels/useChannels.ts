import { useEffect, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  type ChannelSummary,
  channelFromEvent,
} from "./lib/channelFromEvent.ts";

export type { ChannelSummary };

/**
 * Live channel list: subscribes to kind 39000 metadata; later events win so
 * renames appear without a reload. Replays automatically after reconnects
 * (the session owns that).
 */
export function useChannels(): {
  channels: ChannelSummary[];
  connected: boolean;
} {
  const { session, status } = useRelaySession();
  const [channels, setChannels] = useState<ChannelSummary[]>([]);

  useEffect(() => {
    const apply = (event: SignedNostrEvent) => {
      const channel = channelFromEvent(event);
      if (!channel) {
        return;
      }
      setChannels((previous) => {
        const existing = previous.find((c) => c.id === channel.id);
        if (existing && existing.updatedAt >= channel.updatedAt) {
          return previous;
        }
        const next = existing
          ? previous.map((c) => (c.id === channel.id ? channel : c))
          : [...previous, channel];
        return next.sort((a, b) => a.name.localeCompare(b.name));
      });
    };

    return session.subscribe(
      { kinds: [39000], limit: 500 },
      {
        onEvent: apply,
      },
    );
  }, [session]);

  return { channels, connected: status === "open" };
}
