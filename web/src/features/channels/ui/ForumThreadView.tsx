import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquareText } from "lucide-react";
import type { ChannelSummary } from "../lib/channelFromEvent.ts";
import type { TimelineMessage } from "../lib/messageBuffer.ts";
import { FORUM_COMMENT_KIND } from "../lib/forum.ts";
import {
  QUICK_REACTIONS,
  reactionGroups as groupReactions,
  type ReactionGroup,
  type ReactionIndex,
} from "../lib/reactions.ts";
import type { ChannelMember, Profile } from "../hooks.ts";
import { useForumThread } from "../hooks.ts";
import {
  replyTargetMessage,
  resolveThreadReplyRef,
} from "../lib/threadTarget.ts";
import { cn } from "@/shared/lib/cn";
import { relativeTime } from "@/shared/lib/relative-time";
import { AuthorAvatar, authorLabel } from "./ChannelTimeline.tsx";
import { Composer } from "./Composer.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import type { ForumSend } from "./ForumView.tsx";

/**
 * One forum thread (desktop ForumThreadPanel shape): "Back to posts" header,
 * the root post as a full card, an "N replies" divider, every reply in
 * order, and a bottom composer that publishes kind-45003 comments. Replies
 * are TimelineMessages, so kind-9 appends and 45003 comments render
 * identically.
 */
export function ForumThreadView({
  channel,
  postId,
  fallbackRoot,
  selfPubkey,
  profiles,
  members,
  feedReactions,
  onBack,
  onReact,
  onDelete,
  send,
}: {
  channel: ChannelSummary;
  postId: string;
  /**
   * The root as the posts list knows it — the panel renders immediately
   * from it while useForumThread's own fetch lands, then that copy (the
   * fresher one) takes over.
   */
  fallbackRoot: TimelineMessage | null;
  selfPubkey: string | null;
  profiles: Map<string, Profile>;
  members: ChannelMember[];
  /** Kind-7 reactions from the main feed subscription (channel-scoped). */
  feedReactions: ReactionIndex;
  onBack: () => void;
  onReact: (messageId: string, emoji: string) => void;
  onDelete: (messageId: string) => void;
  send: ForumSend;
}) {
  const { root: fetchedRoot, replies } = useForumThread(channel.id, postId);
  const root = fetchedRoot ?? fallbackRoot;
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastReplyId = replies.length > 0 ? replies[replies.length - 1].id : "";
  // Open (and keep) the thread on the newest reply — long alert threads read
  // from the bottom (same intent as the stream ThreadPanel's auto-tail).
  // biome-ignore lint/correctness/useExhaustiveDependencies: lastReplyId/root id are the re-tail triggers by design
  useEffect(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTo({ top: node.scrollHeight });
    }
  }, [lastReplyId, root?.id]);

  // Which reply the comment is a reply TO. Null = the post itself, whose
  // NIP-10 parent is the post id. Cleared when a different post opens.
  const [selectedReplyId, setSelectedReplyId] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: postId is the reset trigger, not a value read inside the effect
  useEffect(() => {
    setSelectedReplyId(null);
  }, [postId]);

  // Comments are desktop-exact kind 45003 with the same NIP-10 markers
  // sendChannelMessage already builds (single reply marker when replying
  // to the root, root+reply pair when replying to a reply). The `reply`
  // marker names the message the reader picked, defaulting to the post —
  // never "whatever arrived last", which is what it used to be.
  const threadRef = resolveThreadReplyRef(postId, replies, selectedReplyId);
  const target = replyTargetMessage(postId, replies, selectedReplyId);
  const targetLabel = target
    ? authorLabel(target.authorPubkey, profiles)
    : null;
  const sendComment: ForumSend = (options) =>
    send({
      ...options,
      kind: FORUM_COMMENT_KIND,
      threadRef,
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-border px-2 sm:px-4">
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onBack}
        >
          <span aria-hidden="true">←</span> Back to posts
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" ref={scrollRef}>
        <div className="mx-auto w-full max-w-3xl px-1 sm:px-3">
          {root ? (
            <ForumMessageCard
              message={root}
              profiles={profiles}
              full
              reactionGroups={groupReactions(feedReactions, root.id)}
              canDelete={selfPubkey === root.authorPubkey}
              onReact={onReact}
              onDelete={(messageId) => {
                // Desktop closes the panel once the root delete is sent.
                onDelete(messageId);
                onBack();
              }}
            />
          ) : (
            <p className="p-8 text-center text-sm text-muted-foreground">
              Loading post…
            </p>
          )}
          <div className="my-3 flex items-center gap-2 px-2 text-sm font-medium text-muted-foreground">
            <MessageSquareText className="h-4 w-4" aria-hidden="true" />
            {replies.length} {replies.length === 1 ? "reply" : "replies"}
          </div>
          <div className="divide-y divide-border/40">
            {replies
              .filter((reply) => !reply.deleted)
              .map((reply) => (
                <ForumMessageCard
                  key={reply.id}
                  message={reply}
                  profiles={profiles}
                  reactionGroups={groupReactions(feedReactions, reply.id)}
                  canDelete={selfPubkey === reply.authorPubkey}
                  onReact={onReact}
                  onDelete={onDelete}
                  onReply={setSelectedReplyId}
                  replying={selectedReplyId === reply.id}
                  compact
                />
              ))}
            {replies.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                No replies yet. Be the first to respond.
              </p>
            )}
          </div>
        </div>
      </div>
      <div className="border-t border-border">
        <Composer
          members={members}
          profiles={profiles}
          threadRef={threadRef}
          replyTargetLabel={targetLabel}
          onClearThread={() => {
            // Esc steps back one level: drop a mid-thread target first, and
            // only leave the thread once the composer is aimed at the post.
            if (selectedReplyId) {
              setSelectedReplyId(null);
              return;
            }
            onBack();
          }}
          placeholder="Reply to this post..."
          send={sendComment}
        />
      </div>
    </div>
  );
}

/**
 * A root post or a reply: avatar, author, relative time, markdown (full for
 * the root, always full here — truncation belongs to the posts list), and
 * the reaction chips + hover quick-reactions the timeline rows use.
 */
function ForumMessageCard({
  message,
  profiles,
  full,
  compact,
  reactionGroups,
  canDelete,
  onReact,
  onDelete,
  onReply,
  replying,
}: {
  message: TimelineMessage;
  profiles: Map<string, Profile>;
  /** Root card renders a slightly larger frame; replies stay tight. */
  full?: boolean;
  compact?: boolean;
  reactionGroups: ReactionGroup[];
  canDelete: boolean;
  onReact: (messageId: string, emoji: string) => void;
  onDelete: (messageId: string) => void;
  /** Aim the composer at THIS message (sets the NIP-10 `reply` marker). */
  onReply?: (messageId: string) => void;
  /** This card is the composer's current reply target. */
  replying?: boolean;
}) {
  const mentionNames = useMemo(
    () =>
      new Set(
        message.mentionPubkeys.map((pubkey) =>
          authorLabel(pubkey, profiles).toLowerCase(),
        ),
      ),
    [message.mentionPubkeys, profiles],
  );
  return (
    <div className={full ? "group px-2 py-4" : "group px-2 py-3"}>
      <div className="flex gap-3">
        <div className="w-9 shrink-0">
          <AuthorAvatar
            pubkey={message.authorPubkey}
            label={authorLabel(message.authorPubkey, profiles)}
            picture={profiles.get(message.authorPubkey)?.avatar}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span
              className={full ? "text-sm font-semibold" : "text-sm font-medium"}
            >
              {authorLabel(message.authorPubkey, profiles)}
            </span>
            <span className="text-xs text-muted-foreground">
              {relativeTime(message.createdAt)}
            </span>
            {message.edited && (
              <span className="text-xs text-muted-foreground/70">(edited)</span>
            )}
          </div>
          <div className="mt-1">
            {message.deleted ? (
              <p className="text-sm italic text-muted-foreground">
                This message was deleted.
              </p>
            ) : (
              <MarkdownContent
                content={message.content}
                mentionNames={mentionNames}
              />
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {reactionGroups.map((group) => (
              <button
                key={group.emoji}
                type="button"
                title={group.pubkeys.length.toString()}
                className="flex items-center gap-1 rounded-full border border-border/60 bg-card/60 px-2 py-0.5 text-sm hover:bg-accent"
                onClick={() => onReact(message.id, group.emoji)}
              >
                <span>{group.emoji}</span>
                {group.pubkeys.length > 1 && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {group.pubkeys.length}
                  </span>
                )}
              </button>
            ))}
            <span className="hidden items-center gap-0.5 group-hover:flex">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`React ${emoji}`}
                  className="rounded p-0.5 text-xs text-muted-foreground hover:bg-accent"
                  onClick={() => onReact(message.id, emoji)}
                >
                  {emoji}
                </button>
              ))}
            </span>
          </div>
        </div>
        {onReply && (
          <button
            type="button"
            aria-label="Reply to this message"
            title="Reply to this message"
            className={cn(
              "shrink-0 self-start rounded p-1 text-xs transition-opacity hover:bg-accent",
              replying
                ? "bg-accent text-foreground"
                : "text-muted-foreground lg:opacity-0 lg:group-hover:opacity-100",
            )}
            onClick={() => onReply(message.id)}
          >
            ↩
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            aria-label={compact ? "Delete reply" : "Delete post"}
            className="shrink-0 self-start rounded p-1 text-xs text-muted-foreground transition-opacity hover:bg-accent lg:opacity-0 lg:group-hover:opacity-100"
            onClick={() => {
              if (window.confirm("Delete this message?")) {
                onDelete(message.id);
              }
            }}
          >
            🗑
          </button>
        )}
      </div>
    </div>
  );
}
