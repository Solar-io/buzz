import { useEffect, useMemo, useState } from "react";
import { MessageSquareText } from "lucide-react";
import type { ChannelSummary } from "../lib/channelFromEvent.ts";
import type { TimelineMessage } from "../lib/messageBuffer.ts";
import { forumPosts, FORUM_POST_KIND } from "../lib/forum.ts";
import {
  QUICK_REACTIONS,
  reactionGroups as groupReactions,
  type ReactionGroup,
  type ReactionIndex,
} from "../lib/reactions.ts";
import type { ChannelMember, Profile } from "../hooks.ts";
import { useForumPosts } from "../hooks.ts";
import { relativeTime } from "@/shared/lib/relative-time";
import { AuthorAvatar, authorLabel } from "./ChannelTimeline.tsx";
import { Composer } from "./Composer.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { ForumThreadView } from "./ForumThreadView.tsx";

/** Composer send, extended with the event kind the forum views publish. */
export type ForumSend = (options: {
  content: string;
  mentionPubkeys: string[];
  threadRef: { rootId: string; replyToId: string } | null;
  mediaTags: string[][];
  kind?: number;
}) => Promise<{ ok: boolean; message: string }>;

/**
 * Forum channel body (desktop ForumView shape, web timeline idioms): a
 * "Start a new post..." card that expands into the shared Composer, a
 * newest-first list of post cards (kind-45001 posts and kind-9 thread roots
 * alike — the read superset that makes live #alerts traffic render), and an
 * inline ForumThreadView when a post is selected.
 */
export function ForumView({
  channel,
  selfPubkey,
  profiles,
  members,
  feedReactions,
  replyCounts,
  selectedPostId,
  onSelectPost,
  onClosePost,
  onReact,
  onDelete,
  send,
}: {
  channel: ChannelSummary;
  selfPubkey: string | null;
  profiles: Map<string, Profile>;
  members: ChannelMember[];
  /** Kind-7 reactions from the main feed subscription (channel-scoped). */
  feedReactions: ReactionIndex;
  /** Reply counts per root id from the main feed buffer. */
  replyCounts: Map<string, number>;
  selectedPostId: string | null;
  onSelectPost: (postId: string) => void;
  onClosePost: () => void;
  onReact: (messageId: string, emoji: string) => void;
  onDelete: (messageId: string) => void;
  send: ForumSend;
}) {
  const { messages: forumBuffer, loading } = useForumPosts(channel.id);
  const posts = useMemo(() => forumPosts(forumBuffer), [forumBuffer]);
  // The posts subscription's kind list also matches recent replies; use
  // them for the "last reply" stamp without polluting the posts list.
  const lastReplyAt = useMemo(() => {
    const stamps = new Map<string, number>();
    for (const message of forumBuffer) {
      const root = message.rootId ?? message.replyToId;
      if (root !== null && !message.deleted) {
        stamps.set(root, Math.max(stamps.get(root) ?? 0, message.createdAt));
      }
    }
    return stamps;
  }, [forumBuffer]);
  const [composerOpen, setComposerOpen] = useState(false);
  // Reset the composer card when the channel changes (the view stays mounted
  // while the browser steps between forum channels).
  // biome-ignore lint/correctness/useExhaustiveDependencies: channel.id is the reset trigger by design
  useEffect(() => {
    setComposerOpen(false);
  }, [channel.id]);
  const isMember =
    selfPubkey !== null && members.some((m) => m.pubkey === selfPubkey);
  const canPost = isMember && !channel.archived;
  // New posts are desktop-exact kind 45001: top-level, h tag only.
  const sendPost: ForumSend = (options) =>
    send({ ...options, kind: FORUM_POST_KIND, threadRef: null });

  if (selectedPostId !== null) {
    return (
      <ForumThreadView
        channel={channel}
        postId={selectedPostId}
        fallbackRoot={posts.find((p) => p.id === selectedPostId) ?? null}
        selfPubkey={selfPubkey}
        profiles={profiles}
        members={members}
        feedReactions={feedReactions}
        onBack={onClosePost}
        onReact={onReact}
        onDelete={onDelete}
        send={send}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border p-4">
        <div className="mx-auto w-full max-w-3xl">
          {composerOpen ? (
            <div className="rounded-2xl border border-border bg-card p-3">
              <p className="mb-1 flex items-center gap-2 px-1 text-xs text-muted-foreground">
                New post
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => setComposerOpen(false)}
                >
                  cancel
                </button>
              </p>
              <Composer
                members={members}
                profiles={profiles}
                threadRef={null}
                onClearThread={() => setComposerOpen(false)}
                onSent={() => setComposerOpen(false)}
                placeholder="Write your post..."
                send={sendPost}
              />
            </div>
          ) : (
            <button
              type="button"
              className="w-full rounded-2xl border border-dashed border-border/80 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:border-border hover:bg-accent/30 hover:text-foreground disabled:cursor-default disabled:hover:border-border/80 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
              disabled={!canPost}
              onClick={() => setComposerOpen(true)}
            >
              {channel.archived
                ? "This forum is archived."
                : !isMember
                  ? "Join this forum to create posts."
                  : "Start a new post..."}
            </button>
          )}
        </div>
      </div>
      <div className="buzz-content-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-1 py-2 sm:px-3">
          {loading && posts.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              Loading posts…
            </p>
          ) : posts.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
              <p className="text-sm font-medium text-foreground/70">
                No posts yet
              </p>
              <p className="text-xs text-muted-foreground">
                Start a discussion by creating the first post.
              </p>
            </div>
          ) : (
            posts
              .filter((post) => !post.deleted)
              .map((post) => (
                <ForumPostCard
                  key={post.id}
                  post={post}
                  profiles={profiles}
                  replyCount={replyCounts.get(post.id) ?? 0}
                  lastReplyAt={lastReplyAt.get(post.id) ?? null}
                  reactionGroups={groupReactions(feedReactions, post.id)}
                  canDelete={selfPubkey === post.authorPubkey}
                  onReact={onReact}
                  onDelete={onDelete}
                  onSelect={() => onSelectPost(post.id)}
                />
              ))
          )}
        </div>
      </div>
    </div>
  );
}

/** One post in the list: full-card click opens the thread (desktop shape). */
function ForumPostCard({
  post,
  profiles,
  replyCount,
  lastReplyAt,
  reactionGroups,
  canDelete,
  onReact,
  onDelete,
  onSelect,
}: {
  post: TimelineMessage;
  profiles: Map<string, Profile>;
  replyCount: number;
  lastReplyAt: number | null;
  reactionGroups: ReactionGroup[];
  canDelete: boolean;
  onReact: (messageId: string, emoji: string) => void;
  onDelete: (messageId: string) => void;
  onSelect: () => void;
}) {
  const mentionNames = new Set(
    post.mentionPubkeys.map((pubkey) =>
      authorLabel(pubkey, profiles).toLowerCase(),
    ),
  );
  // Desktop preview contract: full markdown, truncated at 200 characters.
  const preview =
    post.content.length > 200
      ? `${post.content.slice(0, 200)}...`
      : post.content;
  return (
    // A real <button> cannot wrap the card — the reaction chips and delete
    // action are themselves buttons, and nested interactive elements are
    // invalid HTML. The card is the desktop's div[role=button] instead.
    // biome-ignore lint/a11y/useSemanticElements: nested buttons (reactions, delete) rule out a real <button> card
    <div
      role="button"
      tabIndex={0}
      className="group mt-3 cursor-pointer rounded-2xl border border-border/60 bg-card p-4 text-left transition-colors hover:border-border hover:bg-accent/30"
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="flex gap-3">
        <AuthorAvatar
          pubkey={post.authorPubkey}
          label={authorLabel(post.authorPubkey, profiles)}
          picture={profiles.get(post.authorPubkey)?.avatar}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">
              {authorLabel(post.authorPubkey, profiles)}
            </span>
            <span className="text-xs text-muted-foreground">
              {relativeTime(post.createdAt)}
            </span>
          </div>
          <div className="mt-1">
            <MarkdownContent content={preview} mentionNames={mentionNames} />
          </div>
          {replyCount > 0 && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <MessageSquareText className="h-3.5 w-3.5" aria-hidden="true" />
              <span>
                {replyCount} {replyCount === 1 ? "reply" : "replies"}
              </span>
              {lastReplyAt !== null && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span>last reply {relativeTime(lastReplyAt)}</span>
                </>
              )}
            </div>
          )}
          {reactionGroups.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {reactionGroups.map((group) => (
                <button
                  key={group.emoji}
                  type="button"
                  title={group.pubkeys.length.toString()}
                  className="flex items-center gap-1 rounded-full border border-border/60 bg-card/60 px-2 py-0.5 text-sm hover:bg-accent"
                  onClick={(event) => {
                    event.stopPropagation();
                    onReact(post.id, group.emoji);
                  }}
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
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1 self-start">
          {canDelete && (
            <button
              type="button"
              aria-label="Delete post"
              className="rounded p-1 text-xs text-muted-foreground transition-opacity hover:bg-accent lg:opacity-0 lg:group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                if (window.confirm("Delete this post?")) {
                  onDelete(post.id);
                }
              }}
            >
              🗑
            </button>
          )}
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              className="hidden rounded p-0.5 text-xs text-muted-foreground transition-opacity hover:bg-accent group-hover:block lg:opacity-0 lg:group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onReact(post.id, emoji);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
