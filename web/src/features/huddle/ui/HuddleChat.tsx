import { useMemo } from "react";

import { useChannelMessages, useProfiles } from "@/features/channels/hooks";
import { ChannelTimeline } from "@/features/channels/ui/ChannelTimeline";
import { Composer } from "@/features/channels/ui/Composer";
import { truncatePubkey } from "@/shared/lib/pubkey";

import { useHuddleSession } from "../HuddleSessionProvider.tsx";

/** The completed message kinds that belong in a voice transcript. */
const TRANSCRIPT_KINDS = new Set([9, 40002]);

/**
 * Chat attached to the real temporary huddle room.
 *
 * The compact form is read-only call chrome and deliberately reads the room
 * itself rather than copying messages into the selected DM. The full form is
 * the existing floating huddle chat, including its composer.
 */
export function HuddleChat({ variant }: { variant: "compact" | "full" }) {
  const { call } = useHuddleSession();
  const channelId = call.channelId;
  const feed = useChannelMessages(channelId);
  const members = useMemo(
    () =>
      call.memberPubkeys.map((pubkey) => ({
        pubkey,
        name: truncatePubkey(pubkey),
      })),
    [call.memberPubkeys],
  );
  const messages = useMemo(() => {
    const roomMessages = feed.messages.filter(
      (message) => message.channelId === channelId && !message.deleted,
    );
    return variant === "compact"
      ? roomMessages.filter((message) => TRANSCRIPT_KINDS.has(message.kind))
      : roomMessages;
  }, [channelId, feed.messages, variant]);
  const authorPubkeys = useMemo(
    () =>
      Array.from(
        new Set([
          ...messages.map((message) => message.authorPubkey),
          ...call.memberPubkeys,
        ]),
      ),
    [call.memberPubkeys, messages],
  );
  const profiles = useProfiles(authorPubkeys);
  const lastMessageId = messages[messages.length - 1]?.id ?? "";
  const tailKey =
    channelId && lastMessageId ? `${channelId}:${lastMessageId}` : null;

  if (channelId === null) {
    return null;
  }

  const timeline = (
    <ChannelTimeline
      flat
      historyExhausted={feed.historyExhausted}
      loadingOlder={feed.loadingOlder}
      messages={messages}
      onLoadOlder={feed.loadOlder}
      onOpenThread={() => {}}
      profiles={profiles}
      reactions={feed.reactions}
      replyCounts={new Map()}
      selfPubkey={call.selfPubkey}
      showActions={false}
      tailKey={tailKey}
    />
  );

  if (variant === "compact") {
    return (
      <section
        aria-label="Call transcript"
        className="mb-2 flex h-36 min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background/30 sm:h-44"
        data-testid="huddle-chat"
        data-variant="compact"
      >
        <h2 className="shrink-0 px-2 py-1 text-sm font-medium text-foreground">
          Call transcript
        </h2>
        <div className="flex min-h-0 flex-1 flex-col">{timeline}</div>
      </section>
    );
  }

  return (
    <section
      aria-label="Call transcript"
      className="flex min-h-0 flex-1 flex-col rounded-lg border border-border"
      data-testid="huddle-chat"
      data-variant="full"
    >
      {timeline}
      <Composer
        draftKey={channelId}
        members={members}
        onClearThread={() => {}}
        profiles={profiles}
        send={call.send}
        strictMentions
        threadRef={null}
      />
    </section>
  );
}
