import { type ReactNode, useMemo, useState } from "react";
import {
  FileText,
  Folder,
  Inbox,
  ListPlus,
  ListTodo,
  MessagesSquare,
  Newspaper,
  Search,
} from "lucide-react";
import type { Profile } from "@/features/channels/hooks";
import type { RelaySessionStatus } from "@/shared/api/relay-session";
import {
  isFavorite,
  isMuted,
  type ChannelPrefs,
  type FavoriteRef,
} from "@/features/channels/lib/channelPrefs.ts";
import type {
  ChannelActivityMap,
  ChannelUnreadCounts,
} from "@/features/channels/lib/channelActivity.ts";
import type { PresenceEntry } from "@/features/channels/lib/presence.ts";
import type { ReadState } from "@/features/channels/lib/readState.ts";
import { NewChannelDialog } from "@/features/channels/ui/NewChannelDialog";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { DmSummary } from "@/features/dms/hooks";
import { dmDisplayName } from "@/features/dms/lib/dmNaming.ts";
import { NewDmDialog } from "@/features/dms/ui/NewDmDialog";
import { scratchInfo } from "@/features/scratch/lib/scratchChannel.ts";
import { ScratchGlyph } from "@/features/scratch/ui/ScratchChrome";
import { TerminalNavButton } from "@/features/terminal/ui/TerminalNavButton";
import { useUserStatuses } from "@/features/user-status/hooks";
import { ChannelForum, ChannelGlyph } from "@/features/sidebar/ui/ChannelGlyph";
import { DmNavRow } from "@/features/sidebar/ui/DmNavRow";
import {
  isCollapsed,
  loadCollapsedSections,
  NAV_FORUMS_ID,
  NAV_LINKS_ID,
  saveCollapsedSections,
  toggleSection,
  type CollapsedSections,
} from "@/features/sidebar/lib/collapsedSections.ts";
import {
  rankSection,
  type RankFacts,
} from "@/features/sidebar/lib/sectionOrder.ts";
import {
  noteSidebarVisit,
  useOpenItemSnapshot,
  useOwnLastSent,
  useRowHold,
} from "@/features/sidebar/lib/useSidebarOrder.ts";
import { SidebarSection } from "@/features/sidebar/ui/SidebarSection";
import { SidebarNavButton } from "@/features/sidebar/ui/SidebarNavButton";
import { SidebarNavDisclosure } from "@/features/sidebar/ui/SidebarNavDisclosure";
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
import { SidebarAppMenu } from "@/features/sidebar/ui/SidebarAppMenu";
import { InstallAppButton } from "@/features/sidebar/ui/InstallAppButton";
import { VitalsBlock } from "@/features/vitals/ui/VitalsBlock";
import { useActiveWebView } from "@/features/webPanels/activeWebStore.ts";
import {
  DAILY_DIGEST_PANEL,
  DAILY_DIGEST_TARGET,
} from "@/features/webPanels/lib/dailyDigest.ts";
import type { ChannelMarkers } from "@/features/work/lib/channelMarkers.ts";
import type { SidebarMenuItem } from "@/features/sidebar/lib/sidebarMenuItem";
import {
  channelRowUnread,
  dmRowUnread,
} from "@/features/sidebar/lib/rowUnread.ts";

/**
 * The sidebar's source lists, already filtered and sorted by the shell.
 * Favorites are pulled out of them here (`sectionSidebar`).
 */
export interface ChannelSidebarLists {
  /** Stream channels — Channels, minus favorites. */
  streams: ChannelSummary[];
  /** Forum-type channels, which get their own section and body. */
  forums: ChannelSummary[];
  /** Live scratch channels — the Scratch section, above Favorites. */
  scratch?: ChannelSummary[];
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
   * Newest sampled kind:9 message per conversation, DMs included (the
   * conversation-activity store). New messages never bump
   * `channel.updatedAt` (a 39000 metadata time), so the dot must compare the
   * read marker against real message activity, falling back to metadata
   * only for channels with no sample yet.
   */
  activity: ChannelActivityMap;
  /**
   * Live unread counts per conversation, channel and DM rows alike (I4). A
   * count of 1+ upgrades the row's dot to a count badge; absent until the
   * feed's EOSE derives the window, and 0 there renders nothing unread.
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
  /** Show Files (a page in the main column beside the Work strip). */
  onOpenFiles: () => void;
  /** Open the inbox view. */
  onOpenInbox: () => void;
  /** Open the Work page (?view=work) — the row shows below lg only. */
  onOpenWork: () => void;
  /** Open the Items page (?view=items). */
  onOpenItems: () => void;
  /** Open the Shelf (?view=shelf). */
  onOpenShelf?: () => void;
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
  /** The Work page is the active pane. */
  workSelected: boolean;
  /** Needs-you rows, Everywhere — the Work row's count badge. */
  needsCount: number;
  /** The Items page is the active pane. */
  itemsSelected: boolean;
  /** Open bugs · open backlog — the Items row's trailing numbers. */
  itemCounts: { bugs: number; backlog: number } | null;
  /** The Shelf is the active pane. */
  shelfSelected?: boolean;
  /** Files shared since the Shelf was last opened — "N new". */
  shelfNew?: number;
  /** Per-channel needs / running — the channel rows' work markers. */
  channelMarkers?: ChannelMarkers;
  lists: ChannelSidebarLists;
  readState: ChannelSidebarReadState;
  search: ChannelSidebarSearch;
  dmIdentity: ChannelSidebarDmIdentity;
  dialogs: ChannelSidebarDialogs;
  actions: ChannelSidebarActions;
}

/**
 * The app's left rail (Main artboard): the B menu (Settings and the
 * account), the ⌘K Jump field, the nav rows (Inbox, Items, Shelf, Files,
 * Terminal, and Work below lg), then — folded under Terminal — Forums and
 * Links, the favorites / channel / DM sections, and the Vitals block at the
 * foot. Layout per Sam, 2026-09-30.
 */
export function ChannelSidebar({
  connected,
  relayStatus,
  channelCount,
  selectedId,
  inboxSelected,
  asksCount,
  workSelected,
  needsCount,
  itemsSelected,
  itemCounts,
  shelfSelected = false,
  shelfNew = 0,
  channelMarkers,
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
  // (RosterTable), never one subscription per row. The hook dedupes
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
    onVisit: (id) => noteSidebarVisit(`link:${id}`),
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

  // Unread dots: one definition, shared with the phone tab bar's Channels
  // badge (lib/rowUnread.ts).
  const unreadInput = {
    prefs: readState.prefs,
    read: readState.read,
    activity: readState.activity,
    selfPubkey: dmIdentity.selfPubkey,
    unreadCounts: readState.unreadCounts,
  };
  const rowUnread = (channel: ChannelSummary) =>
    channelRowUnread(channel, unreadInput);
  // The counted form of the same signal, when the counting feed has derived
  // the channel's window. Muted rows never reach the badge: `rowUnread`
  // already folds mute in, and the badge renders only on an unread row.
  const rowUnreadCount = (channel: ChannelSummary) =>
    readState.unreadCounts.get(channel.id) ?? null;

  // While Files or a link page covers the conversation, that page's row is
  // the one selected — never also the conversation behind it.
  const { state: webView, show: showWebView } = useActiveWebView();
  const filesSelected = webView.active?.kind === "files";
  const shownId = webView.active === null ? selectedId : undefined;
  const channelSelected = (channel: ChannelSummary) => channel.id === shownId;
  const dmUnread = (dm: DmSummary) => dmRowUnread(dm, unreadInput);
  // Favorites, Channels and DMs: unread by recency, then the four you most
  // recently wrote in, then alphabetical (sectionOrder.ts). The open row ranks by its
  // facts at the moment it was opened, and the row under the pointer (with
  // its neighbours) holds its place, so nothing slides under a click.
  const ownLastSent = useOwnLastSent();
  const channelFacts = (channel: ChannelSummary): RankFacts => ({
    unread: rowUnread(channel),
    score: ownLastSent.get(channel.id) ?? 0,
    lastActivity:
      readState.activity.get(channel.id)?.createdAt ?? channel.updatedAt,
    name: channel.name,
  });
  const dmFacts = (dm: DmSummary): RankFacts => ({
    unread: dmUnread(dm),
    score: ownLastSent.get(dm.channel.id) ?? 0,
    lastActivity: dm.lastMessage?.created_at ?? dm.channel.updatedAt,
    // The label the row shows (DmNavRow), so A–Z matches what you read.
    name: dmDisplayName(
      dm.channel.participantPubkeys,
      dmIdentity.selfPubkey ?? "",
      dmIdentity.profiles,
    ),
  });
  const favoriteFacts = (item: FavoriteItem): RankFacts => {
    switch (item.kind) {
      case "channel":
      case "forum":
        return channelFacts(item.channel);
      case "dm":
        return dmFacts(item.dm);
      case "link":
        return {
          unread: false,
          score: 0,
          lastActivity: 0,
          name: item.shortcut.label,
        };
    }
  };
  const openSnapshot = useOpenItemSnapshot(selectedId, (key) => {
    const favorite = sections.favorites.find((item) => item.key === key);
    if (favorite) return favoriteFacts(favorite);
    const channel = sections.channels.find((row) => row.id === key);
    if (channel) return channelFacts(channel);
    const dm = sections.dms.find((row) => row.channel.id === key);
    return dm ? dmFacts(dm) : undefined;
  });
  // The row key under the pointer (SidebarSection tags each row), or null.
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const liveFavorites = rankSection(
    sections.favorites,
    (item) => item.key,
    favoriteFacts,
    { frozen: openSnapshot },
  );
  const liveChannels = rankSection(
    sections.channels,
    (channel) => channel.id,
    channelFacts,
    { frozen: openSnapshot },
  );
  const liveDms = rankSection(sections.dms, (dm) => dm.channel.id, dmFacts, {
    frozen: openSnapshot,
  });
  const favoriteRows = useRowHold(
    liveFavorites,
    (item) => item.key,
    hoveredKey,
  );
  const channelRows = useRowHold(
    liveChannels,
    (channel) => channel.id,
    hoveredKey,
  );
  const dmRows = useRowHold(liveDms, (dm) => dm.channel.id, hoveredKey);

  const renderChannel =
    (glyph: (channel: ChannelSummary) => ReactNode) =>
    (channel: ChannelSummary) => (
      <SidebarNavButton
        selected={channel.id === shownId}
        label={channel.name}
        icon={glyph(channel)}
        unread={rowUnread(channel)}
        unreadCount={rowUnreadCount(channel)}
        muted={isMuted(readState.prefs, channel.id)}
        status={channelMarkers?.get(channel.id)}
        onSelect={() => actions.onSelectChannel(channel.id)}
        menuItems={actions.channelMenuItems(channel)}
      />
    );
  const channelRow = renderChannel((channel) => (
    <ChannelGlyph isPrivate={channel.isPrivate} />
  ));
  const forumRow = renderChannel(() => <ChannelForum />);
  // "flight-path / scratch-1" behind a dashed hash (Main artboard).
  const channelNames = [...lists.streams, ...lists.forums];
  const scratchRow = (channel: ChannelSummary) => {
    const label = scratchInfo(channel, channelNames)?.label;
    return (
      <SidebarNavButton
        selected={channel.id === shownId}
        label={label ? `${label.parent} / ${label.rest}` : channel.name}
        icon={<ScratchGlyph className="size-3.5 text-sidebar-foreground/60" />}
        unread={rowUnread(channel)}
        unreadCount={rowUnreadCount(channel)}
        muted={isMuted(readState.prefs, channel.id)}
        status={channelMarkers?.get(channel.id)}
        onSelect={() => actions.onSelectChannel(channel.id)}
        menuItems={actions.channelMenuItems(channel)}
      />
    );
  };

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
        selected={channel.id === shownId}
        channelId={channel.id}
        unreadCount={readState.unreadCounts.get(channel.id) ?? null}
        unread={dmUnread(dm)}
        participants={channel.participantPubkeys}
        selfPubkey={dmIdentity.selfPubkey}
        profiles={dmIdentity.profiles}
        status={dmStatuses.get(partnerPubkey) ?? null}
        running={channelMarkers?.get(channel.id)?.running ?? 0}
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
      : item.key === shownId;
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
      {/* Fixed header (Main artboard): the B menu, the ⌘K Jump field, then
          the nav. Settings, status and who you are signed in as live behind
          the B; a dropped relay shows in RelayConnectionCard below. */}
      <div className="flex flex-col gap-3.5 px-3 pt-4">
        <div className="flex items-center px-1">
          <SidebarAppMenu
            selfPubkey={dmIdentity.selfPubkey}
            profiles={dmIdentity.profiles}
            connected={connected}
            onOpenFiles={actions.onOpenFiles}
          />
        </div>
        {/* Typing here opens the ⌘K panel seeded with what was typed. */}
        <div className="flex h-8.5 items-center gap-2 rounded-[9px] border border-sidebar-border bg-background px-2.5 text-muted-foreground">
          <Search aria-hidden className="size-4 shrink-0" />
          <input
            value={search.query}
            onChange={(event) => search.onQueryChange(event.target.value)}
            onFocus={search.onFocus}
            placeholder="Jump to…"
            aria-label="Search messages"
            className="w-full bg-transparent text-sidebar-meta text-foreground outline-hidden placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded-[5px] border border-line-2 px-[5px] font-mono text-2xs sm:block">
            ⌘K
          </kbd>
        </div>
        {/* Destinations, not channels. Reminders left this list (decision
            D4): Feedback lives in Work's Needs you; the Reminders view stays
            reachable from Work, More and ⌘K. */}
        <div>
          {/* Tablet only: at lg Work is the docked rail, and on a phone
              it is the first tab of the bottom bar. */}
          <div className="hidden md:block lg:hidden">
            <SidebarNavButton
              selected={workSelected && webView.active === null}
              label="Work"
              icon={<ListTodo aria-hidden className="size-4 shrink-0" />}
              unread={needsCount > 0}
              unreadCount={needsCount}
              onSelect={actions.onOpenWork}
            />
          </div>
          <SidebarNavButton
            selected={inboxSelected && webView.active === null}
            label="Inbox"
            icon={<Inbox aria-hidden className="size-4 shrink-0" />}
            unread={asksCount > 0}
            unreadCount={asksCount}
            onSelect={actions.onOpenInbox}
          />
          <SidebarNavButton
            selected={itemsSelected && webView.active === null}
            label="Items"
            icon={<ListPlus aria-hidden className="size-4 shrink-0" />}
            meta={
              itemCounts && itemCounts.bugs + itemCounts.backlog > 0 ? (
                <span
                  data-testid="sidebar-items-counts"
                  title={`${itemCounts.bugs} open ${itemCounts.bugs === 1 ? "bug" : "bugs"} · ${itemCounts.backlog} in backlog`}
                >
                  {itemCounts.bugs} · {itemCounts.backlog}
                </span>
              ) : null
            }
            onSelect={actions.onOpenItems}
          />
          {actions.onOpenShelf ? (
            <SidebarNavButton
              selected={shelfSelected && webView.active === null}
              label="Shelf"
              icon={<FileText aria-hidden className="size-4 shrink-0" />}
              meta={
                shelfNew > 0 ? (
                  <span data-testid="sidebar-shelf-new">{shelfNew} new</span>
                ) : null
              }
              onSelect={actions.onOpenShelf}
            />
          ) : null}
          <SidebarNavButton
            selected={filesSelected}
            label="Files"
            icon={<Folder aria-hidden className="size-4 shrink-0" />}
            onSelect={actions.onOpenFiles}
          />
          <TerminalNavButton />
        </div>
      </div>
      <RelayConnectionCard status={relayStatus} />
      {/* The only scrolling region: the footer below is a sibling, so the
          list scrolls above it and never under it. */}
      <nav
        onPointerOver={(event) =>
          setHoveredKey(
            (event.target as Element)
              .closest?.("[data-sidebar-key]")
              ?.getAttribute("data-sidebar-key") ?? null,
          )
        }
        onPointerLeave={() => setHoveredKey(null)}
        className="buzz-sidebar-scrollbar flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-2.5 pt-px pb-3"
      >
        {/* Forums and Links: nav rows directly under Terminal, folded until
            clicked (Sam, 2026-09-30). They open the top of the SCROLLING
            list rather than joining the fixed header: an open list there
            would squeeze the channels to nothing on a phone. px-0.5 lines
            them up with the header's rows (px-3 there, px-2.5 here). */}
        <div className="flex flex-col gap-px px-0.5">
          {sections.forums.length > 0 && (
            <SidebarNavDisclosure
              label="Forums"
              icon={<MessagesSquare aria-hidden className="size-4 shrink-0" />}
              items={sections.forums}
              getKey={(channel) => channel.id}
              renderItem={forumRow}
              isSelected={channelSelected}
              isUnread={rowUnread}
              collapsed={isCollapsed(collapsed, NAV_FORUMS_ID)}
              onToggleCollapsed={() => toggle(NAV_FORUMS_ID)}
            />
          )}
          <SidebarNavButton
            label={DAILY_DIGEST_PANEL.label}
            icon={<Newspaper aria-hidden className="size-4 shrink-0" />}
            selected={webView.active?.kind === "digest"}
            onSelect={() => showWebView(DAILY_DIGEST_TARGET)}
          />
          {/* Always rendered — storage (encrypted relay blob vs this
              device's localStorage) follows the signer, and "Add a link"
              must stay reachable on an empty list. */}
          <SidebarLinksSection
            links={links}
            items={sections.links}
            collapsed={isCollapsed(collapsed, NAV_LINKS_ID)}
            onToggleCollapsed={() => toggle(NAV_LINKS_ID)}
          />
        </div>
        {channelCount === 0 && (
          <p className="px-2 py-4 text-sm text-sidebar-foreground/60">
            {connected
              ? "No channels visible yet."
              : "Connecting to the relay…"}
          </p>
        )}
        {lists.scratch && lists.scratch.length > 0 && (
          // Short-lived copies of channels (Phase 3): above everything that
          // lasts, and gone from here the moment `/exit` runs.
          <SidebarSection
            label="Scratch"
            hint="/new"
            items={lists.scratch}
            getKey={(channel) => channel.id}
            renderItem={scratchRow}
            isSelected={channelSelected}
            isUnread={rowUnread}
            collapsed={isCollapsed(collapsed, "scratch")}
            onToggleCollapsed={() => toggle("scratch")}
          />
        )}
        {sections.favorites.length > 0 && (
          // Channels, forums, DMs and links the viewer pinned, unread first,
          // then four most used, then A–Z (Sam 2026-10-03). Replaced the channel-only Starred.
          <SidebarSection
            label="Favorites"
            items={favoriteRows}
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
          items={dmRows}
          getKey={(dm) => dm.channel.id}
          renderItem={renderDm}
          isSelected={(dm) => dm.channel.id === shownId}
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
      </nav>
      {/* Fixed footer. Vitals is the last thing in the rail, in the slot the
          profile row held until Sam removed it (2026-09-30); the install
          offer, when the browser has one, sits above it. */}
      <footer className="flex flex-col gap-1.5 px-3 pt-2 pb-3">
        <InstallAppButton />
        <VitalsBlock />
      </footer>
    </div>
  );
}
