import { useEffect, useState, type ReactNode } from "react";
import type { MessageBuffer, TimelineMessage } from "../lib/messageBuffer.ts";
export type { ChannelMember, Profile } from "../hooks.ts";
import type { Profile } from "../hooks.ts";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { fetchSignedMedia } from "@/shared/api/blossom";
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

/** Deterministic hue from a pubkey — the identicon fallback color. */
function pubkeyHue(pubkey: string): number {
  let hash = 0;
  for (let i = 0; i < pubkey.length; i++) {
    hash = (hash * 31 + pubkey.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/**
 * Author avatar: the profile picture when one is published (relay media is
 * auth-gated, so it goes through the signed fetch), else a hue-hash initials
 * circle in the desktop client's identicon style. Exported for the sidebar's
 * DM rows.
 */
export function AuthorAvatar({
  pubkey,
  label,
  picture,
  size = "md",
}: {
  pubkey: string;
  label: string;
  picture?: string;
  size?: "sm" | "md";
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setObjectUrl(null);
    if (!picture) {
      return;
    }
    fetchSignedMedia(picture)
      .then((url) => {
        if (!cancelled) {
          setObjectUrl(url);
        }
      })
      .catch(() => {
        // Unavailable media falls back to the identicon below.
      });
    return () => {
      cancelled = true;
    };
  }, [picture]);
  const box = size === "sm" ? "h-5 w-5 text-[10px]" : "h-9 w-9 text-sm";
  if (objectUrl) {
    return (
      <img
        src={objectUrl}
        alt=""
        className={`rounded-full object-cover ${box}`}
      />
    );
  }
  return (
    <div
      className={`flex items-center justify-center rounded-full font-semibold text-white ${box}`}
      style={{ backgroundColor: `hsl(${pubkeyHue(pubkey)}, 45%, 42%)` }}
    >
      {label.slice(0, 2)}
    </div>
  );
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
  // max-w keeps line lengths readable on wide desktops without affecting
  // phone layout (the column is already narrower than the cap there).
  return (
    <div className="mx-auto w-full max-w-3xl px-1 py-2 sm:px-3">{rows}</div>
  );
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
          <AuthorAvatar
            pubkey={message.authorPubkey}
            label={authorLabel(message.authorPubkey, profiles)}
            picture={profiles.get(message.authorPubkey)?.avatar}
          />
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
        className="self-start rounded p-1 text-xs text-muted-foreground transition-opacity hover:bg-accent lg:opacity-0 lg:group-hover:opacity-100"
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
