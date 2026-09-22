import { useEffect, useMemo } from "react";
import type { MessageBuffer, TimelineMessage } from "../lib/messageBuffer.ts";
import type { ChannelMember, Profile } from "../hooks.ts";
import { buildThreadIndex, threadDescendants } from "../lib/threadTree.ts";
import {
  loadThreadReadState,
  markThreadSeen,
  saveThreadReadState,
} from "../lib/threadReadState.ts";
import { useThreadLayout } from "@/features/settings/lib/appearanceStore.ts";
import { cn } from "@/shared/lib/cn";
import { authorLabel, ChannelTimeline } from "./ChannelTimeline.tsx";
import { Composer } from "./Composer.tsx";

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
 * Thread view: the root message, the thread's replies, and a composer. At
 * lg+ the panel docks right; its width comes from the shared --thread-width
 * CSS variable the shell maintains (drag handle there). There is no header
 * band (Sam, 2026-09-22) — the composer row's Replies/brain toggles own
 * show/hide and tab switching now; the pane keeps only a floating ✕ for the
 * overlay forms where that row is covered.
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
 * still render threaded.
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
  mobileOnly,
  strictMentions = false,
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
  /** Overlay on small screens only — used when the DM right pane shows the
   *  thinking tab at lg but a thread was opened from the timeline. */
  mobileOnly?: boolean;
  /** Huddle replies must resolve every identity before they can wake a peer. */
  strictMentions?: boolean;
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

  const lastReply = replies[replies.length - 1] ?? root;
  // Auto-tail (Sam 8/31): thread-heavy agents have long threads — the panel
  // must open on the NEWEST reply, not the root. The timeline's tailKey
  // handles it now that the list is virtualized.

  // Marking the thread seen on open survives the header's removal: the
  // per-thread read state is the record of "you were here", and dropping the
  // write would silently regress it for whatever reads it next (the badge is
  // gone TODAY; lib/threadReadState.ts and its tests stay live).
  const newestReplyAt = lastReply.createdAt;
  useEffect(() => {
    const state = loadThreadReadState();
    const next = markThreadSeen(state, rootId, newestReplyAt);
    if (next !== state) {
      saveThreadReadState(next);
    }
  }, [rootId, newestReplyAt]);

  const rootAuthor = authorLabel(root.authorPubkey, profiles);
  // The composer ALWAYS answers the thread itself — there is no mid-thread
  // target to aim at anymore, and the wire shape is the constant single
  // ["e", root, "", "reply"] tag (see the docblock).
  const rootThreadRef = { rootId, replyToId: rootId };

  // Two-person threads notify the other person (Sam 2026-09-20: "if two
  // people are the only ones in the conversation, then I shouldn't have to
  // tag them"). A DM-shaped thread, or a side thread off #general with one
  // other voice in it, otherwise reaches NOBODY — a mention is the only wake
  // path, and neither side types one. Participants are the distinct
  // NON-DELETED authors of the root and its replies — exactly the flat list
  // this panel already renders; viewers and lurkers don't count. The rule:
  // authors ∪ {self} must be exactly two people AND self must be one of the
  // authors. That excludes the three shapes where an auto-tag would lie:
  // a solo thread (the author would tag themselves), three or more authors
  // (a mention blast is a decision, not a default), and a viewer who never
  // posted (they have no conversation partner here yet). The author can
  // always add more p-tags by hand; the auto-tag only guarantees the one
  // person who is unambiguously "the other side".
  const autoNotify = useMemo(() => {
    if (!selfPubkey) {
      return null;
    }
    // Deleted authors have left the conversation. threadDescendants keeps
    // deleted rows so their children stay attached (see lib/threadTree.ts),
    // so the filter happens here, where the participants are computed.
    const authors = new Set<string>();
    if (!root.deleted) {
      authors.add(root.authorPubkey);
    }
    for (const reply of replies) {
      if (!reply.deleted) {
        authors.add(reply.authorPubkey);
      }
    }
    if (authors.size !== 2 || !authors.has(selfPubkey)) {
      return null;
    }
    const other = [...authors].find((pubkey) => pubkey !== selfPubkey);
    if (!other) {
      return null;
    }
    return { pubkey: other, label: authorLabel(other, profiles) };
  }, [root, replies, selfPubkey, profiles]);

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
      {/* The header band is gone (Sam, 2026-09-22): the composer row's
          Replies/brain toggles replaced its title, tab switch and unread
          badge, and the summary line said nothing he needed. The ✕ stays —
          as a floating overlay, not a band — but only where the sheet covers
          the composer row and the toggles are unreachable: the full-screen
          forms (below lg, Focus, mobileOnly). Docked at lg the row toggle
          and Esc already dismiss. */}
      <button
        type="button"
        aria-label="Close thread"
        className={cn(
          "absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10 rounded p-1 text-sm text-muted-foreground hover:bg-accent",
          !mobileOnly && layoutMode === "split" && "lg:hidden",
        )}
        onClick={onClose}
      >
        ✕
      </button>
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
        // The two-person-thread wake (see autoNotify above): the pane's
        // composer adds the other participant's p-tag on every send.
        autoNotify={autoNotify}
        // Esc has nothing mid-thread to step back out of — it closes the pane.
        onClearThread={onClose}
        send={send}
      />
    </aside>
  );
}

type ComposerProps = Parameters<typeof Composer>[0];
