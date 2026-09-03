import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import type { Profile } from "@/features/channels/hooks";
import type { RelaySessionStatus } from "@/shared/api/relay-session";
import {
  isMuted,
  type ChannelPrefs,
} from "@/features/channels/lib/channelPrefs.ts";
import type { PresenceEntry } from "@/features/channels/lib/presence.ts";
import { isUnread, type ReadState } from "@/features/channels/lib/readState.ts";
import { NewChannelDialog } from "@/features/channels/ui/NewChannelDialog";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { DmSummary } from "@/features/dms/hooks";
import { NewDmDialog } from "@/features/dms/ui/NewDmDialog";
import { shortDate } from "@/features/sidebar/lib/shortDate.ts";
import { ChannelForum, ChannelGlyph } from "@/features/sidebar/ui/ChannelGlyph";
import { DmNavRow } from "@/features/sidebar/ui/DmNavRow";
import { SectionHeader } from "@/features/sidebar/ui/SectionHeader";
import { SidebarNavButton } from "@/features/sidebar/ui/SidebarNavButton";
import { RelayConnectionCard } from "@/features/sidebar/ui/RelayConnectionCard";
import { SidebarProfileCard } from "@/features/sidebar/ui/SidebarProfileCard";
import type { SidebarMenuItem } from "@/features/sidebar/lib/sidebarMenuItem";
import { cn } from "@/shared/lib/cn";

/** The sidebar's sections, already filtered and sorted by the shell. */
export interface ChannelSidebarLists {
  /** Channels the viewer starred, ahead of the main list. */
  starred: ChannelSummary[];
  /** Everything else in the Channels section. */
  unstarred: ChannelSummary[];
  /** Forum-type channels, which get their own section and body. */
  forums: ChannelSummary[];
  /** Ephemeral huddle rooms a kind-48100 link makes joinable. */
  huddles: ChannelSummary[];
  /** Every DM, hidden ones included — drives the "all hidden" copy. */
  dms: DmSummary[];
  /** DMs the viewer has not hidden locally. */
  visibleDms: DmSummary[];
}

/** Viewer-side state deciding which rows read as unread. */
export interface ChannelSidebarReadState {
  /** Starred / muted prefs; muted rows never show an unread dot. */
  prefs: ChannelPrefs;
  /** Per-channel read markers. */
  read: ReadState;
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
  /** Raise the Files overlay. */
  onOpenFiles: () => void;
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
  lists: ChannelSidebarLists;
  readState: ChannelSidebarReadState;
  search: ChannelSidebarSearch;
  dmIdentity: ChannelSidebarDmIdentity;
  dialogs: ChannelSidebarDialogs;
  actions: ChannelSidebarActions;
}

/**
 * The app's left rail: connection state, the ⌘K search field, the starred /
 * channel / forum / huddle / DM sections, and the Files + Agents footer.
 */
export function ChannelSidebar({
  connected,
  relayStatus,
  channelCount,
  selectedId,
  lists,
  readState,
  search,
  dmIdentity,
  dialogs,
  actions,
}: ChannelSidebarProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="px-1 font-semibold">Channels</span>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              connected ? "bg-sidebar-primary" : "bg-sidebar-foreground/40",
            )}
            title={connected ? "Connected" : "Connecting…"}
          />
          <Link
            to="/repos/settings"
            className="rounded-md px-2 py-1 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            Settings
          </Link>
        </div>
      </div>
      {/* Desktop-style search field: typing here opens the ⌘K search panel
          seeded with what was typed. */}
      <div className="px-2 pb-2">
        <div className="flex items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/40 px-2 py-1.5">
          <Search
            aria-hidden
            className="h-4 w-4 shrink-0 text-muted-foreground"
          />
          <input
            value={search.query}
            onChange={(event) => search.onQueryChange(event.target.value)}
            onFocus={search.onFocus}
            placeholder="Search"
            aria-label="Search messages"
            className="w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded border border-border px-1 font-sans text-[10px] text-muted-foreground sm:block">
            ⌘K
          </kbd>
        </div>
      </div>
      <RelayConnectionCard status={relayStatus} />
      <nav className="buzz-sidebar-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {channelCount === 0 && (
          <p className="px-2 py-4 text-sm text-muted-foreground">
            {connected
              ? "No channels visible yet."
              : "Connecting to the relay…"}
          </p>
        )}
        {lists.starred.length > 0 && (
          <>
            <SectionHeader label="Starred" />
            <ul className="space-y-0.5">
              {lists.starred.map((channel) => (
                <li key={channel.id}>
                  <SidebarNavButton
                    selected={channel.id === selectedId}
                    label={channel.name}
                    icon={<ChannelGlyph isPrivate={channel.isPrivate} />}
                    unread={
                      !isMuted(readState.prefs, channel.id) &&
                      isUnread(readState.read, channel.id, channel.updatedAt)
                    }
                    muted={isMuted(readState.prefs, channel.id)}
                    onSelect={() => actions.onSelectChannel(channel.id)}
                    menuItems={actions.channelMenuItems(channel)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
        <SectionHeader
          label="Channels"
          className={lists.starred.length > 0 ? "mt-4" : undefined}
          onAdd={() => dialogs.onNewChannelOpenChange(true)}
          addLabel="New channel"
        />
        <NewChannelDialog
          open={dialogs.newChannelOpen}
          onOpenChange={dialogs.onNewChannelOpenChange}
          onCreated={actions.onChannelCreated}
        />
        <ul className="space-y-0.5">
          {lists.unstarred.map((channel) => (
            <li key={channel.id}>
              <SidebarNavButton
                selected={channel.id === selectedId}
                label={channel.name}
                icon={<ChannelGlyph isPrivate={channel.isPrivate} />}
                unread={
                  !isMuted(readState.prefs, channel.id) &&
                  isUnread(readState.read, channel.id, channel.updatedAt)
                }
                muted={isMuted(readState.prefs, channel.id)}
                onSelect={() => actions.onSelectChannel(channel.id)}
                menuItems={actions.channelMenuItems(channel)}
              />
            </li>
          ))}
        </ul>
        {lists.forums.length > 0 && (
          <>
            <p className="mt-4 mb-[4px] flex h-8 items-center pl-[6px] pr-2 text-[13px] font-medium normal-case tracking-normal text-sidebar-foreground/60">
              Forums
            </p>
            <ul className="space-y-0.5">
              {lists.forums.map((channel) => (
                <li key={channel.id}>
                  <SidebarNavButton
                    selected={channel.id === selectedId}
                    label={channel.name}
                    icon={<ChannelForum />}
                    unread={
                      !isMuted(readState.prefs, channel.id) &&
                      isUnread(readState.read, channel.id, channel.updatedAt)
                    }
                    muted={isMuted(readState.prefs, channel.id)}
                    onSelect={() => actions.onSelectChannel(channel.id)}
                    menuItems={actions.channelMenuItems(channel)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
        {lists.huddles.length > 0 && (
          <details className="px-0 pt-2">
            <summary className="mb-[4px] flex h-8 cursor-pointer select-none items-center pl-[6px] pr-2 text-[13px] font-medium normal-case tracking-normal text-sidebar-foreground/60">
              Huddles ({lists.huddles.length})
            </summary>
            <ul className="space-y-0.5">
              {lists.huddles.map((channel) => (
                <li key={channel.id}>
                  <SidebarNavButton
                    selected={channel.id === selectedId}
                    label={`${channel.name} · ${shortDate(channel.updatedAt)}`}
                    onSelect={() => actions.onSelectChannel(channel.id)}
                  />
                </li>
              ))}
            </ul>
          </details>
        )}
        <SectionHeader
          label="Direct messages"
          variant="dm"
          className="mt-4 mb-[4px]"
          onAdd={() => dialogs.onNewDmOpenChange(true)}
          addLabel="New direct message"
        />
        <NewDmDialog
          open={dialogs.newDmOpen}
          onOpenChange={dialogs.onNewDmOpenChange}
          contacts={dmIdentity.contacts}
          onOpened={actions.onDmOpened}
        />
        {lists.dms.length > 0 && lists.visibleDms.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            All DMs hidden — use + to start one.
          </p>
        )}
        {lists.visibleDms.length > 0 && (
          <ul className="-mx-0.5 space-y-1">
            {lists.visibleDms.map(({ channel, lastMessage }) => (
              <li key={channel.id}>
                <DmNavRow
                  selected={channel.id === selectedId}
                  channelId={channel.id}
                  lastSeenAt={readState.read[channel.id] ?? null}
                  unread={
                    lastMessage
                      ? isUnread(
                          readState.read,
                          channel.id,
                          lastMessage.created_at,
                        )
                      : false
                  }
                  participants={channel.participantPubkeys}
                  selfPubkey={dmIdentity.selfPubkey}
                  profiles={dmIdentity.profiles}
                  presence={channel.participantPubkeys
                    .filter((pk) => pk !== dmIdentity.selfPubkey)
                    .map((pk) => dmIdentity.presence.get(pk))
                    .find((entry) => entry != null)}
                  onSelect={() => actions.onSelectChannel(channel.id)}
                  menuItems={[
                    {
                      label: "Remove from list",
                      danger: true,
                      onSelect: () => actions.onHideDm(channel.id),
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </nav>
      <SidebarProfileCard
        selfPubkey={dmIdentity.selfPubkey}
        profiles={dmIdentity.profiles}
        connected={connected}
        onOpenFiles={actions.onOpenFiles}
      />
    </div>
  );
}
