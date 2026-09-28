import { useMemo } from "react";
import {
  favoriteChannelIds,
  type ChannelPrefs,
} from "@/features/channels/lib/channelPrefs.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { DmSummary } from "@/features/dms/hooks";

/** Everything {@link useChannelLists} sections the sidebar from. */
export interface ChannelListsInput {
  /** Every non-DM channel the viewer can see, unfiltered. */
  channels: ChannelSummary[];
  /** Every DM, newest activity first. */
  dms: DmSummary[];
  /** Viewer's favorites / muted prefs (landing-fallback order only). */
  channelPrefs: ChannelPrefs;
  /** DM channel ids the viewer hid locally. */
  hiddenDmIds: string[];
}

/**
 * The sidebar's source lists, filtered and sorted. Favorites are NOT split
 * out here — the sidebar does that (`sectionSidebar`), because Favorites
 * also holds Links, which the sidebar reads itself.
 */
export interface ChannelLists {
  /** Stream channels (the Channels section's candidates), by name. */
  streams: ChannelSummary[];
  /** Forum-type channels — their own section and their own body. */
  forums: ChannelSummary[];
  /** Non-DM landing fallback: favorited streams first, then the rest. */
  landingChannelIds: string[];
  /** DMs the viewer has not hidden locally. */
  visibleDms: DmSummary[];
}

/**
 * Section the raw channel list the way the sidebar renders it.
 *
 * Archived channels (expired transport rooms etc.) hide from the sidebar —
 * the relay's `archived` tag exists for exactly this. Ephemeral channels are
 * transport rooms and never enter the main channel list. Forum-type channels
 * split into their own sidebar section (and their own channel body); streams
 * keep the Channels list.
 */
export function useChannelLists({
  channels,
  dms,
  channelPrefs,
  hiddenDmIds,
}: ChannelListsInput): ChannelLists {
  const permanentChannels = useMemo(
    () =>
      channels
        .filter((channel) => !channel.archived && channel.ttlSeconds === null)
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, {
            sensitivity: "base",
          }),
        ),
    [channels],
  );
  const streams = useMemo(
    () => permanentChannels.filter((channel) => channel.type !== "forum"),
    [permanentChannels],
  );
  const forums = useMemo(
    () => permanentChannels.filter((channel) => channel.type === "forum"),
    [permanentChannels],
  );
  const landingChannelIds = useMemo(() => {
    const favorites = new Set(favoriteChannelIds(channelPrefs));
    const ids = streams.map((channel) => channel.id);
    return [
      ...ids.filter((id) => favorites.has(id)),
      ...ids.filter((id) => !favorites.has(id)),
    ];
  }, [streams, channelPrefs]);
  const visibleDms = useMemo(
    () => dms.filter(({ channel }) => !hiddenDmIds.includes(channel.id)),
    [dms, hiddenDmIds],
  );
  return { streams, forums, landingChannelIds, visibleDms };
}
