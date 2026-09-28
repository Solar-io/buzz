import type {
  ChannelPrefs,
  FavoriteRef,
} from "@/features/channels/lib/channelPrefs.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { DmSummary } from "@/features/dms/hooks";
import type { ShortcutDef } from "@/features/shortcut-bar/lib/shortcutBlob.ts";

/**
 * One row of the sidebar's Favorites section. The kind decides which row the
 * sidebar renders — the same row the item gets in its home section.
 */
export type FavoriteItem =
  | { kind: "channel"; key: string; channel: ChannelSummary }
  | { kind: "forum"; key: string; channel: ChannelSummary }
  | { kind: "dm"; key: string; dm: DmSummary }
  | { kind: "link"; key: string; shortcut: ShortcutDef };

/** Everything the sidebar sections, before favorites are pulled out. */
export interface SidebarSectionInput {
  /** Visible stream channels, in their home-section order. */
  streams: readonly ChannelSummary[];
  /** Visible forum channels, in their home-section order. */
  forums: readonly ChannelSummary[];
  /** DMs the viewer has not hidden, newest activity first. */
  dms: readonly DmSummary[];
  /** The sidebar's Links. */
  shortcuts: readonly ShortcutDef[];
  favorites: ChannelPrefs["favorites"];
}

/** The sidebar's sections with favorited items moved into Favorites. */
export interface SidebarSections {
  /** In the order the favorites were added. */
  favorites: FavoriteItem[];
  channels: ChannelSummary[];
  forums: ChannelSummary[];
  dms: DmSummary[];
  links: ShortcutDef[];
}

/** The ref the Favorites toggle uses for a sidebar row. */
export function favoriteRefFor(item: FavoriteItem): FavoriteRef {
  return item.kind === "link"
    ? { kind: "link", id: item.shortcut.id }
    : { kind: "channel", id: item.key };
}

/**
 * Pull favorited items out of their home sections into Favorites.
 *
 * A favorite resolves only against what the sidebar would show anyway: a
 * favorited channel the viewer left, an archived one, a DM hidden with
 * "Remove from list" or a deleted link simply does not render (the ref is
 * kept, so it reappears if the item does). Every rendered favorite is
 * removed from its home section — nothing appears twice.
 */
export function sectionSidebar({
  streams,
  forums,
  dms,
  shortcuts,
  favorites,
}: SidebarSectionInput): SidebarSections {
  const streamById = new Map(streams.map((channel) => [channel.id, channel]));
  const forumById = new Map(forums.map((channel) => [channel.id, channel]));
  const dmById = new Map(dms.map((dm) => [dm.channel.id, dm]));
  const linkById = new Map(
    shortcuts.map((shortcut) => [shortcut.id, shortcut]),
  );

  const items: FavoriteItem[] = [];
  const favoriteChannels = new Set<string>();
  const favoriteLinks = new Set<string>();
  for (const ref of favorites) {
    if (ref.kind === "link") {
      const shortcut = linkById.get(ref.id);
      if (shortcut && !favoriteLinks.has(ref.id)) {
        favoriteLinks.add(ref.id);
        items.push({ kind: "link", key: `link:${ref.id}`, shortcut });
      }
      continue;
    }
    if (favoriteChannels.has(ref.id)) {
      continue;
    }
    const stream = streamById.get(ref.id);
    const forum = forumById.get(ref.id);
    const dm = dmById.get(ref.id);
    if (stream) {
      items.push({ kind: "channel", key: ref.id, channel: stream });
    } else if (forum) {
      items.push({ kind: "forum", key: ref.id, channel: forum });
    } else if (dm) {
      items.push({ kind: "dm", key: ref.id, dm });
    } else {
      continue;
    }
    favoriteChannels.add(ref.id);
  }

  return {
    favorites: items,
    channels: streams.filter((channel) => !favoriteChannels.has(channel.id)),
    forums: forums.filter((channel) => !favoriteChannels.has(channel.id)),
    dms: dms.filter((dm) => !favoriteChannels.has(dm.channel.id)),
    links: shortcuts.filter((shortcut) => !favoriteLinks.has(shortcut.id)),
  };
}
