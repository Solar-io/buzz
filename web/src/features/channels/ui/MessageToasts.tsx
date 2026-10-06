import { useEffect, useRef } from "react";
import type { ChannelActivityEvent, Profile } from "@/features/channels/hooks";
import type { ConversationActivityStore } from "@/features/activity/conversationActivity.ts";
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
import { useRemindMeLater } from "@/features/reminders/ui/RemindMeLaterProvider";
import { notify } from "@/shared/ui/notify";
import { traceUnread } from "@/features/activity/unreadTrace.ts";
import { isUnread, type ReadState } from "@/features/channels/lib/readState.ts";
import { getChannelMarkers } from "@/features/activity/readMarkers.ts";

export interface MessageToastsProps {
  selfPubkey: string | null;
  /** Channel currently open (?c=); null when no conversation is open. */
  selectedId: string | null;
  /** The shell's full channel list — names, types, DM participants. */
  channels: ChannelSummary[];
  /**
   * Live arrivals (I2) from the conversation-activity store — the SAME
   * state every sidebar row, DM or channel, reads (I1).
   */
  onArrival: ConversationActivityStore["onArrival"];
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
  /**
   * Reply: open the conversation at the message, ready to answer it
   * (`?m=&reply=1`). Without it, or for a sample with no event id, Reply
   * opens the conversation.
   */
  onReply?: (channelId: string, messageId: string) => void;
  /** Current read markers, for the trace's `rowUnread` (default: storage). */
  readMarkers?: () => ReadState;
}

/**
 * Top-right toasts on new messages. Mounted ONCE at the shell (next to
 * NotificationRuntime). It registers one handler on the conversation-
 * activity store, which runs only after the store already holds the
 * arrival — so a toasted conversation's row is unread in the same commit
 * (I1). Renders nothing; its whole job is turning arrivals into toasts.
 */
export function MessageToasts({
  selfPubkey,
  selectedId,
  channels,
  onArrival,
  channelPrefs,
  profiles,
  onOpenChannel,
  agentPubkeys,
  onReply,
  readMarkers,
}: MessageToastsProps) {
  const { available, sendToFeedback } = useRemindMeLater();

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
    onReply,
    feedback: available ? sendToFeedback : null,
    readMarkers: readMarkers ?? getChannelMarkers,
  });
  latest.current = {
    selfPubkey,
    selectedId,
    channels,
    channelPrefs,
    profiles,
    onOpenChannel,
    agentPubkeys,
    onReply,
    feedback: available ? sendToFeedback : null,
    readMarkers: readMarkers ?? getChannelMarkers,
  };

  useEffect(() => {
    const handle = (entry: ChannelActivityEvent) => {
      const current = latest.current;
      const isSelf =
        current.selfPubkey != null && entry.pubkey === current.selfPubkey;
      // The unread trace (I3): every toastable arrival, with what the row
      // showed at that moment, so a toast-without-dot report is decidable.
      const trace = (toasted: boolean, reason?: string) =>
        traceUnread({
          type: "arrival",
          id: entry.channelId,
          eventId: entry.eventId ?? null,
          createdAt: entry.createdAt,
          toasted,
          reason,
          rowUnread:
            !isSelf &&
            isUnread(current.readMarkers(), entry.channelId, entry.createdAt),
        });
      const channel = current.channels.find((c) => c.id === entry.channelId);
      if (!channel) {
        // A message for a channel the shell has not loaded yet: no name, no
        // reliable navigation target — the dot machinery will catch up.
        trace(false, "unknown-channel");
        return;
      }
      const isDm = channel.type === "dm";
      const muted = isMuted(current.channelPrefs, entry.channelId);
      const viewing = current.selectedId === entry.channelId;
      if (
        !shouldToastMessage({
          isSelf,
          isViewingChannel: viewing,
          isDm,
          isMuted: muted,
        })
      ) {
        trace(
          false,
          isSelf ? "self" : viewing ? "viewing" : muted ? "muted" : "policy",
        );
        return;
      }
      trace(true);
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
        inThread: entry.inThread === true,
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
        onReply: () =>
          entry.eventId != null && current.onReply
            ? current.onReply(entry.channelId, entry.eventId)
            : current.onOpenChannel(entry.channelId),
        onFeedback:
          entry.eventId != null && current.feedback
            ? () =>
                current.feedback?.({
                  eventId: entry.eventId ?? "",
                  channelId: entry.channelId,
                  preview: entry.preview,
                  authorPubkey: entry.pubkey,
                })
            : undefined,
      });
    };

    // Keyed on the store's STABLE register function: re-registering per
    // render would open a window in which arrivals are dropped.
    return onArrival(handle);
  }, [onArrival]);

  return null;
}
