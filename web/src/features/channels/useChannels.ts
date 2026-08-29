import { useEffect, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";

export interface ChannelSummary {
  id: string;
  name: string;
  about: string;
  updatedAt: number;
}

/** NIP-29 group metadata (kind 39000): d tag = channel id, content = JSON. */
function channelFromEvent(event: SignedNostrEvent): ChannelSummary | null {
  const id = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (!id) {
    return null;
  }
  let name = "";
  let about = "";
  try {
    const parsed = JSON.parse(event.content) as {
      name?: unknown;
      about?: unknown;
    };
    if (typeof parsed.name === "string") {
      name = parsed.name;
    }
    if (typeof parsed.about === "string") {
      about = parsed.about;
    }
  } catch {
    // Non-JSON content: fall back to the id as the display name.
  }
  return {
    id,
    name: name || id,
    about,
    updatedAt: event.created_at,
  };
}

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
