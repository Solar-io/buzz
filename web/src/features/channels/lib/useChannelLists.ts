import { useMemo } from "react";
import type { ChannelPrefs } from "@/features/channels/lib/channelPrefs.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { DmSummary } from "@/features/dms/hooks";
import type { HuddleLink } from "@/features/huddle/lib/huddleRegistry.ts";

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
  /** kind-48100 registry: only linked huddle rooms are joinable. */
  huddleLinks: Map<string, HuddleLink>;
}

/** The sidebar's sections, filtered and sorted. */
export interface ChannelLists {
  /** Starred channels, ahead of the main list. */
  starred: ChannelSummary[];
  /** Everything else in the Channels section. */
  unstarred: ChannelSummary[];
  /** Forum-type channels — their own section and their own body. */
  forums: ChannelSummary[];
  /** Ephemeral huddle rooms with a live kind-48100 link, newest first. */
  huddles: ChannelSummary[];
  /** DMs the viewer has not hidden locally. */
  visibleDms: DmSummary[];
}

/**
 * Section the raw channel list the way the sidebar renders it.
 *
 * Archived channels (expired huddles etc.) hide from the sidebar — the
 * relay's `archived` tag exists for exactly this. Ephemeral (ttl) channels
 * are huddle backing rooms: grouped apart, newest first, not mixed into
 * the main channel list. Forum-type channels split into their own sidebar
 * section (and their own channel body); streams keep the Channels list.
 */
export function useChannelLists({
  channels,
  dms,
  channelPrefs,
  hiddenDmIds,
  huddleLinks,
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
  const huddleChannels = useMemo(
    () =>
      channels
        .filter((channel) => !channel.archived && channel.ttlSeconds !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [channels],
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
  // Huddle registry: kind-48100 links parent channels to their ephemeral
  // voice rooms; only linked rooms are joinable (the audio relay verifies
  // the link), so the Huddles section keys off the registry, not bare ttl.
  const huddles = useMemo(
    () => huddleChannels.filter((channel) => huddleLinks.has(channel.id)),
    [huddleChannels, huddleLinks],
  );
  const visibleDms = useMemo(
    () => dms.filter(({ channel }) => !hiddenDmIds.includes(channel.id)),
    [dms, hiddenDmIds],
  );
  return { starred, unstarred, forums, huddles, visibleDms };
}
