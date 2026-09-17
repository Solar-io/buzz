import { useEffect, useMemo, useState } from "react";

import { useChannelMessages, useProfiles } from "@/features/channels/hooks";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { dmDisplayName } from "@/features/dms/lib/dmNaming.ts";
import { useAsks } from "../AsksProvider.tsx";
import { useInboxReadState } from "../hooks.ts";
import {
  filterInboxRows,
  inboxFilterCounts,
  inboxRowSortAt,
  parseInboxFilter,
  type InboxFilter,
  type InboxListRow,
} from "../lib/inboxFilter.ts";
import { buildInboxItems, type InboxChannelInfo } from "../lib/inboxItem.ts";
import { inboxReadPredicate } from "../lib/inboxReadState.ts";
import { inboxThreadContext } from "../lib/inboxThread.ts";
import { HomeInbox } from "./HomeInbox.tsx";

const FILTER_KEY = "buzz.inbox-filter.v1";

/**
 * Connector: everything stateful the home screen needs, wired to the relay
 * and to local storage, handed to the prop-driven {@link HomeInbox}.
 *
 * `channels` and `selfPubkey` are passed in rather than fetched so this
 * mounts inside the existing shell (`app/routes/repos.tsx`) without opening a
 * second kind:39000 subscription alongside the sidebar's.
 *
 * The mention+DM feed is the shell-level {@link useAsks} provider's, not this
 * route's own `useInboxMessages`: the provider owns the subscriptions once
 * for the whole app (the badge needs them on every view), and the inbox view
 * simply reads the same feed — net subscriptions unchanged while open.
 */
export function HomeInboxRoute({
  channels,
  selfPubkey,
  onOpenChannel,
}: {
  channels: ChannelSummary[];
  selfPubkey: string | null;
  /** Open a channel (and optionally a message) in the full channel view. */
  onOpenChannel: (channelId: string, messageId?: string) => void;
}) {
  const [filter, setFilter] = useState<InboxFilter>(() =>
    parseInboxFilter(globalThis.localStorage?.getItem(FILTER_KEY)),
  );
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null);

  const { feed, loading, asks, probeAsk } = useAsks();
  const { channelRead, inboxRead, markRead, markUnread } = useInboxReadState();

  // DM channels are all named "DM" by the relay; the participants are what a
  // person recognises. Same derivation the sidebar uses.
  const dmParticipants = useMemo(
    () =>
      channels
        .filter((channel) => channel.type === "dm")
        .flatMap((channel) =>
          channel.participantPubkeys.filter((pubkey) => pubkey !== selfPubkey),
        ),
    [channels, selfPubkey],
  );
  const authorPubkeys = useMemo(
    () => feed.map((message) => message.authorPubkey),
    [feed],
  );
  const profiles = useProfiles(
    useMemo(
      () => Array.from(new Set([...authorPubkeys, ...dmParticipants])),
      [authorPubkeys, dmParticipants],
    ),
  );

  const inboxChannels = useMemo<InboxChannelInfo[]>(
    () =>
      channels.map((channel) => ({
        id: channel.id,
        type: channel.type,
        name:
          channel.type === "dm"
            ? dmDisplayName(
                channel.participantPubkeys,
                selfPubkey ?? "",
                profiles,
              )
            : channel.name,
      })),
    [channels, profiles, selfPubkey],
  );

  const isRead = useMemo(
    () => inboxReadPredicate(channelRead, inboxRead),
    [channelRead, inboxRead],
  );
  const items = useMemo(
    () =>
      buildInboxItems({
        messages: feed,
        channels: inboxChannels,
        selfPubkey,
        isRead,
      }),
    [feed, inboxChannels, selfPubkey, isRead],
  );

  // The list interleaves conversations and asks, newest activity first. Ask
  // rows carry their resolved channel label (DMs display by participant).
  const channelNameById = useMemo(
    () => new Map(inboxChannels.map((channel) => [channel.id, channel])),
    [inboxChannels],
  );
  const rows = useMemo<InboxListRow[]>(
    () =>
      [
        ...items.map((item) => ({ kind: "conversation" as const, item })),
        ...asks.map((ask) => {
          const channel = channelNameById.get(ask.channelId);
          const name = channel?.name ?? ask.channelId;
          return {
            kind: "ask" as const,
            ask,
            channelLabel: channel?.type === "dm" ? name : `#${name}`,
          };
        }),
      ].sort(
        (a, b) =>
          inboxRowSortAt(b) - inboxRowSortAt(a) ||
          (a.kind === "ask" ? a.ask.id : a.item.conversationId).localeCompare(
            b.kind === "ask" ? b.ask.id : b.item.conversationId,
          ),
      ),
    [items, asks, channelNameById],
  );

  const counts = useMemo(() => inboxFilterCounts(rows), [rows]);
  const visibleRows = useMemo(
    () => filterInboxRows(rows, filter),
    [rows, filter],
  );

  const selectedItem =
    items.find((item) => item.conversationId === selectedConversationId) ??
    null;

  // A selection that the current filter hides is a dead pane: clear it rather
  // than leaving the detail showing a row the list no longer offers.
  useEffect(() => {
    if (
      selectedConversationId !== null &&
      !visibleRows.some(
        (row) =>
          row.kind === "conversation" &&
          row.item.conversationId === selectedConversationId,
      )
    ) {
      setSelectedConversationId(null);
    }
  }, [visibleRows, selectedConversationId]);

  // The live channel timeline behind the selection supplies the surrounding
  // thread. Reusing `useChannelMessages` means the detail pane reads the same
  // buffer (and the same on-disk cache) the channel view does.
  const { messages: channelBuffer } = useChannelMessages(
    selectedItem?.channelId ?? null,
  );
  const context = useMemo(
    () => (selectedItem ? inboxThreadContext(selectedItem, channelBuffer) : []),
    [selectedItem, channelBuffer],
  );

  const changeFilter = (next: InboxFilter) => {
    setFilter(next);
    try {
      globalThis.localStorage?.setItem(FILTER_KEY, next);
    } catch {
      // Preference is a convenience; a storage failure must not break the view.
    }
  };

  return (
    <HomeInbox
      rows={visibleRows}
      profiles={profiles}
      filter={filter}
      counts={counts}
      loading={loading}
      selectedItem={selectedItem}
      context={context}
      selfPubkey={selfPubkey}
      isRead={isRead}
      onFilterChange={changeFilter}
      // Selecting deliberately does NOT clear the unread state. An inbox that
      // marks a row read the instant you glance at it destroys the one signal
      // it exists to carry — and it would erase the "New" divider in the pane
      // you just opened, before you had read past it. Clearing is the explicit
      // "Mark read" action, or opening the channel (which advances the channel
      // marker the way it always has).
      onSelect={(item) => setSelectedConversationId(item.conversationId)}
      onOpenAsk={(ask) => {
        // The cheap correctness patch rides the tap: one targeted answer REQ
        // for this card, so a missed historical answer still clears the badge
        // at the moment of attention. The provider outlives the view switch.
        probeAsk(ask.id);
        onOpenChannel(ask.channelId, ask.id);
      }}
      onClearSelection={() => setSelectedConversationId(null)}
      onMarkRead={() => {
        if (selectedItem) {
          markRead(selectedItem.messages);
        }
      }}
      onMarkUnread={() => {
        if (selectedItem) {
          markUnread(selectedItem.messages);
        }
      }}
      onOpenInChannel={(item) => onOpenChannel(item.channelId, item.message.id)}
    />
  );
}
