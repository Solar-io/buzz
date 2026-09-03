import type { Dispatch, SetStateAction } from "react";
import { toast } from "sonner";
import {
  deleteChannel,
  leaveChannel,
  renameChannel,
} from "@/features/channels/hooks";
import { canonicalChannelName } from "@/features/channels/lib/channelAdmin.ts";
import {
  forgetChannel,
  toggleMuted,
  toggleStarred,
  type ChannelPrefs,
} from "@/features/channels/lib/channelPrefs.ts";
import {
  markSeen,
  saveReadState,
  type ReadState,
} from "@/features/channels/lib/readState.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { RelaySession } from "@/shared/api/relay-session";
import type { ContextMenuItem } from "@/shared/ui/ContextMenu";

/** Everything {@link channelMenuItems} needs from the channel shell. */
export interface ChannelMenuDeps {
  /** Live relay session — rename / delete / leave publish through it. */
  session: RelaySession;
  /** Viewer-side starred / muted prefs. */
  channelPrefs: ChannelPrefs;
  setChannelPrefs: Dispatch<SetStateAction<ChannelPrefs>>;
  /** Read markers — "Mark read" writes one. */
  setReadState: Dispatch<SetStateAction<ReadState>>;
  /** Re-REQ the channel list after a relay mutation lands. */
  refreshChannels: () => void;
  /** Channel currently open (?c=), so a delete can navigate away from it. */
  selectedId: string | undefined;
  /** Clear ?c= — called when the channel being deleted is the open one. */
  onCloseChannel: () => void;
}

/** Context menu per channel: star / mark read / mute / leave. */
export function channelMenuItems(
  channel: ChannelSummary,
  {
    session,
    channelPrefs,
    setChannelPrefs,
    setReadState,
    refreshChannels,
    selectedId,
    onCloseChannel,
  }: ChannelMenuDeps,
): ContextMenuItem[] {
  return [
    {
      label: channelPrefs.starred.includes(channel.id)
        ? "Unstar"
        : "Star channel",
      onSelect: () =>
        setChannelPrefs((prefs) => toggleStarred(prefs, channel.id)),
    },
    {
      label: "Mark read",
      onSelect: () => {
        setReadState((previous) => {
          const next = markSeen(previous, channel.id, channel.updatedAt);
          if (next !== previous) {
            saveReadState(next);
          }
          return next;
        });
      },
    },
    {
      label: channelPrefs.muted.includes(channel.id) ? "Unmute" : "Mute",
      onSelect: () =>
        setChannelPrefs((prefs) => toggleMuted(prefs, channel.id)),
    },
    {
      label: "Rename channel…",
      onSelect: () => {
        const next = window.prompt(`Rename #${channel.name}`, channel.name);
        if (next === null) {
          return;
        }
        const canonical = canonicalChannelName(next);
        if (!canonical || canonical === channel.name) {
          return;
        }
        void renameChannel(session, channel.id, canonical).then((result) => {
          if (result.ok) {
            toast.success(`Renamed to #${canonical}`);
            // The relay re-emits the 39000 after the edit; staggered re-REQs
            // cover a missed live fan-out.
            window.setTimeout(refreshChannels, 500);
            window.setTimeout(refreshChannels, 2000);
          } else {
            toast.error(result.message || "The relay refused the rename.");
          }
        });
      },
    },
    {
      label: "Delete channel",
      danger: true,
      onSelect: () => {
        if (
          !window.confirm(
            `Delete #${channel.name} for everyone? This cannot be undone.`,
          )
        ) {
          return;
        }
        void deleteChannel(session, channel.id).then((result) => {
          if (result.ok) {
            toast.success(`Deleted #${channel.name}`);
            setChannelPrefs((prefs) => forgetChannel(prefs, channel.id));
            if (selectedId === channel.id) {
              onCloseChannel();
            }
            window.setTimeout(refreshChannels, 500);
            window.setTimeout(refreshChannels, 2000);
          } else {
            toast.error(
              result.message ||
                "The relay refused the delete (owners only). Try Leave instead.",
            );
          }
        });
      },
    },
    {
      label: "Leave channel",
      danger: true,
      onSelect: () => {
        if (!window.confirm(`Leave #${channel.name}?`)) {
          return;
        }
        void leaveChannel(session, channel.id).then((result) => {
          if (result.ok) {
            setChannelPrefs((prefs) => forgetChannel(prefs, channel.id));
            window.setTimeout(refreshChannels, 500);
            window.setTimeout(refreshChannels, 2000);
          } else {
            toast.error(result.message || "Could not leave the channel.");
          }
        });
      },
    },
  ];
}
