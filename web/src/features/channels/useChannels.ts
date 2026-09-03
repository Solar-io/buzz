import { useCallback, useEffect, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import { loadSeed, mergeSeed } from "@/shared/lib/localSeed.ts";
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
const CHANNEL_SEED_KEY = "channels:v1";

export function useChannels(): {
  channels: ChannelSummary[];
  connected: boolean;
  /** Re-REQ the channel list — the relay has no live 39000 fan-out, so a
   *  freshly created channel only appears via a new historical replay. */
  refresh: () => void;
} {
  const { session, status } = useRelaySession();
  const [channels, setChannels] = useState<ChannelSummary[]>(() => {
    const seed = new Map<string, ChannelSummary>();
    for (const value of Object.values(loadSeed(CHANNEL_SEED_KEY))) {
      if (
        value &&
        typeof value === "object" &&
        typeof (value as ChannelSummary).id === "string"
      ) {
        seed.set((value as ChannelSummary).id, value as ChannelSummary);
      }
    }
    return Array.from(seed.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  });
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

  // Write-through so the next reload paints the channel list immediately.
  useEffect(() => {
    if (channels.length === 0) {
      return;
    }
    const timer = setTimeout(() => {
      mergeSeed(
        CHANNEL_SEED_KEY,
        Object.fromEntries(channels.map((c) => [c.id, c])),
      );
    }, 1_000);
    return () => clearTimeout(timer);
  }, [channels]);

  return { channels, connected: status === "open", refresh };
}
