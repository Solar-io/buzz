/**
 * The conversation bound to a project or repository.
 *
 * `buzz-channel` on a kind:30621 (or kind:30617) names a NIP-29 channel by
 * UUID. That is a *reference*, not routing: the relay treats project and repo
 * announcements as global-only kinds, so the channel is fetched by its own
 * `#h` scope exactly as the channel surface fetches it — which is why this
 * panel reuses `useChannelMessages` rather than inventing a second reader.
 *
 * Read-only by design. Composing, threading and reactions belong to the
 * channel surface; duplicating them here would fork the message pipeline for
 * no gain, so the panel links across instead.
 */

import { MessagesSquare } from "lucide-react";
import { useMemo } from "react";

import { useChannelMessages, useProfiles } from "@/features/channels/hooks";
import { MarkdownContent } from "@/features/channels/ui/MarkdownContent";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { relativeTime } from "@/shared/lib/relative-time";

const NO_MENTIONS: ReadonlySet<string> = new Set();

/** Newest last, and only the tail — this is a preview, not the channel. */
const PREVIEW_LIMIT = 30;

export function ProjectConversationPanel({
  channelId,
}: {
  channelId: string | null;
}) {
  const feed = useChannelMessages(channelId);
  const visible = useMemo(
    () =>
      feed.messages.filter((message) => !message.deleted).slice(-PREVIEW_LIMIT),
    [feed.messages],
  );
  const authors = useMemo(
    () => [...new Set(visible.map((message) => message.authorPubkey))],
    [visible],
  );
  const profiles = useProfiles(authors);

  if (!channelId) {
    return (
      <div
        className="rounded-lg border border-dashed border-border/70 px-4 py-10 text-center"
        data-testid="project-conversation-empty"
      >
        <MessagesSquare className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-2 text-sm text-muted-foreground">
          No channel is bound to this project.
        </p>
        <p className="mt-1 text-2xs text-muted-foreground">
          A <code className="font-mono">buzz-channel</code> tag on the project
          event binds one.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="project-conversation">
      {visible.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">
          Nothing has been said in this channel yet.
        </p>
      ) : (
        visible.map((message) => (
          <div
            className="flex flex-col gap-0.5 rounded-lg border border-border/50 bg-card/60 px-3 py-2"
            key={message.id}
          >
            <span className="text-2xs text-muted-foreground">
              {profiles.get(message.authorPubkey)?.displayName ??
                truncatePubkey(message.authorPubkey)}{" "}
              · {relativeTime(message.createdAt)}
            </span>
            <MarkdownContent
              content={message.content}
              imetaByUrl={message.imetaByUrl}
              mentionNames={NO_MENTIONS}
            />
          </div>
        ))
      )}
    </div>
  );
}
