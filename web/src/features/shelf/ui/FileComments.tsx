import { ArrowUp, FileText, Quote, X } from "lucide-react";
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
import { mentionsFor } from "../lib/agentTarget.ts";
import {
  type AgentRequestContext,
  agentRequest,
  type CommentNode,
  commentTree,
  quotedComment,
  splitAgentRequest,
  splitFileTrailer,
} from "../lib/fileComment.ts";
import { commentThreadRef } from "../lib/shareEvent.ts";
import { useAgentTargets } from "../useAgentTargets.ts";

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

/** The `[file: …]` trailer, shown — never hidden — as a small chip. */
function FileChip({ file }: { file: string | null }) {
  if (!file) {
    return null;
  }
  return (
    <p
      data-testid="file-comment-trailer"
      title="The file this message asks the agent about"
      className="mt-1 flex min-w-0 items-center gap-1 font-mono text-2xs text-muted-foreground"
    >
      <FileText aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{file}</span>
    </p>
  );
}

function Comment({
  node,
  names,
}: {
  node: CommentNode<TimelineMessage>;
  names: Names;
}) {
  // The `[file: …]` trailer becomes a visible chip, not raw text.
  const { quote, body, file } = splitAgentRequest(node.comment.content);
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
      <FileChip file={file} />
      {node.replies.map((reply) => {
        const split = splitFileTrailer(reply.content);
        return (
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
                  content={split.text}
                  mentionNames={NO_MENTIONS}
                  compact
                />
              </span>
              <FileChip file={split.file} />
            </div>
          </div>
        );
      })}
    </article>
  );
}

/**
 * The thread under a preview: requests to the agent (and notes), with the
 * replies made to each folded under it.
 */
export function FileThread({
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
      aria-label="Agent thread"
      data-testid="file-comments"
      className="flex flex-col gap-2 px-4 pb-4"
    >
      <h3 className="text-2xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        Agent thread · {tree.length}
      </h3>
      {tree.map((node) => (
        <Comment key={node.comment.id} node={node} names={names} />
      ))}
    </section>
  );
}

/**
 * The box at the foot of the pane: a message TO THE AGENT about this
 * document (canvas edit plan D9–D12). Transport is unchanged — a thread reply
 * to the share (AGENTS.md root rule) with a mention, the only wake path an
 * agent has — but it now names the agent it goes to, carries a `[file: …]`
 * trailer so the agent knows which file on disk to edit, and offers to save
 * an unsaved draft first so the agent does not edit under it.
 */
export function AgentBox({
  share,
  quote,
  onClearQuote,
  selfPubkey,
  names,
  comments,
  context,
  dirty = false,
  saveDraft,
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
  names: Names;
  comments: readonly { authorPubkey: string }[];
  /** The `[file: …]` trailer's facts; null sends no trailer. */
  context: AgentRequestContext | null;
  /** The pane has an unsaved edit of this file. */
  dirty?: boolean;
  /** Save that edit; resolves true when the disk holds it. */
  saveDraft?: () => Promise<boolean>;
  className?: string;
}) {
  const { session } = useRelaySession();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [askSave, setAskSave] = useState(false);
  const retry = useRef<() => unknown>(() => undefined);
  const { target, pick } = useAgentTargets({
    channelId: share.channelId,
    authorPubkey: share.authorPubkey,
    selfPubkey,
    isAgent: names.isAgent,
    comments,
  });
  const agentName = target.target ? names.person(target.target) : null;
  const toAgent = target.mode !== "note";
  const canSend =
    !sending &&
    text.trim() !== "" &&
    (target.mode !== "picker" || !!target.target);

  const publish = async (body: string) => {
    const run = () =>
      sendChannelMessage(session, {
        channelId: share.channelId,
        content: toAgent
          ? agentRequest(quote, body, context)
          : quotedComment(quote, body),
        mentionPubkeys: mentionsFor(target, share.authorPubkey, selfPubkey),
        threadRef: commentThreadRef(share),
        onSigned: (event) => recordOwnSend(event.id),
      });
    retry.current = () => void send(false);
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
    }
  };

  /** `saveFirst`: null = ask when dirty; true / false = the person chose. */
  const send = async (saveFirst: boolean | null = null) => {
    const body = text.trim();
    if (body === "" || sending) {
      return;
    }
    if (target.mode === "picker" && !target.target) {
      return;
    }
    if (toAgent && dirty && saveFirst === null && saveDraft) {
      setAskSave(true);
      return;
    }
    setAskSave(false);
    setSending(true);
    try {
      if (saveFirst === true && saveDraft) {
        // The disk must hold the draft BEFORE the agent is asked (D12).
        const saved = await saveDraft();
        if (!saved) {
          return;
        }
      }
      await publish(body);
    } finally {
      setSending(false);
    }
  };

  const placeholder = !toAgent
    ? quote
      ? "Add a note on the highlight…"
      : "Add a note on this file…"
    : agentName
      ? quote
        ? `Ask ${agentName} to change the highlight…`
        : `Ask ${agentName} to change this document…`
      : "Choose an agent, then ask for a change…";
  const sendLabel = toAgent
    ? agentName
      ? `Send to ${agentName}`
      : "Choose an agent first"
    : "Post note";

  return (
    <div
      className={cn("border-t border-border px-3.5 pt-2.5 pb-3.5", className)}
    >
      <div className="mb-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        {target.mode === "author" ? (
          <span
            data-testid="agent-box-target"
            className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-chip px-2 py-0.5 text-foreground"
          >
            <span className="text-muted-foreground">To</span>
            <b className="truncate font-semibold">{agentName}</b>
          </span>
        ) : target.mode === "picker" ? (
          <label className="inline-flex min-w-0 items-center gap-1.5">
            <span>To</span>
            <select
              data-testid="agent-box-target"
              aria-label="Agent to ask"
              value={target.target ?? ""}
              onChange={(event) => pick(event.target.value)}
              className="min-h-11 min-w-0 truncate rounded-lg border border-line-2 bg-card px-2 text-xs font-semibold text-foreground md:min-h-7"
            >
              {target.target ? null : (
                <option value="" disabled>
                  Choose an agent
                </option>
              )}
              {target.options.map((pubkey) => (
                <option key={pubkey} value={pubkey}>
                  {names.person(pubkey)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span data-testid="agent-box-target">
            No agent here — this posts a note on the file
          </span>
        )}
      </div>
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
      {askSave ? (
        <div
          data-testid="agent-box-save-first"
          role="alert"
          className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-line-2 bg-card px-2.5 py-2 text-xs"
        >
          <span className="min-w-0 flex-1">
            You have unsaved edits to this file.
          </span>
          <button
            type="button"
            data-testid="agent-box-save-and-send"
            onClick={() => void send(true)}
            className="min-h-11 rounded-lg bg-primary px-3 font-semibold text-primary-foreground md:min-h-7"
          >
            Save and send
          </button>
          <button
            type="button"
            data-testid="agent-box-send-unsaved"
            onClick={() => void send(false)}
            className="min-h-11 rounded-lg border border-line-2 px-3 font-semibold md:min-h-7"
          >
            Send without saving
          </button>
          <button
            type="button"
            aria-label="Cancel sending"
            onClick={() => setAskSave(false)}
            className="grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-accent md:size-7"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      ) : null}
      <div className="flex items-end gap-2 rounded-[10px] border border-line-2 bg-card py-1.5 pr-1.5 pl-3 focus-within:border-ring">
        <textarea
          data-testid="file-comment-input"
          aria-label={
            toAgent
              ? agentName
                ? `Message ${agentName} about this file`
                : "Message an agent about this file"
              : "Note on this file"
          }
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
          placeholder={placeholder}
          className="field-sizing-content max-h-32 min-h-6 flex-1 resize-none bg-transparent py-0.5 text-sm text-foreground outline-hidden placeholder:text-muted-foreground"
        />
        <button
          type="button"
          data-testid="agent-box-send"
          aria-label={sendLabel}
          title={sendLabel}
          disabled={!canSend}
          onClick={() => void send()}
          className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
        >
          <ArrowUp aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  );
}
