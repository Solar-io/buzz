import { useEffect, useMemo, useState } from "react";

import { useChannelMessages, useProfiles } from "@/features/channels/hooks";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { dmDisplayName } from "@/features/dms/lib/dmNaming.ts";
import { useInboxMessages, useInboxReadState } from "../hooks.ts";
import {
  filterInboxItems,
  inboxFilterCounts,
  parseInboxFilter,
  type InboxFilter,
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

  const { messages, loading } = useInboxMessages({ selfPubkey, channels });
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
    () => messages.map((message) => message.authorPubkey),
    [messages],
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
        messages,
        channels: inboxChannels,
        selfPubkey,
        isRead,
      }),
    [messages, inboxChannels, selfPubkey, isRead],
  );
  const counts = useMemo(() => inboxFilterCounts(items), [items]);
  const visibleItems = useMemo(
    () => filterInboxItems(items, filter),
    [items, filter],
  );

  const selectedItem =
    items.find((item) => item.conversationId === selectedConversationId) ??
    null;

  // A selection that the current filter hides is a dead pane: clear it rather
  // than leaving the detail showing a row the list no longer offers.
  useEffect(() => {
    if (
      selectedConversationId !== null &&
      !visibleItems.some(
        (item) => item.conversationId === selectedConversationId,
      )
    ) {
      setSelectedConversationId(null);
    }
  }, [visibleItems, selectedConversationId]);

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
      items={visibleItems}
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
