import { useCallback, useEffect, useMemo, useState } from "react";
import type { MessageBuffer, TimelineMessage } from "../lib/messageBuffer.ts";
import type { ChannelMember, Profile } from "../hooks.ts";
import {
  replyTargetMessage,
  resolveThreadReplyRef,
} from "../lib/threadTarget.ts";
import { threadParticipants, threadSummaryLine } from "../lib/threadSummary.ts";
import {
  branchSummary,
  buildThreadEntries,
  buildThreadIndex,
  threadDescendants,
  type ThreadBranchSummary,
} from "../lib/threadTree.ts";
import {
  mergeThreadCounts,
  type RelayThreadSummaryMap,
} from "../lib/threadSummaryEvent.ts";
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

const EMPTY_SUMMARIES: RelayThreadSummaryMap = new Map();

/**
 * Thread view in the desktop client's shape: a "Thread" header with the reply
 * count, the root message on a rounded card, the thread's replies, and a
 * composer that replies into the thread (NIP-10 root/reply tags). At lg+ the
 * panel docks right; its width comes from the shared --thread-width CSS
 * variable the shell maintains (drag handle there).
 *
 * THREADS NEST. Replies used to render as one flat list under the root,
 * which threw away exactly the information the NIP-10 `reply` marker exists
 * to carry: mid-thread answers looked like answers to the thread. The panel
 * now renders the tree the markers describe — direct replies at the top
 * level, a sub-branch collapsed behind a "N replies" chip until it is
 * expanded, and depth as indent (lib/threadTree.ts, ported from the
 * desktop's `threadPanel.ts` + `threadTreeLayout.ts`).
 *
 * The reply count in the header is the whole SUBTREE, and it is reconciled
 * with the relay's materialised `descendant_count` when a kind-39005 overlay
 * has arrived for this root — so a thread whose older replies are outside
 * the loaded buffer still reports its real size.
 *
 * The composer's NIP-10 `reply` marker names the message the author chose to
 * respond to — the thread root by default, or whichever reply the reader
 * picked with its ↩ button. See lib/threadTarget.ts.
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
  threadSummaries = EMPTY_SUMMARIES,
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
  /**
   * Relay thread counters (kind 39005) from the channel feed. Optional: with
   * none, every count comes from the loaded buffer, which is a floor rather
   * than a lie.
   */
  threadSummaries?: RelayThreadSummaryMap;
}) {
  const rootId = root.id;
  /** Replies whose own sub-branch is expanded in place. */
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Which message the composer is replying to. Null = the thread itself,
  // whose NIP-10 parent is the root. Cleared whenever a different thread
  // opens so a selection can never carry over to another root.
  const [selectedReplyId, setSelectedReplyId] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rootId is the reset trigger, not a value read inside the effect
  useEffect(() => {
    setSelectedReplyId(null);
    setExpandedIds(new Set());
  }, [rootId]);

  const index = useMemo(() => buildThreadIndex(buffer), [buffer]);
  /** Every reply under this root, at any depth, oldest first. */
  const replies = useMemo(
    () => threadDescendants(index, rootId),
    [index, rootId],
  );
  const entries = useMemo(
    () => buildThreadEntries(index, rootId, expandedIds),
    [index, rootId, expandedIds],
  );
  const threadMessages = useMemo(
    () => [root, ...entries.map((entry) => entry.message)],
    [root, entries],
  );
  const depthById = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of entries) {
      map.set(entry.message.id, entry.depth);
    }
    return map;
  }, [entries]);
  const summaryById = useMemo(() => {
    const map = new Map<string, ThreadBranchSummary>();
    for (const entry of entries) {
      if (entry.summary) {
        map.set(entry.message.id, entry.summary);
      }
    }
    return map;
  }, [entries]);
  const onExpand = useCallback((parentId: string) => {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      next.add(parentId);
      return next;
    });
  }, []);
  const threadLayout = useMemo(
    () => ({ depthById, summaryById, onExpand }),
    [depthById, summaryById, onExpand],
  );

  const localSummary = branchSummary(index, rootId);
  const counts = mergeThreadCounts(
    {
      replyCount: index.statsById.get(rootId)?.directReplyCount ?? 0,
      descendantCount: localSummary?.replyCount ?? 0,
      lastReplyAt: localSummary?.lastReplyAt ?? null,
      participants: localSummary?.participants ?? [],
    },
    threadSummaries.get(rootId),
  );

  const lastReply = replies[replies.length - 1] ?? root;
  // Auto-tail (Sam 8/31): thread-heavy agents have long threads — the panel
  // must open on the NEWEST reply, not the root. The timeline's tailKey
  // handles it now that the list is virtualized.

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
  const summary = threadSummaryLine(counts.descendantCount, counts.lastReplyAt);

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
        // than opening a nested panel — the nesting is rendered in place.
        onOpenThread={(message) => setSelectedReplyId(message.id)}
        activeRootId={threadRef.replyToId}
        flat
        threadLayout={threadLayout}
        tailKey={`${rootId}:${lastReply.id}:${threadMessages.length}`}
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
