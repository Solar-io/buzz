import { useEffect, useState, type ReactNode } from "react";
import type { MessageBuffer, TimelineMessage } from "../lib/messageBuffer.ts";
export type { ChannelMember, Profile } from "../hooks.ts";
import type { Profile } from "../hooks.ts";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { fetchSignedMedia } from "@/shared/api/blossom";
import { cn } from "@/shared/lib/cn";
import { formatElapsed } from "@/features/agents/ui/WorkingBadge";
import {
  QUICK_REACTIONS,
  reactionGroups as groupReactions,
  type ReactionGroup,
  type ReactionIndex,
} from "../lib/reactions.ts";
import { MarkdownContent } from "./MarkdownContent.tsx";

const EMPTY_REACTIONS: ReactionIndex = new Map();

function formatDayLabel(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) {
    return "Today";
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }
  return date.toLocaleDateString([], {
    month: "long",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 px-2 py-2">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function UnreadDivider() {
  return (
    <div className="flex items-center gap-3 px-2 py-1">
      <span className="h-px flex-1 bg-border" />
      <span className="rounded-full bg-emerald-600/20 px-2 py-0.5 text-xs font-semibold text-emerald-500">
        New
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

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
  activeRootId,
  flat,
  workingAgent,
  reactions,
  onReact,
  unreadBefore,
  typingNames,
}: {
  messages: MessageBuffer;
  profiles: Map<string, Profile>;
  replyCounts: Map<string, number>;
  onOpenThread: (message: TimelineMessage) => void;
  /** Root id of the currently open thread — highlights it in the timeline. */
  activeRootId?: string | null;
  /**
   * Thread-panel mode: render EVERY message as a full row. Without this,
   * replies render as inline previews under their root — correct for the
   * channel timeline, but inside an open thread the replies ARE the
   * conversation and must show in full.
   */
  flat?: boolean;
  /** When set, renders the "received and working" typing row at the bottom. */
  workingAgent?: { name: string; startedAt: number } | null;
  /** Kind-7 reactions aggregated per target id. */
  reactions?: ReactionIndex;
  /** Send a reaction (emoji) on a message. */
  onReact?: (messageId: string, emoji: string) => void;
  /** createdAt of the first UNSEEN message — renders the unread divider. */
  unreadBefore?: number | null;
  /** Display names of people typing in this channel (footer row). */
  typingNames?: string[];
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
  let lastDay = "";
  let unreadShown = false;
  const rows: ReactNode[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const day = new Date(message.createdAt * 1000).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      lastAuthor = null;
      rows.push(
        <DayDivider
          key={`day:${day}`}
          label={formatDayLabel(message.createdAt)}
        />,
      );
    }
    if (
      !unreadShown &&
      unreadBefore != null &&
      message.createdAt >= unreadBefore
    ) {
      unreadShown = true;
      rows.push(<UnreadDivider key="unread" />);
    }
    // Replies render INLINE under their root (desktop pattern: indented
    // previews with a connector rail, click opens the full thread panel).
    if (!flat && (message.rootId || message.replyToId)) {
      lastAuthor = null;
      continue;
    }
    const replies = flat
      ? []
      : messages.filter(
          (m) => m.rootId === message.id || m.replyToId === message.id,
        );
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
        replyCount={flat ? 0 : (replyCounts.get(message.id) ?? 0)}
        onOpenThread={onOpenThread}
        active={!flat && activeRootId === message.id}
        reactionGroups={groupReactions(
          reactions ?? EMPTY_REACTIONS,
          message.id,
        )}
        onReact={onReact}
      >
        {replies.length > 0 && (
          <ThreadPreview
            replies={replies}
            profiles={profiles}
            onOpenThread={onOpenThread}
            root={message}
          />
        )}
      </MessageRow>,
    );
  }
  // max-w keeps line lengths readable on wide desktops without affecting
  // phone layout (the column is already narrower than the cap there).
  return (
    <div className="mx-auto w-full max-w-3xl px-1 py-2 sm:px-3">
      {rows}
      {typingNames && typingNames.length > 0 && (
        <div className="mt-1 flex items-center gap-2 px-2 py-0.5 text-sm text-muted-foreground">
          <span className="flex gap-0.5">
            <span className="animate-bounce [animation-delay:0ms]">·</span>
            <span className="animate-bounce [animation-delay:150ms]">·</span>
            <span className="animate-bounce [animation-delay:300ms]">·</span>
          </span>
          <span>
            {typingNames.slice(0, 3).join(", ")}
            {typingNames.length > 3 ? ` +${typingNames.length - 3}` : ""}{" "}
            {typingNames.length === 1 ? "is" : "are"} typing
          </span>
        </div>
      )}
      {workingAgent && (
        <div className="mt-2 flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <span>{workingAgent.name} received it and is working</span>
          <span className="tabular-nums">
            ·{" "}
            {formatElapsed(
              workingAgent.startedAt,
              Math.floor(Date.now() / 1000),
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function MessageRow({
  message,
  profiles,
  grouped,
  replyCount,
  onOpenThread,
  active,
  reactionGroups,
  onReact,
  children,
}: {
  message: TimelineMessage;
  profiles: Map<string, Profile>;
  grouped: boolean;
  replyCount: number;
  onOpenThread: (message: TimelineMessage) => void;
  active: boolean;
  reactionGroups: ReactionGroup[];
  onReact?: (messageId: string, emoji: string) => void;
  children?: ReactNode;
}) {
  const mentionNames = new Set(
    message.mentionPubkeys.map((pubkey) =>
      authorLabel(pubkey, profiles).toLowerCase(),
    ),
  );
  return (
    // Desktop message cards: rounded-2xl rows, hover muted wash; the open
    // thread's root keeps a persistent tint so the selection is traceable.
    <div
      className={cn(
        "group flex gap-3 rounded-2xl px-2 transition-colors hover:bg-muted/50",
        grouped ? "mt-0.5" : "mt-3",
        active && "bg-muted/40 hover:bg-muted/40",
      )}
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
        {replyCount > 2 && (
          <button
            type="button"
            className="mt-0.5 text-sm font-medium text-muted-foreground hover:underline"
            onClick={() => onOpenThread(message)}
          >
            View all {replyCount} {replyCount === 1 ? "reply" : "replies"} →
          </button>
        )}
        {reactionGroups.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {reactionGroups.map((group) => (
              <button
                key={group.emoji}
                type="button"
                title={group.pubkeys.length.toString()}
                className="flex items-center gap-1 rounded-full border border-border/60 bg-card/60 px-2 py-0.5 text-sm hover:bg-accent"
                onClick={() => onReact?.(message.id, group.emoji)}
              >
                <span>{group.emoji}</span>
                {group.pubkeys.length > 1 && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {group.pubkeys.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {children}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1 self-start">
        {onReact &&
          QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              className="hidden rounded p-0.5 text-xs text-muted-foreground transition-opacity hover:bg-accent group-hover:block lg:opacity-0 lg:group-hover:opacity-100"
              onClick={() => onReact(message.id, emoji)}
            >
              {emoji}
            </button>
          ))}
        <button
          type="button"
          aria-label="Reply in thread"
          className="rounded p-1 text-xs text-muted-foreground transition-opacity hover:bg-accent lg:opacity-0 lg:group-hover:opacity-100"
          onClick={() => onOpenThread(message)}
        >
          ↩
        </button>
      </div>
    </div>
  );
}

/**
 * Inline thread previews under a root message, in the desktop's shape:
 * indented under the avatar's center line, a connector rail on the left,
 * the newest replies as one-line author + excerpt rows, and the whole block
 * opens the thread panel on click.
 */
function ThreadPreview({
  replies,
  profiles,
  onOpenThread,
  root,
}: {
  replies: TimelineMessage[];
  profiles: Map<string, Profile>;
  onOpenThread: (message: TimelineMessage) => void;
  root: TimelineMessage;
}) {
  const newest = [...replies].sort((a, b) => b.createdAt - a.createdAt);
  const shown = newest.slice(0, 2);
  return (
    <div className="mt-1 ml-[18px] border-l-2 border-border/45 pl-3">
      {shown.map((reply) => (
        <button
          key={reply.id}
          type="button"
          className="flex w-full items-center gap-2 rounded-lg py-0.5 pr-2 text-left hover:bg-muted/50"
          onClick={() => onOpenThread(root)}
        >
          <AuthorAvatar
            pubkey={reply.authorPubkey}
            label={authorLabel(reply.authorPubkey, profiles)}
            picture={profiles.get(reply.authorPubkey)?.avatar}
            size="sm"
          />
          <span className="shrink-0 text-sm font-medium">
            {authorLabel(reply.authorPubkey, profiles)}
          </span>
          <span className="truncate text-sm text-muted-foreground">
            {plainExcerpt(reply.content)}
          </span>
        </button>
      ))}
      {newest.length > shown.length && (
        <button
          type="button"
          className="py-0.5 pr-2 text-sm font-medium text-muted-foreground hover:underline"
          onClick={() => onOpenThread(root)}
        >
          +{newest.length - shown.length} more →
        </button>
      )}
    </div>
  );
}

function plainExcerpt(content: string): string {
  return content.replace(/[`*_~#>]/g, "").slice(0, 120);
}
