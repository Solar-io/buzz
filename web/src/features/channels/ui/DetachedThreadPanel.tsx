import { useMemo } from "react";
import { useChannelMessages, useProfiles } from "@/features/channels/hooks";
import { useMessageActions } from "@/features/channels/lib/useMessageActions.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { useHuddleSession } from "@/features/huddle/HuddleSessionProvider";
import { useRouteMentionMembers } from "@/features/huddle/useHuddleMentionMembers";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { threadOriginLabel } from "../lib/openThread.ts";
import { ThreadPanel } from "./ThreadPanel";

/**
 * A thread kept open after the viewer moved to another conversation or view
 * (lib/openThread.ts). The route's buffer, members and send belong to the
 * OPEN channel, so this pane brings its own for the thread's channel: the
 * same `useChannelMessages` view over the shared timeline store (it paints
 * from memory — the thread was on screen a moment ago), the same mention
 * roster, and a send bound to the thread's channel, so a reply lands in the
 * thread and never in the conversation beside it.
 *
 * Renders nothing until the root resolves (or if it never does, e.g. the
 * channel was left); the viewer's open-thread state is untouched either way.
 */
export function DetachedThreadPanel({
  channel,
  rootId,
  selfPubkey,
  agentPubkeys,
  onClose,
  onOpenChannel,
}: {
  channel: ChannelSummary;
  rootId: string;
  selfPubkey: string | null;
  agentPubkeys: ReadonlySet<string>;
  onClose: () => void;
  /** Jump to the thread's own channel (the pane's "in #channel" link). */
  onOpenChannel: () => void;
}) {
  const { session } = useRelaySession();
  const huddleSession = useHuddleSession();
  const { messages } = useChannelMessages(channel.id);
  const { send } = useMessageActions({
    session,
    current: channel,
    channelId: channel.id,
    selfPubkey,
  });
  const { members, strictMentions } = useRouteMentionMembers(
    channel,
    selfPubkey,
    huddleSession.call,
  );
  const profiles = useProfiles(
    useMemo(
      () =>
        messages
          .map((m) => m.authorPubkey)
          .concat(members.map((m) => m.pubkey)),
      [messages, members],
    ),
  );
  const root = messages.find((m) => m.id === rootId) ?? null;
  if (!root) {
    return null;
  }
  return (
    <ThreadPanel
      root={root}
      buffer={messages}
      members={members}
      profiles={profiles}
      agentPubkeys={agentPubkeys}
      strictMentions={strictMentions}
      selfPubkey={selfPubkey}
      onClose={onClose}
      send={send}
      // Beside another conversation or a full-page view: say whose thread
      // this is, and keep the ✕ visible (the Replies toggle there is not
      // this thread's).
      origin={{
        label: threadOriginLabel(channel, selfPubkey, profiles),
        onOpen: onOpenChannel,
      }}
    />
  );
}
