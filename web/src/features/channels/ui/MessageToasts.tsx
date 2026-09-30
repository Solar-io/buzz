import { useEffect, useRef } from "react";
import type { Profile } from "@/features/channels/hooks";
import type {
  ChannelActivityEvent,
  UseChannelActivityResult,
} from "@/features/channels/hooks";
import { useChannelActivity } from "@/features/channels/hooks";
import {
  isMuted,
  type ChannelPrefs,
} from "@/features/channels/lib/channelPrefs.ts";
import {
  messageToastParts,
  shouldToastMessage,
} from "@/features/channels/lib/messageToast.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { dmDisplayName } from "@/features/dms/lib/dmNaming.ts";
import { readAuthorName } from "@/features/notifications/hooks";
import { notify } from "@/shared/ui/notify";

export interface MessageToastsProps {
  selfPubkey: string | null;
  /** Channel currently open (?c=); null when no conversation is open. */
  selectedId: string | null;
  /** The shell's full channel list — names, types, DM participants. */
  channels: ChannelSummary[];
  /**
   * Live arrivals from the shell's non-DM activity feed — the SAME
   * subscription the sidebar's unread dots read (useChannelActivity).
   */
  channelLiveEvents: UseChannelActivityResult["onLiveEvent"];
  /** DM channel ids; the component runs its own activity feed over these. */
  dmChannelIds: string[];
  /** Viewer's channel prefs — muted channels never toast. */
  channelPrefs: ChannelPrefs;
  /** Known profiles (DM peers at minimum), for DM and sender names. */
  profiles: Map<string, Profile>;
  /**
   * Open a conversation — wire this to the same handler the sidebar's
   * actions.onSelectChannel uses, so a toast click lands exactly where a
   * row click lands.
   */
  onOpenChannel: (channelId: string) => void;
  /** Known agents — their toasts carry the hex mark instead of a disc. */
  agentPubkeys?: ReadonlySet<string>;
}

/**
 * Top-right toasts on new messages. Mounted ONCE at the shell (next to
 * NotificationRuntime): the channel side consumes the shell's shared
 * activity feed via {@link MessageToastsProps.channelLiveEvents}, the DM side
 * runs its own `useChannelActivity` over the DM ids (the DM rows keep their
 * separate recency feed — this one exists for live arrival events only).
 * Renders nothing; its whole job is turning live feed events into toasts.
 */
export function MessageToasts({
  selfPubkey,
  selectedId,
  channels,
  channelLiveEvents,
  dmChannelIds,
  channelPrefs,
  profiles,
  onOpenChannel,
  agentPubkeys,
}: MessageToastsProps) {
  const dmFeed = useChannelActivity(dmChannelIds);
  // The registration effect keys on the STABLE register functions — keying
  // on `dmFeed` (a fresh object per render) would unregister and re-register
  // the handler on every activity update, opening a window to drop arrivals.
  const dmLiveEvents = dmFeed.onLiveEvent;

  // Everything the arrival handler reads but must not re-register for:
  // props change per render, the handler is registered for the feed's life.
  const latest = useRef({
    selfPubkey,
    selectedId,
    channels,
    channelPrefs,
    profiles,
    onOpenChannel,
    agentPubkeys,
  });
  latest.current = {
    selfPubkey,
    selectedId,
    channels,
    channelPrefs,
    profiles,
    onOpenChannel,
    agentPubkeys,
  };

  useEffect(() => {
    const onArrival = (entry: ChannelActivityEvent) => {
      const current = latest.current;
      const channel = current.channels.find((c) => c.id === entry.channelId);
      if (!channel) {
        // A message for a channel the shell has not loaded yet: no name, no
        // reliable navigation target — the dot machinery will catch up.
        return;
      }
      const isDm = channel.type === "dm";
      if (
        !shouldToastMessage({
          isSelf:
            current.selfPubkey != null && entry.pubkey === current.selfPubkey,
          isViewingChannel: current.selectedId === entry.channelId,
          isDm,
          isMuted: isMuted(current.channelPrefs, entry.channelId),
        })
      ) {
        return;
      }
      const copy = messageToastParts({
        channelName: isDm
          ? dmDisplayName(
              channel.participantPubkeys,
              current.selfPubkey ?? "",
              current.profiles,
            )
          : channel.name,
        isDm,
        senderName:
          current.profiles.get(entry.pubkey)?.displayName ??
          readAuthorName(entry.pubkey),
        preview: entry.preview,
      });
      // Six seconds with a timer line (notify.ts AUTO_DISMISS_MS).
      notify.message({
        sender: copy.sender,
        senderPubkey: entry.pubkey,
        agent:
          current.agentPubkeys?.has(entry.pubkey) === true ||
          current.agentPubkeys?.has(entry.pubkey.toLowerCase()) === true,
        context: copy.context,
        preview: copy.preview,
        onOpen: () => current.onOpenChannel(entry.channelId),
      });
    };

    const unregisterChannel = channelLiveEvents(onArrival);
    const unregisterDm = dmLiveEvents(onArrival);
    return () => {
      unregisterChannel();
      unregisterDm();
    };
  }, [channelLiveEvents, dmLiveEvents]);

  return null;
}
