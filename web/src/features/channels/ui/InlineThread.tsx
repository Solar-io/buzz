import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ChannelMember, Profile } from "../hooks.ts";
import { authorLabel } from "../lib/authorLabel.ts";
import { formatTime } from "../lib/dateFormatters.ts";
import { clearDraft, saveDraft } from "../lib/drafts.ts";
import {
  inlineReplyCount,
  inlineThreadRef,
  inlineThreadWindow,
  replyCountLabel,
} from "../lib/inlineThread.ts";
import type { TimelineMessage } from "../lib/messageBuffer.ts";
import { threadPartner } from "../lib/threadPartner.ts";
import {
  loadThreadReadState,
  markThreadSeen,
  saveThreadReadState,
} from "../lib/threadReadState.ts";
import { Composer } from "./Composer.tsx";

type ComposerProps = Parameters<typeof Composer>[0];

/** What a thread's reply box needs from the conversation it lives in. */
export interface InlineThreadComposer {
  members: ChannelMember[];
  strictMentions: boolean;
  send: ComposerProps["send"];
}

/**
 * A thread, in place under its message (web redesign Phase 2; Main artboard).
 *
 * Collapsed it is one quiet line — "N replies · last 3:29 PM". Expanded it is
 * the replies on a rail and a slim reply box, right where the conversation
 * forked, instead of a second column that pulled the reader's eyes off the
 * message they were answering. Threads are kept but de-emphasised: nothing
 * here competes with the channel's own flow.
 *
 * A long thread shows its newest replies behind "Show N earlier" (the live
 * end is what sits next to the reply box); `revealId` — a permalink to a
 * reply — lifts that window so the target row exists to scroll to.
 *
 * THE REPLY BOX ANSWERS THE THREAD, never a mid-thread message: its ref is
 * `inlineThreadRef(root)`, whose rootId is the real thread root even when
 * this row is itself a reply shown top-level (see lib/inlineThread.ts).
 *
 * The draft is persisted under `thread:<root id>`: a virtualized row unmounts
 * when it scrolls away, and a half-typed reply must survive that.
 */
export function InlineThread({
  root,
  replies,
  summarizedCount,
  expanded,
  focus = false,
  revealId = null,
  onToggle,
  profiles,
  selfPubkey,
  agentPubkeys,
  composer,
  renderReply,
}: {
  root: TimelineMessage;
  /** Every loaded reply under `root`, oldest first. */
  replies: readonly TimelineMessage[];
  /** The relay's reply count for this thread (it may know of more). */
  summarizedCount: number;
  expanded: boolean;
  /** Put the caret in the reply box (opened by ↩ or "Answer in chat"). */
  focus?: boolean;
  /** A reply that must be on screen (permalink) — lifts the window. */
  revealId?: string | null;
  onToggle: (open: boolean) => void;
  profiles: Map<string, Profile>;
  selfPubkey?: string | null;
  agentPubkeys?: ReadonlySet<string>;
  /** Absent: a read-only thread (no reply box). */
  composer?: InlineThreadComposer;
  renderReply: (reply: TimelineMessage) => ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const count = inlineReplyCount(replies.length, summarizedCount);
  const last = replies[replies.length - 1] ?? null;
  const revealHidden =
    revealId != null && replies.some((reply) => reply.id === revealId);
  const { visible, hidden } = inlineThreadWindow(
    replies,
    showAll || revealHidden,
  );

  // "You were here": the per-thread read marker moves when the thread is
  // open, exactly as the old thread pane moved it on mount.
  const newestAt = last?.createdAt ?? root.createdAt;
  useEffect(() => {
    if (!expanded) {
      return;
    }
    const state = loadThreadReadState();
    const next = markThreadSeen(state, root.id, newestAt);
    if (next !== state) {
      saveThreadReadState(next);
    }
  }, [expanded, root.id, newestAt]);

  // Threads notify the viewer's one conversation partner without a typed @
  // (lib/threadPartner.ts) — a mention is the only wake path for an agent.
  const autoNotify = useMemo(() => {
    if (!selfPubkey || !expanded) {
      return null;
    }
    const other = threadPartner([root, ...replies], selfPubkey, agentPubkeys);
    return other
      ? { pubkey: other, label: authorLabel(other, profiles) }
      : null;
  }, [root, replies, selfPubkey, agentPubkeys, profiles, expanded]);

  if (count === 0 && !expanded) {
    return null;
  }
  const draftKey = `thread:${root.id}`;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="mt-1.5 max-w-2xl" data-testid={`inline-thread-${root.id}`}>
      {count > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          data-testid={`thread-chip-${root.id}`}
          onClick={() => onToggle(!expanded)}
          className="-ml-1 inline-flex h-8 items-center gap-1.5 rounded-md pr-2 pl-1 text-xs font-semibold text-info-ink hover:bg-accent md:h-6"
        >
          <Chevron aria-hidden className="size-3.5 shrink-0" />
          {replyCountLabel(count)}
          {last && (
            <span className="font-mono text-2xs font-medium text-muted-foreground">
              · last {formatTime(last.createdAt)}
            </span>
          )}
        </button>
      )}
      {expanded && (
        <div className="mt-1 ml-2.5 flex flex-col gap-1 border-l-2 border-line-2 pl-3.5">
          {hidden > 0 && (
            <button
              type="button"
              data-testid="thread-show-earlier"
              onClick={() => setShowAll(true)}
              className="self-start rounded-md py-0.5 text-xs font-semibold text-info-ink hover:underline"
            >
              Show {hidden} earlier {hidden === 1 ? "reply" : "replies"}
            </button>
          )}
          {count > replies.length && (
            <p className="text-xs text-muted-foreground">
              {replies.length} of {replyCountLabel(count)} loaded — scroll up in
              the channel to load the rest.
            </p>
          )}
          {visible.map((reply) => renderReply(reply))}
          {composer && (
            <div className="mt-1" data-testid="thread-reply-box">
              <Composer
                variant="inline"
                members={composer.members}
                profiles={profiles}
                strictMentions={composer.strictMentions}
                threadRef={inlineThreadRef(root)}
                placeholder="Reply in thread…"
                autoNotify={autoNotify}
                autoFocus={focus}
                // A slash line is refused here, not posted: commands run
                // from the channel's own box.
                commands="elsewhere"
                draftKey={draftKey}
                onTextChange={(text) => saveDraft(draftKey, text)}
                onSent={() => clearDraft(draftKey)}
                // Esc has nothing mid-thread to step out of — it folds the
                // thread. The draft stays, so reopening picks it back up.
                onClearThread={() => onToggle(false)}
                send={composer.send}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
