import type { ReactNode } from "react";
import type { MessageBuffer, TimelineMessage } from "../lib/messageBuffer.ts";
export type { ChannelMember, Profile } from "../hooks.ts";
import type { Profile } from "../hooks.ts";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { MarkdownContent } from "./MarkdownContent.tsx";

function formatTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function authorLabel(
  pubkey: string,
  profiles: Map<string, Profile>,
): string {
  return profiles.get(pubkey)?.displayName ?? truncatePubkey(pubkey);
}

export function ChannelTimeline({
  messages,
  profiles,
  replyCounts,
  onOpenThread,
}: {
  messages: MessageBuffer;
  profiles: Map<string, Profile>;
  replyCounts: Map<string, number>;
  onOpenThread: (message: TimelineMessage) => void;
}) {
  if (messages.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-muted-foreground">
        No messages yet. Say something.
      </p>
    );
  }
  let lastAuthor: string | null = null;
  let lastKind = 0;
  const rows: ReactNode[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    // Top-level flow: replies render as counts in Phase 1 (thread view shows
    // the chain); this keeps the main timeline readable.
    if (message.rootId || message.replyToId) {
      lastAuthor = null;
      rows.push(
        <ThreadReplyRow
          key={message.id}
          message={message}
          profiles={profiles}
          onOpenThread={onOpenThread}
        />,
      );
      continue;
    }
    const grouped =
      message.authorPubkey === lastAuthor && message.kind === lastKind;
    lastAuthor = message.authorPubkey;
    lastKind = message.kind;
    rows.push(
      <MessageRow
        key={message.id}
        message={message}
        profiles={profiles}
        grouped={grouped}
        replyCount={replyCounts.get(message.id) ?? 0}
        onOpenThread={onOpenThread}
      />,
    );
  }
  return <div className="flex flex-col px-3 py-2">{rows}</div>;
}

function MessageRow({
  message,
  profiles,
  grouped,
  replyCount,
  onOpenThread,
}: {
  message: TimelineMessage;
  profiles: Map<string, Profile>;
  grouped: boolean;
  replyCount: number;
  onOpenThread: (message: TimelineMessage) => void;
}) {
  const mentionNames = new Set(
    message.mentionPubkeys.map((pubkey) =>
      authorLabel(pubkey, profiles).toLowerCase(),
    ),
  );
  return (
    <div
      className={`group flex gap-3 rounded-md px-2 hover:bg-accent/40 ${
        grouped ? "mt-0.5" : "mt-3"
      }`}
    >
      <div className="w-9 shrink-0">
        {!grouped && (
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground">
            {authorLabel(message.authorPubkey, profiles).slice(0, 2)}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">
              {authorLabel(message.authorPubkey, profiles)}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatTime(message.createdAt)}
            </span>
          </div>
        )}
        <MarkdownContent
          content={message.content}
          mentionNames={mentionNames}
        />
        {replyCount > 0 && (
          <button
            type="button"
            className="mt-0.5 text-xs text-muted-foreground hover:underline"
            onClick={() => onOpenThread(message)}
          >
            {replyCount} {replyCount === 1 ? "reply" : "replies"} →
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Reply in thread"
        className="self-start rounded p-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent"
        onClick={() => onOpenThread(message)}
      >
        ↩
      </button>
    </div>
  );
}

function ThreadReplyRow({
  message,
  profiles,
  onOpenThread,
}: {
  message: TimelineMessage;
  profiles: Map<string, Profile>;
  onOpenThread: (message: TimelineMessage) => void;
}) {
  const rootId = message.rootId ?? message.replyToId ?? "";
  return (
    <button
      type="button"
      className="ml-14 mt-1 block truncate rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent/40 hover:underline"
      onClick={() => {
        // Open the thread by its root; the parent view resolves the message.
        onOpenThread({
          ...message,
          id: rootId,
          rootId: null,
          replyToId: null,
        });
      }}
    >
      ↳ {authorLabel(message.authorPubkey, profiles)}:{" "}
      {plainExcerpt(message.content)}
    </button>
  );
}

function plainExcerpt(content: string): string {
  return content.replace(/[`*_~#>]/g, "").slice(0, 120);
}
