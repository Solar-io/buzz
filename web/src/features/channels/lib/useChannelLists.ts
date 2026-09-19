import { useMemo } from "react";
import type { ChannelPrefs } from "@/features/channels/lib/channelPrefs.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { DmSummary } from "@/features/dms/hooks";

/** Everything {@link useChannelLists} sections the sidebar from. */
export interface ChannelListsInput {
  /** Every non-DM channel the viewer can see, unfiltered. */
  channels: ChannelSummary[];
  /** Every DM, newest activity first. */
  dms: DmSummary[];
  /** Viewer's starred / muted prefs. */
  channelPrefs: ChannelPrefs;
  /** DM channel ids the viewer hid locally. */
  hiddenDmIds: string[];
}

/** The sidebar's sections, filtered and sorted. */
export interface ChannelLists {
  /** Starred channels, ahead of the main list. */
  starred: ChannelSummary[];
  /** Everything else in the Channels section. */
  unstarred: ChannelSummary[];
  /** Forum-type channels — their own section and their own body. */
  forums: ChannelSummary[];
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
  const visibleChannels = useMemo(
    () => permanentChannels.filter((channel) => channel.type !== "forum"),
    [permanentChannels],
  );
  const forums = useMemo(
    () => permanentChannels.filter((channel) => channel.type === "forum"),
    [permanentChannels],
  );
  const starred = useMemo(
    () =>
      visibleChannels.filter((channel) =>
        channelPrefs.starred.includes(channel.id),
      ),
    [visibleChannels, channelPrefs],
  );
  const unstarred = useMemo(
    () =>
      visibleChannels.filter(
        (channel) => !channelPrefs.starred.includes(channel.id),
      ),
    [visibleChannels, channelPrefs],
  );
  const visibleDms = useMemo(
    () => dms.filter(({ channel }) => !hiddenDmIds.includes(channel.id)),
    [dms, hiddenDmIds],
  );
  return { starred, unstarred, forums, visibleDms };
}
