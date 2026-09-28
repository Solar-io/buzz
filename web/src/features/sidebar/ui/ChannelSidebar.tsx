import { type ReactNode, useMemo, useState } from "react";
import { Inbox, Search } from "lucide-react";
import type { Profile } from "@/features/channels/hooks";
import type { RelaySessionStatus } from "@/shared/api/relay-session";
import {
  isFavorite,
  isMuted,
  type ChannelPrefs,
  type FavoriteRef,
} from "@/features/channels/lib/channelPrefs.ts";
import {
  isChannelRowUnread,
  type ChannelActivityMap,
  type ChannelUnreadCounts,
} from "@/features/channels/lib/channelActivity.ts";
import type { PresenceEntry } from "@/features/channels/lib/presence.ts";
import { isUnread, type ReadState } from "@/features/channels/lib/readState.ts";
import { NewChannelDialog } from "@/features/channels/ui/NewChannelDialog";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { DmSummary } from "@/features/dms/hooks";
import { NewDmDialog } from "@/features/dms/ui/NewDmDialog";
import { useUserStatuses } from "@/features/user-status/hooks";
import { ChannelForum, ChannelGlyph } from "@/features/sidebar/ui/ChannelGlyph";
import { DmNavRow } from "@/features/sidebar/ui/DmNavRow";
import {
  isCollapsed,
  loadCollapsedSections,
  saveCollapsedSections,
  toggleSection,
  type CollapsedSections,
} from "@/features/sidebar/lib/collapsedSections.ts";
import {
  SIDEBAR_LIST_OPTIONS,
  sortUnreadFirst,
} from "@/features/sidebar/lib/sectionList.ts";
import { SidebarSection } from "@/features/sidebar/ui/SidebarSection";
import { SidebarNavButton } from "@/features/sidebar/ui/SidebarNavButton";
import {
  SidebarLinksSection,
  useSidebarLinks,
} from "@/features/sidebar/ui/SidebarShortcutsSection";
import { favoriteMenuItem } from "@/features/sidebar/lib/favoriteMenuItem.ts";
import {
  sectionSidebar,
  type FavoriteItem,
} from "@/features/sidebar/lib/favorites.ts";
import { RelayConnectionCard } from "@/features/sidebar/ui/RelayConnectionCard";
import { SidebarProfileCard } from "@/features/sidebar/ui/SidebarProfileCard";
import { InstallAppButton } from "@/features/sidebar/ui/InstallAppButton";
import { ClaudePaceCard } from "@/features/usage/ui/ClaudePaceCard";
import type { SidebarMenuItem } from "@/features/sidebar/lib/sidebarMenuItem";

/**
 * The sidebar's source lists, already filtered and sorted by the shell.
 * Favorites are pulled out of them here (`sectionSidebar`).
 */
export interface ChannelSidebarLists {
  /** Stream channels — Channels, minus favorites. */
  streams: ChannelSummary[];
  /** Forum-type channels, which get their own section and body. */
  forums: ChannelSummary[];
  /** Every DM, hidden ones included — drives the "all hidden" copy. */
  dms: DmSummary[];
  /** DMs the viewer has not hidden locally. */
  visibleDms: DmSummary[];
}

/** Viewer-side state deciding which rows read as unread. */
export interface ChannelSidebarReadState {
  /** Favorites / muted prefs; muted rows never show an unread dot. */
  prefs: ChannelPrefs;
  /** Per-channel read markers. */
  read: ReadState;
  /**
   * Newest sampled kind:9 message per non-DM channel (useChannelActivity).
   * New messages never bump `channel.updatedAt` (a 39000 metadata time), so
   * the dot must compare the read marker against real message activity,
   * falling back to metadata only for channels with no sample yet.
   */
  activity: ChannelActivityMap;
  /**
   * Live unread counts per channel (the counting activity feed). A count of
   * 1+ upgrades the row's dot to a count badge; absent until the feed's EOSE
   * derives the channel's window, and 0 there renders nothing unread.
   */
  unreadCounts: ChannelUnreadCounts;
}

/** Controlled state for the sidebar's ⌘K search field. */
export interface ChannelSidebarSearch {
  query: string;
  /** Typing seeds the ⌘K panel with the text and opens it. */
  onQueryChange: (query: string) => void;
  /** Focusing the field opens the panel without seeding it. */
  onFocus: () => void;
}

/** Identity and profile data the DM rows render from. */
export interface ChannelSidebarDmIdentity {
  selfPubkey: string | null;
  profiles: Map<string, Profile>;
  presence: Map<string, PresenceEntry>;
  /** Known counterparties offered by the new-DM dialog. */
  contacts: string[];
}

/** Create-dialog open state, owned by the shell. */
export interface ChannelSidebarDialogs {
  newChannelOpen: boolean;
  onNewChannelOpenChange: (open: boolean) => void;
  newDmOpen: boolean;
  onNewDmOpenChange: (open: boolean) => void;
}

/** Everything the sidebar can ask the shell to do. */
export interface ChannelSidebarActions {
  /** Open a channel or DM in the main pane. */
  onSelectChannel: (channelId: string) => void;
  /** Right-click / ⋯ menu for a channel row. */
  channelMenuItems: (channel: ChannelSummary) => SidebarMenuItem[];
  /** A new channel landed at the relay. */
  onChannelCreated: (channelId: string) => void;
  /** A DM was opened (or re-opened, which un-hides it). */
  onDmOpened: (channelId: string) => void;
  /** Hide a DM from this viewer's list. */
  onHideDm: (channelId: string) => void;
  /** Add (true) / remove (false) a DM or link favorite — idempotent. */
  onSetFavorite: (ref: FavoriteRef, favorite: boolean) => void;
  /** Raise the Files overlay. */
  onOpenFiles: () => void;
  /** Open the inbox view. */
  onOpenInbox: () => void;
  /**
   * Raise the in-app dock on an overlay-mode SHORTCUT. Not a channel: the
   * shortcut list is channel-independent (see SidebarShortcutsSection), so
   * this is the shell's shortcut overlay, not a conversation.
   */
  onOpenShortcutOverlay: (shortcutId: string) => void;
}

/** Props for {@link ChannelSidebar}. */
export interface ChannelSidebarProps {
  /** Relay connection state — the header dot and the empty copy read it. */
  connected: boolean;
  /**
   * Full session status. `connected` is the boolean collapse of this; the
   * connection card needs the states it discards (connecting vs reconnecting
   * vs closed) to say anything useful.
   */
  relayStatus: RelaySessionStatus;
  /** Every visible channel, before sectioning (empty-state copy). */
  channelCount: number;
  /** Channel currently open (?c=), or undefined. */
  selectedId: string | undefined;
  /** The inbox view is the active pane. */
  inboxSelected: boolean;
  /**
   * Unanswered asks for the viewer — the Inbox row's count badge (D-035
   * follow-on). 0 renders nothing; the shell-level AsksProvider owns the
   * number so it is live on every view, not just inside the inbox.
   */
  asksCount: number;
  lists: ChannelSidebarLists;
  readState: ChannelSidebarReadState;
  search: ChannelSidebarSearch;
  dmIdentity: ChannelSidebarDmIdentity;
  dialogs: ChannelSidebarDialogs;
  actions: ChannelSidebarActions;
}

/**
 * The app's left rail: connection state, the ⌘K search field, the favorites /
 * channel / forum / DM sections, and the Files + Agents footer.
 */
export function ChannelSidebar({
  connected,
  relayStatus,
  channelCount,
  selectedId,
  inboxSelected,
  asksCount,
  lists,
  readState,
  search,
  dmIdentity,
  dialogs,
  actions,
}: ChannelSidebarProps) {
  // Per-device, deliberately: collapsing a section on a laptop should not
  // fold it on a phone, where the reach/overview tradeoff is different.
  const [collapsed, setCollapsed] = useState<CollapsedSections>(() =>
    loadCollapsedSections(),
  );
  const toggle = (sectionId: string) => {
    setCollapsed((previous) => {
      const next = toggleSection(previous, sectionId);
      saveCollapsedSections(next);
      return next;
    });
  };

  // ONE bulk kind-30315 REQ for every DM partner — the same roster pattern
  // (AgentRosterSidebar), never one subscription per row. The hook dedupes
  // and set-keys the REQ itself, so the memo is for cleanliness; group DMs
  // subscribe all partners, rows read only their avatar partner's status.
  const dmPartnerPubkeys = useMemo(() => {
    const partners = lists.visibleDms.flatMap(({ channel }) =>
      channel.participantPubkeys.filter(
        (pubkey) => pubkey !== dmIdentity.selfPubkey,
      ),
    );
    return Array.from(new Set(partners));
  }, [lists.visibleDms, dmIdentity.selfPubkey]);
  const dmStatuses = useUserStatuses(dmPartnerPubkeys);

  const prefs = readState.prefs;
  const links = useSidebarLinks({
    onOpenOverlay: actions.onOpenShortcutOverlay,
    favorites: {
      isFavorite: (id) => isFavorite(prefs, { kind: "link", id }),
      set: (id, on) => actions.onSetFavorite({ kind: "link", id }, on),
    },
  });
  // Favorited items leave their home sections for Favorites (add order).
  const sections = sectionSidebar({
    streams: lists.streams,
    forums: lists.forums,
    dms: lists.visibleDms,
    shortcuts: links.shortcuts,
    favorites: prefs.favorites,
  });

  // Unread dot for channel/forum rows: read marker vs the newest
  // sampled MESSAGE (self-authored samples excluded — see
  // channelUnreadSignal), falling back to metadata for unsampled channels.
  // DM rows keep their own activity feed and stay on lastMessage logic.
  const rowUnread = (channel: ChannelSummary) =>
    !isMuted(readState.prefs, channel.id) &&
    isChannelRowUnread({
      read: readState.read,
      channelId: channel.id,
      updatedAt: channel.updatedAt,
      activity: readState.activity.get(channel.id),
      selfPubkey: dmIdentity.selfPubkey,
    });
  // The counted form of the same signal, when the counting feed has derived
  // the channel's window. Muted rows never reach the badge: `rowUnread`
  // already folds mute in, and the badge renders only on an unread row.
  const rowUnreadCount = (channel: ChannelSummary) =>
    readState.unreadCounts.get(channel.id) ?? null;

  const channelSelected = (channel: ChannelSummary) =>
    channel.id === selectedId;
  // DM rows keep their own activity feed and stay on lastMessage logic. Own
  // messages (e.g. sent from another device) never dot your row — parity
  // with channel rows, whose channelUnreadSignal ignores self-authored
  // activity.
  const dmUnread = ({ channel, lastMessage }: DmSummary) =>
    lastMessage && lastMessage.authorPubkey !== dmIdentity.selfPubkey
      ? isUnread(readState.read, channel.id, lastMessage.created_at)
      : false;
  // Unread channels float to the top of Channels (SIDEBAR_LIST_OPTIONS);
  // the incoming order is kept within each group.
  const channelRows = SIDEBAR_LIST_OPTIONS.unreadFirst
    ? sortUnreadFirst(sections.channels, rowUnread)
    : sections.channels;

  const renderChannel =
    (glyph: (channel: ChannelSummary) => ReactNode) =>
    (channel: ChannelSummary) => (
      <SidebarNavButton
        selected={channel.id === selectedId}
        label={channel.name}
        icon={glyph(channel)}
        unread={rowUnread(channel)}
        unreadCount={rowUnreadCount(channel)}
        muted={isMuted(readState.prefs, channel.id)}
        onSelect={() => actions.onSelectChannel(channel.id)}
        menuItems={actions.channelMenuItems(channel)}
      />
    );
  const channelRow = renderChannel((channel) => (
    <ChannelGlyph isPrivate={channel.isPrivate} />
  ));
  const forumRow = renderChannel(() => <ChannelForum />);

  const renderDm = (dm: DmSummary) => {
    const { channel } = dm;
    // The row's "about" agent: first non-self participant (its avatar/pulse
    // pubkey — DmNavRow's `others[0]` picks the same one; dedupe never moves
    // the FIRST non-self entry), falling back to participants[0] for a
    // self-only DM.
    const partnerPubkey =
      channel.participantPubkeys.find((pk) => pk !== dmIdentity.selfPubkey) ??
      channel.participantPubkeys[0] ??
      "";
    const dmRef: FavoriteRef = { kind: "channel", id: channel.id };
    const dmFavorite = isFavorite(prefs, dmRef);
    return (
      <DmNavRow
        selected={channel.id === selectedId}
        channelId={channel.id}
        lastSeenAt={readState.read[channel.id] ?? null}
        unread={dmUnread(dm)}
        participants={channel.participantPubkeys}
        selfPubkey={dmIdentity.selfPubkey}
        profiles={dmIdentity.profiles}
        status={dmStatuses.get(partnerPubkey) ?? null}
        presence={channel.participantPubkeys
          .filter((pk) => pk !== dmIdentity.selfPubkey)
          .map((pk) => dmIdentity.presence.get(pk))
          .find((entry) => entry != null)}
        onSelect={() => actions.onSelectChannel(channel.id)}
        menuItems={[
          favoriteMenuItem(dmFavorite, () =>
            actions.onSetFavorite(dmRef, !dmFavorite),
          ),
          {
            label: "Remove from list",
            danger: true,
            onSelect: () => actions.onHideDm(channel.id),
          },
        ]}
      />
    );
  };

  // A favorite renders the row its home section would (DM rows look like DM
  // rows, links like links), carrying the same menu with the toggle flipped.
  const renderFavorite = (item: FavoriteItem) => {
    switch (item.kind) {
      case "channel":
        return channelRow(item.channel);
      case "forum":
        return forumRow(item.channel);
      case "dm":
        return renderDm(item.dm);
      case "link":
        return links.renderLink(item.shortcut);
    }
  };
  const favoriteSelected = (item: FavoriteItem) =>
    item.kind === "link"
      ? links.isSelected(item.shortcut)
      : item.key === selectedId;
  const favoriteUnread = (item: FavoriteItem) => {
    switch (item.kind) {
      case "channel":
      case "forum":
        return rowUnread(item.channel);
      case "dm":
        return dmUnread(item.dm);
      case "link":
        return false;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="channel-sidebar">
      {/* Fixed header: the ⌘K search field, then the Inbox row 6px below it.
          The old header row (the word "Channels", the connection dot, and a
          Settings link) is gone — Sam, 2026-09-22. Settings still lives in
          the profile row at the foot of this rail, and the connection state
          is on its indicator, so nothing became unreachable. */}
      <div className="flex flex-col px-2.5 pt-3 pb-1.5">
        {/* Desktop-style search field: typing here opens the ⌘K search
            panel seeded with what was typed. */}
        <div className="flex h-8.5 items-center gap-2 rounded-[8px] border border-sidebar-border bg-sidebar-accent/60 pr-2 pl-2.5">
          <Search
            aria-hidden
            className="size-3.75 shrink-0 text-sidebar-foreground/60"
          />
          <input
            value={search.query}
            onChange={(event) => search.onQueryChange(event.target.value)}
            onFocus={search.onFocus}
            placeholder="Search"
            aria-label="Search messages"
            className="w-full bg-transparent text-sm outline-hidden placeholder:text-sidebar-foreground/60"
          />
          <kbd className="hidden rounded-[5px] border border-sidebar-border px-[5px] py-px font-sans text-2xs text-sidebar-foreground/60 sm:block">
            ⌘K
          </kbd>
        </div>
        {/* Above the sections, like the desktop's primary nav: the inbox is
            a destination, not one channel among many. */}
        <div className="mt-1.5">
          <SidebarNavButton
            selected={inboxSelected}
            label="Inbox"
            icon={<Inbox aria-hidden className="size-4 shrink-0" />}
            unread={asksCount > 0}
            unreadCount={asksCount}
            onSelect={actions.onOpenInbox}
          />
        </div>
      </div>
      <RelayConnectionCard status={relayStatus} />
      {/* The only scrolling region: the footer below is a sibling, so the
          list scrolls above it and never under it. */}
      <nav className="buzz-sidebar-scrollbar flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-2.5 pt-1 pb-3">
        {channelCount === 0 && (
          <p className="px-2 py-4 text-sm text-sidebar-foreground/60">
            {connected
              ? "No channels visible yet."
              : "Connecting to the relay…"}
          </p>
        )}
        {sections.favorites.length > 0 && (
          // Channels, forums, DMs and links the viewer pinned, in add order
          // (never unread-sorted). Replaced the channel-only Starred.
          <SidebarSection
            label="Favorites"
            items={sections.favorites}
            getKey={(item) => item.key}
            renderItem={renderFavorite}
            isSelected={favoriteSelected}
            isUnread={favoriteUnread}
            collapsed={isCollapsed(collapsed, "favorites")}
            onToggleCollapsed={() => toggle("favorites")}
          />
        )}
        <SidebarSection
          label="Channels"
          items={channelRows}
          getKey={(channel) => channel.id}
          renderItem={channelRow}
          isSelected={channelSelected}
          isUnread={rowUnread}
          collapsed={isCollapsed(collapsed, "channels")}
          onToggleCollapsed={() => toggle("channels")}
          onAdd={() => dialogs.onNewChannelOpenChange(true)}
          addLabel="New channel"
        >
          <NewChannelDialog
            open={dialogs.newChannelOpen}
            onOpenChange={dialogs.onNewChannelOpenChange}
            onCreated={actions.onChannelCreated}
          />
        </SidebarSection>
        <SidebarSection
          label="Direct messages"
          items={sections.dms}
          getKey={(dm) => dm.channel.id}
          renderItem={renderDm}
          isSelected={(dm) => dm.channel.id === selectedId}
          isUnread={dmUnread}
          collapsed={isCollapsed(collapsed, "dms")}
          onToggleCollapsed={() => toggle("dms")}
          onAdd={() => dialogs.onNewDmOpenChange(true)}
          addLabel="New direct message"
        >
          <NewDmDialog
            open={dialogs.newDmOpen}
            onOpenChange={dialogs.onNewDmOpenChange}
            contacts={dmIdentity.contacts}
            onOpened={actions.onDmOpened}
          />
          {lists.dms.length > 0 && lists.visibleDms.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-sidebar-foreground/60">
              All DMs hidden — use + to start one.
            </p>
          )}
        </SidebarSection>
        {sections.forums.length > 0 && (
          <SidebarSection
            label="Forums"
            items={sections.forums}
            getKey={(channel) => channel.id}
            renderItem={forumRow}
            isSelected={channelSelected}
            isUnread={rowUnread}
            collapsed={isCollapsed(collapsed, "forums")}
            onToggleCollapsed={() => toggle("forums")}
          />
        )}
        {/* Always rendered — storage (encrypted relay blob vs this device's
            localStorage) follows the signer. Defaults collapsed. */}
        <SidebarLinksSection
          links={links}
          items={sections.links}
          collapsed={isCollapsed(collapsed, "links")}
          onToggleCollapsed={() => toggle("links")}
        />
      </nav>
      {/* Fixed footer: usage strip above the user row, 1px top border. */}
      <footer className="flex flex-col gap-1.5 border-t border-sidebar-border px-2.5 pt-2 pb-2.5">
        <ClaudePaceCard />
        <InstallAppButton />
        <SidebarProfileCard
          selfPubkey={dmIdentity.selfPubkey}
          profiles={dmIdentity.profiles}
          connected={connected}
          onOpenFiles={actions.onOpenFiles}
        />
      </footer>
    </div>
  );
}
