import { type ComponentProps, useState } from "react";
import { createPortal } from "react-dom";
import { Settings } from "lucide-react";
import { toast } from "sonner";
import { useChannelTemplates } from "@/features/channel-templates/useChannelTemplates";
import { useChannelCanvas } from "@/features/canvas/useChannelCanvas";
import { useFileTabs } from "@/features/shelf/FileTabsProvider";
import { CHANNEL_CANVAS_KEY } from "@/features/shelf/lib/fileTabs.ts";
import {
  evictDeletedChannel,
  type ChannelMenuDeps,
} from "@/features/sidebar/lib/channelMenuItems.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { usePhoneBarSlot, usePhoneLayout } from "@/shared/layout/AppShell";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { deleteChannel, leaveChannel, renameChannel } from "../../hooks.ts";
import {
  deleteChannelVerdict,
  JOIN_CHANNEL_KIND,
  joinChannelTags,
} from "../../lib/channelAdmin.ts";
import { editMetadataTags } from "../../lib/channelMetadataEdit.ts";
import { toggleMuted } from "../../lib/channelPrefs.ts";
import { ChannelHeader } from "../ChannelHeader";
import { ChannelMembersButton } from "../ChannelMembersButton";
import {
  ChannelSettingsSheet,
  type ChannelSettingsTab,
} from "./ChannelSettingsSheet";

type HeaderProps = ComponentProps<typeof ChannelHeader> & {
  admin: ChannelMenuDeps;
};

/** Owns the sheet once for desktop, scratch headers and the phone top bar. */
export function ChannelSettingsHeader(props: HeaderProps) {
  const [tab, setTab] = useState<ChannelSettingsTab | null>(null);
  const phone = usePhoneLayout();
  const slot = usePhoneBarSlot();
  const onOpenSettings = (next: ChannelSettingsTab) => setTab(next);
  const controls =
    props.channel.type === "dm" ? null : (
      <div className="flex items-center gap-1">
        <ChannelMembersButton
          channelId={props.channel.id}
          members={props.members}
          profiles={props.profiles}
          selfPubkey={props.selfPubkey}
          agentPubkeys={props.agentPubkeys}
          onOpenMembers={() => setTab("members")}
        />
        <button
          type="button"
          aria-label="Channel settings"
          data-testid="channel-settings-trigger"
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-accent"
          onClick={() => setTab("about")}
        >
          <Settings aria-hidden className="size-4" />
        </button>
      </div>
    );
  return (
    <>
      <ChannelHeader {...props} onOpenSettings={onOpenSettings} />
      {phone && slot && createPortal(controls, slot)}
      {tab !== null && (
        <OpenChannelSettings
          key={props.channel.id}
          {...props}
          initialTab={tab}
          onClose={() => setTab(null)}
        />
      )}
    </>
  );
}

function OpenChannelSettings({
  channel,
  members,
  agentPubkeys,
  selfPubkey,
  admin,
  initialTab,
  onClose,
}: HeaderProps & {
  initialTab: ChannelSettingsTab;
  onClose: () => void;
}) {
  const { session } = useRelaySession();
  const templates = useChannelTemplates();
  const canvas = useChannelCanvas(channel.id);
  const files = useFileTabs();
  const checked = async (result: { ok: boolean; message: string }) => {
    if (!result.ok)
      throw new Error(result.message || "The relay refused the change.");
    // The relay may store the replacement after its publish ack. These
    // bounded replays supplement the selected-channel live subscription.
    window.setTimeout(admin.refreshChannels, 500);
    window.setTimeout(admin.refreshChannels, 1500);
  };
  return (
    <ChannelSettingsSheet
      channel={channel}
      initialTab={initialTab}
      onClose={onClose}
      memberCount={members.length}
      agentCount={
        members.filter((member) => agentPubkeys.has(member.pubkey)).length
      }
      isMember={members.some((member) => member.pubkey === selfPubkey)}
      muted={admin.channelPrefs.muted.includes(channel.id)}
      onEdit={async (patch) => {
        if (
          channel.archived &&
          !(patch.archived === false && Object.keys(patch).length === 1)
        )
          throw new Error("Unarchive the channel to make changes.");
        if (patch.name !== undefined && Object.keys(patch).length === 1) {
          await checked(await renameChannel(session, channel.id, patch.name));
        } else {
          const event = await signNostrEvent({
            kind: 9002,
            tags: editMetadataTags(channel.id, patch),
            content: "",
          });
          await checked(await session.publish(event));
        }
      }}
      onDelete={async () => {
        if (
          !window.confirm(
            `Delete #${channel.name} for everyone? This cannot be undone.`,
          )
        )
          return;
        const verdict = deleteChannelVerdict(
          channel.id,
          await deleteChannel(session, channel.id),
        );
        if (verdict.outcome === "refused") throw new Error(verdict.message);
        evictDeletedChannel(channel.id, admin);
        onClose();
        admin.onCloseChannel();
      }}
      onLeave={async () => {
        if (!window.confirm(`Leave #${channel.name}?`)) return;
        await checked(await leaveChannel(session, channel.id));
        onClose();
        admin.onCloseChannel();
      }}
      onJoin={async () => {
        const event = await signNostrEvent({
          kind: JOIN_CHANNEL_KIND,
          tags: joinChannelTags(channel.id),
          content: "",
        });
        await checked(await session.publish(event));
      }}
      onMute={() =>
        admin.setChannelPrefs((prefs) => toggleMuted(prefs, channel.id))
      }
      onCanvas={() => {
        files?.select(CHANNEL_CANVAS_KEY);
        files?.show(true);
        onClose();
      }}
      onTemplate={async () => {
        if (canvas.phase !== "ready")
          throw new Error(
            "The canvas is still loading. Try again in a moment.",
          );
        const issue = await templates.create({
          name: channel.name,
          description: channel.purpose || channel.topic || channel.about,
          channelType: channel.type === "forum" ? "forum" : "stream",
          visibility: channel.isPrivate ? "private" : "open",
          canvasTemplate: canvas.doc?.content ?? "",
          agents: { personas: [], teams: [] },
        });
        if (issue) throw new Error(issue);
        toast.success(`Saved ${channel.name} as a template in this browser.`);
      }}
    />
  );
}
