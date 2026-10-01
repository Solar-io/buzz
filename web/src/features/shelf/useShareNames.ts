import { useMemo } from "react";

import { useProfiles } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import { dmDisplayName } from "@/features/dms/lib/dmNaming.ts";
import { useWorkContext } from "@/features/work/workContext.ts";

/**
 * Names for the Shelf and the file pane: people by profile, conversations as
 * `#flight-path` or `DM Gilfoyle` (the Shelf artboard's "Shared in" column).
 * Reads the shell's channel list from the Work context, so neither surface
 * needs it passed down.
 */
export function useShareNames(pubkeys: readonly string[]): {
  person: (pubkey: string) => string;
  channel: (channelId: string) => string;
  isAgent: (pubkey: string) => boolean;
  selfPubkey: string | null;
} {
  const work = useWorkContext();
  const channels = work?.channels;
  const selfPubkey = work?.selfPubkey ?? null;
  const agents = work?.agentPubkeys;
  const wanted = useMemo(() => {
    const set = new Set(pubkeys);
    for (const channel of channels ?? []) {
      if (channel.type === "dm") {
        for (const pubkey of channel.participantPubkeys) {
          set.add(pubkey);
        }
      }
    }
    return [...set].sort();
  }, [pubkeys, channels]);
  const profiles = useProfiles(wanted);
  return useMemo(() => {
    const byId = new Map(
      (channels ?? []).map((channel) => [channel.id, channel]),
    );
    return {
      person: (pubkey: string) => authorLabel(pubkey, profiles),
      channel: (channelId: string) => {
        const channel = byId.get(channelId);
        if (!channel) {
          return "a conversation";
        }
        if (channel.type === "dm") {
          return `DM ${dmDisplayName(channel.participantPubkeys, selfPubkey ?? "", profiles)}`;
        }
        return `#${channel.name}`;
      },
      isAgent: (pubkey: string) =>
        agents?.has(pubkey) === true ||
        agents?.has(pubkey.toLowerCase()) === true,
      selfPubkey,
    };
  }, [channels, profiles, selfPubkey, agents]);
}
