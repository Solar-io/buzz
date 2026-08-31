import { useCallback, useEffect, useState } from "react";
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
  /** Re-REQ the channel list — the relay has no live 39000 fan-out, so a
   *  freshly created channel only appears via a new historical replay. */
  refresh: () => void;
} {
  const { session, status } = useRelaySession();
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the re-REQ trigger by design
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
  }, [session, refreshKey]);

  return { channels, connected: status === "open", refresh };
}
