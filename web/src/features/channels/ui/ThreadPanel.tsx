import { useEffect, useMemo, useState } from "react";
import type { MessageBuffer, TimelineMessage } from "../lib/messageBuffer.ts";
import type { ChannelMember, Profile } from "../hooks.ts";
import {
  replyTargetMessage,
  resolveThreadReplyRef,
  threadRepliesOf,
} from "../lib/threadTarget.ts";
import { threadParticipants, threadSummaryLine } from "../lib/threadSummary.ts";
import {
  loadThreadReadState,
  markThreadSeen,
  saveThreadReadState,
  threadSeenAt,
  threadUnreadCount,
} from "../lib/threadReadState.ts";
import { authorLabel, ChannelTimeline } from "./ChannelTimeline.tsx";
import { Composer } from "./Composer.tsx";
import { ThreadParticipantStack } from "./ThreadParticipantStack.tsx";

/**
 * Thread view in the desktop client's shape: a "Thread" header with the reply
 * count, the root message on a rounded card, every reply in the channel
 * buffer, and a composer that replies into the thread (NIP-10 root/reply
 * tags). At lg+ the panel docks right; its width comes from the shared
 * --thread-width CSS variable the shell maintains (drag handle there).
 *
 * The header carries what the desktop's thread summary carries: the
 * participants as an overlapping avatar stack, the reply count, and when the
 * last reply landed. Threads here stay FLAT by an explicit decision — no
 * nesting, no depth guides, no collapse.
 *
 * The composer's NIP-10 `reply` marker names the message the author chose to
 * respond to — the thread root by default, or whichever reply the reader
 * picked with its ↩ button. It is NOT the newest reply: that made every reply
 * claim the last message as its parent and made replying mid-thread
 * impossible. See lib/threadTarget.ts.
 */
export function ThreadPanel({
  root,
  buffer,
  members,
  profiles,
  onClose,
  send,
  onSelectThinkingTab,
  mobileOnly,
}: {
  root: TimelineMessage;
  buffer: MessageBuffer;
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  onClose: () => void;
  send: ComposerProps["send"];
  /** DMs offer a Replies ↔ Thinking switch in the header. */
  onSelectThinkingTab?: () => void;
  /** Overlay on small screens only — used when the DM right pane shows the
   *  thinking tab at lg but a thread was opened from the timeline. */
  mobileOnly?: boolean;
}) {
  const replies = threadRepliesOf(buffer, root.id);
  const threadMessages = [root, ...replies];
  const lastReply = replies[replies.length - 1] ?? root;
  // Auto-tail (Sam 8/31): thread-heavy agents have long threads — the panel
  // must open on the NEWEST reply, not the root. The timeline's tailKey
  // handles it now that the list is virtualized.

  // Which message the composer is replying to. Null = the thread itself,
  // whose NIP-10 parent is the root. Cleared whenever a different thread
  // opens so a selection can never carry over to another root.
  const [selectedReplyId, setSelectedReplyId] = useState<string | null>(null);
  const rootId = root.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: rootId is the reset trigger, not a value read inside the effect
  useEffect(() => {
    setSelectedReplyId(null);
  }, [rootId]);

  // Unread replies since this thread was last open.
  //
  // The marker is SNAPSHOT on open and then advanced. Reading it live would
  // make the badge correct for one frame and zero forever after, because the
  // same panel that displays the count is the thing that marks the thread
  // read. See lib/threadReadState.ts for why the channel-level read state in
  // lib/readState.ts cannot answer this question at all.
  const [seenAtOnOpen, setSeenAtOnOpen] = useState(0);
  useEffect(() => {
    setSeenAtOnOpen(threadSeenAt(loadThreadReadState(), rootId));
  }, [rootId]);
  const newestReplyAt = lastReply.createdAt;
  useEffect(() => {
    const state = loadThreadReadState();
    const next = markThreadSeen(state, rootId, newestReplyAt);
    if (next !== state) {
      saveThreadReadState(next);
    }
  }, [rootId, newestReplyAt]);
  const unreadCount = threadUnreadCount(replies, seenAtOnOpen);

  const participants = useMemo(
    () => threadParticipants(root, replies),
    [root, replies],
  );
  const summary = threadSummaryLine(
    replies.length,
    replies.length > 0 ? lastReply.createdAt : null,
  );

  const threadRef = resolveThreadReplyRef(rootId, replies, selectedReplyId);
  const target = replyTargetMessage(rootId, replies, selectedReplyId);
  const rootAuthor = authorLabel(root.authorPubkey, profiles);

  return (
    // Below lg the thread is a full-screen sheet (safe-area aware) — a third
    // column at phone/tablet widths is what crushed the timeline. lg+: docked,
    // unless mobileOnly (DM thinking-tab case: overlay on phones, hidden at lg).
    <aside
      className={
        mobileOnly
          ? "fixed inset-0 z-40 flex flex-col bg-background pt-[max(0.5rem,env(safe-area-inset-top))] lg:hidden"
          : "fixed inset-0 z-40 flex flex-col bg-background pt-[max(0.5rem,env(safe-area-inset-top))] lg:static lg:inset-auto lg:z-auto lg:w-[var(--thread-width)] lg:shrink-0 lg:border-l lg:border-border lg:pt-0"
      }
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-secondary px-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">
              Replies
            </span>
            {onSelectThinkingTab && (
              <button
                type="button"
                className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={onSelectThinkingTab}
              >
                Thinking
              </button>
            )}
            {unreadCount > 0 && (
              <span
                data-testid="thread-unread-badge"
                className="rounded-full bg-primary px-1.5 py-0.5 text-badge font-semibold text-primary-foreground"
              >
                {unreadCount} new
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <ThreadParticipantStack
              participants={participants}
              profiles={profiles}
            />
            <span
              data-testid="thread-summary"
              className="truncate text-2xs text-muted-foreground"
            >
              {summary}
            </span>
          </div>
        </div>
        <button
          type="button"
          aria-label="Close thread"
          className="shrink-0 rounded p-1 text-sm text-muted-foreground hover:bg-accent"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <ChannelTimeline
        messages={threadMessages}
        profiles={profiles}
        replyCounts={new Map()}
        // Inside a thread the row's ↩ button picks the reply TARGET rather
        // than opening a nested thread — threads here are flat.
        onOpenThread={(message) => setSelectedReplyId(message.id)}
        activeRootId={threadRef.replyToId}
        flat
        tailKey={`${rootId}:${lastReply.id}:${replies.length}`}
      />
      <Composer
        members={members}
        profiles={profiles}
        threadRef={threadRef}
        replyTarget={
          target
            ? {
                author: authorLabel(target.authorPubkey, profiles),
                body: target.content,
              }
            : null
        }
        // With no mid-thread target the composer answers the thread itself, so
        // the hint names its root author (the desktop's
        // `Reply in thread to <head author>`). With a target, the placeholder
        // falls through to "Reply to <author>" and the banner quotes them.
        placeholder={target ? undefined : `Reply in thread to ${rootAuthor}`}
        onClearThread={() => {
          // Esc steps back one level: drop a mid-thread target first, and
          // only close the panel once the composer is aimed at the thread.
          if (selectedReplyId) {
            setSelectedReplyId(null);
            return;
          }
          onClose();
        }}
        send={send}
      />
    </aside>
  );
}

type ComposerProps = Parameters<typeof Composer>[0];
