import { ArrowUp, Quote, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { sendChannelMessage } from "@/features/channels/hooks";
import { formatClockTime } from "@/features/channels/lib/dateFormatters.ts";
import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import { MarkdownContent } from "@/features/channels/ui/MarkdownContent";
import { recordOwnSend } from "@/features/work/lib/ownSends.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { cn } from "@/shared/lib/cn";
import { HexAvatar, HumanAvatar } from "@/shared/ui/HexAvatar";
import { notify } from "@/shared/ui/notify";
import { commentThreadRef } from "../lib/shareEvent.ts";
import {
  type CommentNode,
  commentTree,
  quotedComment,
  splitQuotedComment,
} from "../lib/fileComment.ts";

const NO_MENTIONS: ReadonlySet<string> = new Set();

type Names = {
  person: (pubkey: string) => string;
  isAgent: (pubkey: string) => boolean;
};

function Avatar({ pubkey, names }: { pubkey: string; names: Names }) {
  const label = names.person(pubkey);
  return names.isAgent(pubkey) ? (
    <HexAvatar label={label} seed={pubkey} size={14} ring="card" />
  ) : (
    <HumanAvatar label={label} size={16} />
  );
}

function Comment({
  node,
  names,
}: {
  node: CommentNode<TimelineMessage>;
  names: Names;
}) {
  const { quote, body } = splitQuotedComment(node.comment.content);
  return (
    <article
      data-testid="file-comment"
      className="rounded-[10px] border border-border bg-card px-3 py-2.5"
    >
      <div className="flex items-center gap-1.5">
        <Avatar pubkey={node.comment.authorPubkey} names={names} />
        <b className="text-xs font-semibold">
          {names.person(node.comment.authorPubkey)}
        </b>
        <span className="font-mono text-2xs text-muted-foreground">
          {quote ? "on the highlight · " : ""}
          {formatClockTime(node.comment.createdAt)}
        </span>
      </div>
      {quote ? (
        <p className="mt-1.5 border-l-2 border-honey-line bg-honey-wash px-2 py-1 text-xs text-ink-2">
          {quote}
        </p>
      ) : null}
      <div className="mt-1 text-sm">
        <MarkdownContent content={body} mentionNames={NO_MENTIONS} compact />
      </div>
      {node.replies.map((reply) => (
        <div
          key={reply.id}
          data-testid="file-comment-reply"
          className="mt-2 flex items-start gap-1.75 border-t border-dashed border-line-2 pt-2 text-xs text-ink-2"
        >
          <span className="mt-0.5">
            <Avatar pubkey={reply.authorPubkey} names={names} />
          </span>
          <div className="min-w-0 flex-1">
            <b className="font-semibold text-foreground">
              {names.person(reply.authorPubkey)}:
            </b>{" "}
            <span className="[&_.message-prose]:inline [&_p]:inline">
              <MarkdownContent
                content={reply.content}
                mentionNames={NO_MENTIONS}
                compact
              />
            </span>
          </div>
        </div>
      ))}
    </article>
  );
}

/** The comments under a preview (Shelf artboard): notes, replies folded in. */
export function FileCommentList({
  comments,
  names,
}: {
  comments: readonly TimelineMessage[];
  names: Names;
}) {
  const tree = useMemo(() => commentTree(comments), [comments]);
  if (tree.length === 0) {
    return null;
  }
  return (
    <section
      aria-label="Comments"
      data-testid="file-comments"
      className="flex flex-col gap-2 px-4 pb-4"
    >
      <h3 className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {tree.length === 1 ? "1 comment" : `${tree.length} comments`}
      </h3>
      {tree.map((node) => (
        <Comment key={node.comment.id} node={node} names={names} />
      ))}
    </section>
  );
}

/**
 * The comment box at the foot of the pane. A comment is a thread reply to
 * the share (root rule from AGENTS.md), and it notifies whoever shared the
 * file — a mention is the only wake path an agent has. Text selected in the
 * preview first rides along as the comment's highlight.
 */
export function FileCommentBox({
  share,
  quote,
  onClearQuote,
  selfPubkey,
  className,
}: {
  share: {
    id: string;
    channelId: string;
    authorPubkey: string;
    rootId: string | null;
    replyToId: string | null;
  };
  quote: string | null;
  onClearQuote: () => void;
  selfPubkey: string | null;
  className?: string;
}) {
  const { session } = useRelaySession();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const retry = useRef<() => unknown>(() => undefined);

  const send = async () => {
    const body = text.trim();
    if (body === "" || sending) {
      return;
    }
    setSending(true);
    const run = () =>
      sendChannelMessage(session, {
        channelId: share.channelId,
        content: quotedComment(quote, body),
        mentionPubkeys:
          share.authorPubkey !== selfPubkey ? [share.authorPubkey] : [],
        threadRef: commentThreadRef(share),
        onSigned: (event) => recordOwnSend(event.id),
      });
    retry.current = () => void send();
    try {
      const result = await run();
      if (result.ok) {
        setText("");
        onClearQuote();
      } else {
        // The relay's verdict, verbatim (AGENTS.md send-path rule).
        notify.sendError({
          message: result.message,
          onRetry: () => void retry.current(),
          onCopy: () => void navigator.clipboard?.writeText(result.message),
        });
      }
    } catch (error) {
      notify.sendFailure(error, retry);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className={cn("border-t border-border px-3.5 pt-2.5 pb-3.5", className)}
    >
      {quote ? (
        <div
          data-testid="file-comment-quote"
          className="mb-2 flex items-start gap-2 rounded-lg border border-honey-line bg-honey-wash px-2.5 py-1.5 text-xs text-ink-2"
        >
          <Quote
            aria-hidden
            className="mt-0.5 size-3 shrink-0 text-honey-ink"
          />
          <span className="line-clamp-2 min-w-0 flex-1">{quote}</span>
          <button
            type="button"
            aria-label="Drop the highlight"
            onClick={onClearQuote}
            className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X aria-hidden className="size-3" />
          </button>
        </div>
      ) : null}
      <div className="flex items-end gap-2 rounded-[10px] border border-line-2 bg-card py-1.5 pr-1.5 pl-3 focus-within:border-ring">
        <textarea
          data-testid="file-comment-input"
          aria-label="Comment on this file"
          rows={1}
          value={text}
          disabled={sending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={
            quote
              ? "Comment on the highlight…"
              : "Comment on this file, or select text first…"
          }
          className="field-sizing-content max-h-32 min-h-6 flex-1 resize-none bg-transparent py-0.5 text-sm text-foreground outline-hidden placeholder:text-muted-foreground"
        />
        <button
          type="button"
          aria-label="Send comment"
          disabled={sending || text.trim() === ""}
          onClick={() => void send()}
          className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
        >
          <ArrowUp aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  );
}
