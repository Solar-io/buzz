import { useMemo, useState } from "react";
import { Bot, Heart, Link2, MessageSquare } from "lucide-react";
import { nip19 } from "nostr-tools";
import { toast } from "sonner";

import type { Profile } from "@/features/channels/hooks";
import { AuthorAvatar } from "@/features/channels/ui/AuthorAvatar";
import { MarkdownContent } from "@/features/channels/ui/MarkdownContent";
import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { relativeTime } from "@/shared/lib/relative-time";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";

import type { PulseNote, PulseReactionState } from "../lib/pulseTypes.ts";

/** `nostr:nevent…` share URI for one note — the desktop's `buildNoteShareUri`. */
export function buildNoteShareUri(note: Pick<PulseNote, "id" | "pubkey">) {
  return `nostr:${nip19.neventEncode({ id: note.id, author: note.pubkey })}`;
}

const EMPTY_MENTIONS: ReadonlySet<string> = new Set<string>();

export interface NoteCardActions {
  onToggleUpvote: (noteId: string, upvote: boolean) => void;
  onReply: (noteId: string, content: string) => Promise<void>;
}

/**
 * One note in the Pulse feed: author, relative time, body, and the three
 * actions the desktop's NoteCard carries — like, reply, copy share link.
 *
 * The reply composer is inline and collapsed by default. The desktop opens a
 * full composer with mention autocomplete; the web keeps a plain textarea,
 * because Pulse replies are `kind:1` notes with no channel membership to
 * resolve mentions against — the mention list would be empty in most feeds.
 */
export function NoteCard({
  actions,
  isAgent,
  isSelf,
  note,
  profile,
  reaction,
  upvotePending,
}: {
  actions: NoteCardActions;
  isAgent: boolean;
  isSelf: boolean;
  note: PulseNote;
  profile: Profile | undefined;
  reaction: PulseReactionState | undefined;
  upvotePending: boolean;
}) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replying, setReplying] = useState(false);

  const label = useMemo(
    () =>
      profile?.displayName?.trim() ||
      profile?.name?.trim() ||
      truncatePubkey(note.pubkey),
    [profile, note.pubkey],
  );
  const upvoted = reaction?.reactedByCurrentUser ?? false;
  const upvoteCount = reaction?.count ?? 0;

  const submitReply = async () => {
    const content = replyText.trim();
    if (!content || replying) {
      return;
    }
    setReplying(true);
    try {
      await actions.onReply(note.id, content);
      setReplyText("");
      setReplyOpen(false);
      toast.success("Reply posted");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to post the reply",
      );
    } finally {
      setReplying(false);
    }
  };

  return (
    <article
      className="flex gap-3 border-b border-border/40 px-1 py-4"
      data-testid={`pulse-note-${note.id}`}
    >
      <div className="relative shrink-0">
        <AuthorAvatar
          label={label}
          picture={profile?.avatar}
          pubkey={note.pubkey}
        />
        {isAgent ? (
          <Bot
            aria-label="Agent"
            className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-background p-0.5 text-muted-foreground"
          />
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {label}
          </span>
          {isSelf ? (
            <span className="shrink-0 text-badge uppercase tracking-wide text-muted-foreground">
              You
            </span>
          ) : null}
          <span className="shrink-0 text-2xs text-muted-foreground">
            {relativeTime(note.createdAt)}
          </span>
        </div>

        <div className="mt-1 text-sm">
          <MarkdownContent
            content={note.content}
            mentionNames={EMPTY_MENTIONS}
          />
        </div>

        <div className="mt-2 flex items-center gap-1">
          <Button
            aria-label={upvoted ? "Remove your like" : "Like this note"}
            aria-pressed={upvoted}
            className="gap-1 text-2xs text-muted-foreground"
            data-testid={`pulse-note-like-${note.id}`}
            disabled={upvotePending}
            onClick={() => actions.onToggleUpvote(note.id, !upvoted)}
            size="xs"
            type="button"
            variant="ghost"
          >
            <Heart
              aria-hidden
              className={cn(
                "h-3.5 w-3.5",
                upvoted && "fill-current text-primary",
              )}
            />
            {upvoteCount > 0 ? upvoteCount : null}
          </Button>
          <Button
            aria-expanded={replyOpen}
            aria-label="Reply to this note"
            className="gap-1 text-2xs text-muted-foreground"
            data-testid={`pulse-note-reply-${note.id}`}
            onClick={() => setReplyOpen((open) => !open)}
            size="xs"
            type="button"
            variant="ghost"
          >
            <MessageSquare aria-hidden className="h-3.5 w-3.5" />
            Reply
          </Button>
          <Button
            aria-label="Copy a link to this note"
            className="gap-1 text-2xs text-muted-foreground"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(buildNoteShareUri(note))
                .then(() => toast.success("Link copied"))
                .catch(() => toast.error("Could not copy the link"));
            }}
            size="xs"
            type="button"
            variant="ghost"
          >
            <Link2 aria-hidden className="h-3.5 w-3.5" />
          </Button>
        </div>

        {replyOpen ? (
          <div className="mt-2 space-y-2">
            <Textarea
              aria-label="Reply"
              className="min-h-16 resize-none text-sm"
              data-testid={`pulse-note-reply-input-${note.id}`}
              onChange={(event) => setReplyText(event.target.value)}
              placeholder="Write a reply…"
              value={replyText}
            />
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => setReplyOpen(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={replying || replyText.trim().length === 0}
                onClick={() => void submitReply()}
                size="sm"
                type="button"
              >
                {replying ? "Posting…" : "Reply"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}
