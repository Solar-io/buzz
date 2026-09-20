import { useEffect, useMemo, useState } from "react";
import type { MessageBuffer, TimelineMessage } from "../lib/messageBuffer.ts";
import type { ChannelMember, Profile } from "../hooks.ts";
import { threadParticipants, threadSummaryLine } from "../lib/threadSummary.ts";
import {
  branchSummary,
  buildThreadIndex,
  threadDescendants,
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
import { useThreadLayout } from "@/features/settings/lib/appearanceStore.ts";
import { authorLabel, ChannelTimeline } from "./ChannelTimeline.tsx";
import { Composer } from "./Composer.tsx";
import { ThreadParticipantStack } from "./ThreadParticipantStack.tsx";

const EMPTY_SUMMARIES: RelayThreadSummaryMap = new Map();

/**
 * Below `lg` a thread is always a full-screen sheet: a third column at
 * phone/tablet widths is what crushed the timeline. At `lg` and up the
 * Thread layout preference decides.
 *
 * "Focus" is therefore not a new layout — it is this base overlay, kept at
 * every width by simply not adding the docking classes. That is why the
 * preference needs no change in the shell that renders this panel: the
 * overlay covers the resize handle and the channel column behind it.
 */
const THREAD_OVERLAY_CLASSES =
  "fixed inset-0 z-40 flex flex-col bg-background pt-[max(0.5rem,env(safe-area-inset-top))]";
const THREAD_DOCK_CLASSES =
  "lg:static lg:inset-auto lg:z-auto lg:w-[var(--thread-width)] lg:shrink-0 lg:border-l lg:border-border lg:pt-0";

/**
 * Thread view in the desktop client's shape: a "Thread" header with the reply
 * count, the root message, the thread's replies, and a composer. At lg+ the
 * panel docks right; its width comes from the shared --thread-width CSS
 * variable the shell maintains (drag handle there).
 *
 * THE THREAD IS FLAT (Sam 2026-09-20). One click from the main chat shows the
 * whole conversation: the pane renders the root and EVERY descendant of it,
 * oldest first, as ordinary full rows — no indent ladder, no collapsed
 * "N replies" chip, no second click to open a sub-branch. A reply nested two
 * levels deep by some other client lands here as a plain row like any other
 * (`threadDescendants` already walks the whole subtree, whatever depth the
 * NIP-10 markers describe). This supersedes the tree rendering this panel
 * carried before, and with it the affordances that only made sense there:
 * the ↩ "reply to THIS reply" picker is gone from pane rows — the composer
 * below ALWAYS answers the root, so per-row targeting inside the pane could
 * only lie about where the send would land.
 *
 * That also retires two cards whose mechanism was expansion:
 * - D-041 (card answers must be visible on open): they now always are — a
 *   flat list hides nothing behind a chip.
 * - D-050 (expand a permalink's ancestors before jumping): there are no
 *   collapsed ancestors left to expand, so the permalink target's row exists
 *   on the first render and the list can jump straight to it.
 *
 * The tree machinery itself stays in lib/threadTree.ts — the forum views
 * still render threaded, and the index/stats half of the lib still feeds this
 * panel's header counts.
 *
 * The reply count in the header is the whole SUBTREE, reconciled with the
 * relay's materialised `descendant_count` when a kind-39005 overlay has
 * arrived for this root — so a thread whose older replies are outside the
 * loaded buffer still reports its real size.
 *
 * The composer's NIP-10 shape is constant: `threadRef {rootId, replyToId:
 * rootId}` — the single `["e", root, "", "reply"]` tag `sendChannelMessage`
 * derives from it. Replies sent from the pane are always answers to the
 * thread, never to a mid-thread parent. See lib/threadTarget.ts for the wire
 * convention.
 */
export function ThreadPanel({
  root,
  buffer,
  members,
  profiles,
  selfPubkey,
  onClose,
  send,
  onSelectThinkingTab,
  mobileOnly,
  strictMentions = false,
  threadSummaries = EMPTY_SUMMARIES,
  permalinkMessageId = null,
}: {
  root: TimelineMessage;
  buffer: MessageBuffer;
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  /** Viewer's pubkey — drives the timeline's own-send force-follow. */
  selfPubkey?: string | null;
  onClose: () => void;
  send: ComposerProps["send"];
  /** DMs offer a Replies ↔ Thinking switch in the header. */
  onSelectThinkingTab?: () => void;
  /** Overlay on small screens only — used when the DM right pane shows the
   *  thinking tab at lg but a thread was opened from the timeline. */
  mobileOnly?: boolean;
  /** Huddle replies must resolve every identity before they can wake a peer. */
  strictMentions?: boolean;
  /**
   * Relay thread counters (kind 39005) from the channel feed. Optional: with
   * none, every count comes from the loaded buffer, which is a floor rather
   * than a lie.
   */
  threadSummaries?: RelayThreadSummaryMap;
  /**
   * Permalink (?m) target inside THIS thread (D-043): a search jump to a
   * reply opens the thread on its root; this id scrolls the panel's flat
   * list to the reply itself and flashes it. Null when the permalink points
   * elsewhere.
   */
  permalinkMessageId?: string | null;
}) {
  const layoutMode = useThreadLayout();
  const rootId = root.id;

  const index = useMemo(() => buildThreadIndex(buffer), [buffer]);
  /** Every reply under this root, at any depth, oldest first. */
  const replies = useMemo(
    () => threadDescendants(index, rootId),
    [index, rootId],
  );
  // Flat rendering: the root plus every descendant, one row each. A nested
  // reply (parent = another reply) is a row here exactly like a direct one.
  const threadMessages = useMemo(() => [root, ...replies], [root, replies]);

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

  const rootAuthor = authorLabel(root.authorPubkey, profiles);
  // The composer ALWAYS answers the thread itself — there is no mid-thread
  // target to aim at anymore, and the wire shape is the constant single
  // ["e", root, "", "reply"] tag (see the docblock).
  const rootThreadRef = { rootId, replyToId: rootId };

  return (
    // Below lg the thread is a full-screen sheet (safe-area aware) — a third
    // column at phone/tablet widths is what crushed the timeline. lg+: docked
    // in Split layout, still an overlay in Focus, unless mobileOnly (DM
    // thinking-tab case: overlay on phones, hidden at lg).
    <aside
      className={
        mobileOnly
          ? `${THREAD_OVERLAY_CLASSES} lg:hidden`
          : layoutMode === "focus"
            ? THREAD_OVERLAY_CLASSES
            : `${THREAD_OVERLAY_CLASSES} ${THREAD_DOCK_CLASSES}`
      }
      data-custom-content-pane="replies"
      data-testid="thread-panel"
      data-thread-layout={mobileOnly ? "focus" : layoutMode}
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
        // Flat rows, no tree layout, and no onOpenThread: an in-pane ↩ would
        // only promise a mid-thread parent the composer no longer sends.
        selfPubkey={selfPubkey}
        flat
        tailKey={`${rootId}:${lastReply.id}:${threadMessages.length}`}
        highlightId={permalinkMessageId}
        scrollToMessageId={permalinkMessageId}
      />
      <Composer
        members={members}
        profiles={profiles}
        threadRef={rootThreadRef}
        // The composer answers the thread itself, so the hint names its root
        // author (the desktop's `Reply in thread to <head author>`).
        placeholder={`Reply in thread to ${rootAuthor}`}
        strictMentions={strictMentions}
        // Esc has nothing mid-thread to step back out of — it closes the pane.
        onClearThread={onClose}
        send={send}
      />
    </aside>
  );
}

type ComposerProps = Parameters<typeof Composer>[0];
