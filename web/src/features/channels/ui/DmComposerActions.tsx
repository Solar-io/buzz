import { toast } from "sonner";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { HuddleSession } from "@/features/huddle/HuddleSessionProvider";
import type { RelaySession } from "@/shared/api/relay-session";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import type { ChannelMember, Profile } from "../hooks.ts";
import type { ComposerDictation } from "../useComposerDictation.ts";
import type { PaneToggles } from "../lib/dmPaneToggles.ts";
import { JOIN_CHANNEL_KIND, joinChannelTags } from "../lib/channelAdmin.ts";
import type { PresenceEntry } from "../lib/presence.ts";
import { ChannelActionsBar } from "./ChannelActionsBar.tsx";

/**
 * The route-facing wrapper that instantiates the composer's action bar for
 * the open conversation (Sam, 2026-09-22).
 *
 * Extracted from `repos.tsx` when the dictation and panel-toggle wiring
 * arrived: the bar's props are all route-owned values (the channel, the
 * huddle session, the relay session for the join publish, the pane toggles,
 * the dictation controller), and the instantiation had grown past what the
 * route file's size ceiling allows. Everything here is pass-through plus the
 * one callback that needed a body — the NIP-29 kind-9021 join publish, moved
 * verbatim from the route.
 */
export function DmComposerActions({
  channel,
  title,
  dmAgentPubkey,
  huddleSession,
  session,
  members,
  profiles,
  presence,
  selfPubkey,
  contacts,
  panes,
  dictation,
}: {
  channel: ChannelSummary;
  /** Resolved conversation title (the call button's aria-label). */
  title: string;
  /** The DM's agent counterpart, when it has one (drives Call/🧠). */
  dmAgentPubkey: string | null;
  huddleSession: HuddleSession;
  session: RelaySession;
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  presence?: Map<string, PresenceEntry>;
  selfPubkey?: string | null;
  contacts?: string[];
  panes: PaneToggles;
  dictation: ComposerDictation;
}) {
  return (
    <ChannelActionsBar
      channel={channel}
      title={title}
      onStartAgentCall={
        dmAgentPubkey && channel.type === "dm"
          ? (existingHuddleChannelId) =>
              huddleSession.startAgentCall({
                parentChannelId: channel.id,
                agentPubkey: dmAgentPubkey,
                agentName:
                  profiles.get(dmAgentPubkey)?.displayName ?? dmAgentPubkey,
                existingHuddleChannelId,
              })
          : undefined
      }
      agentCallPhase={huddleSession.agentCallPhase}
      agentCallError={
        huddleSession.agentCallParentChannelId === channel.id
          ? huddleSession.agentCallError
          : null
      }
      members={members}
      profiles={profiles}
      presence={presence}
      selfPubkey={selfPubkey}
      contacts={contacts}
      onJoinChannel={async () => {
        const event = await signNostrEvent({
          kind: JOIN_CHANNEL_KIND,
          tags: joinChannelTags(channel.id),
          content: "",
        });
        const result = await session.publish(event);
        if (result.ok) {
          toast.success(`Joined #${channel.name}`);
        } else {
          toast.error(result.message || "The relay refused the join.");
        }
      }}
      agentPubkey={dmAgentPubkey}
      panes={panes}
      dictation={dictation}
    />
  );
}
