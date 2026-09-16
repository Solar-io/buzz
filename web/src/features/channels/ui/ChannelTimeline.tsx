import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { VList, type VListHandle } from "virtua";
import type { MessageBuffer, TimelineMessage } from "../lib/messageBuffer.ts";
export type { ChannelMember, Profile } from "../hooks.ts";
import type { Profile } from "../hooks.ts";
import { formatElapsed } from "@/features/agents/ui/WorkingBadge";
import {
  applyInputFollowScroll,
  armFollowInput,
  createInputFollowState,
  forceInputFollow,
} from "@/features/agents/lib/scrollFollow";
import { isWithinGroupingWindow } from "@/features/channels/lib/messageGrouping";
import {
  decideTimelineRecovery,
  LIST_COLLAPSED_MAX,
} from "@/features/channels/lib/timelineRecovery";
import { decideGeometryDiagnostic } from "@/features/channels/lib/geometryDiagnostic";
import { chainEntry } from "@/features/channels/lib/geometryDiagnostic";
import { GeometryDiagnosticOverlay } from "./GeometryDiagnosticOverlay.tsx";
import { authorLabel } from "../lib/authorLabel.ts";
import { formatDayLabel } from "../lib/dateFormatters.ts";
import {
  reactionGroups as groupReactions,
  type ReactionIndex,
} from "../lib/reactions.ts";
import { SYSTEM_MESSAGE_KIND } from "../lib/systemEvent.ts";
import {
  threadIndentRem,
  type ThreadBranchSummary,
} from "../lib/threadTree.ts";
import { AuthorAvatar } from "./AuthorAvatar.tsx";
import { ThreadBranchChip } from "./ThreadBranchChip.tsx";
import { MessageRow } from "./MessageRow.tsx";
import { DayDivider, UnreadDivider } from "./TimelineDividers.tsx";
import {
  describeSystemMessage,
  SystemMessageRow,
} from "./SystemMessageRow.tsx";

// Re-exported for the sidebar DM rows, the agent panels and the huddle bar,
// which have imported them from this module since before the row components
// were split out.
export { AuthorAvatar } from "./AuthorAvatar.tsx";
export { authorLabel } from "../lib/authorLabel.ts";

const EMPTY_REACTIONS: ReactionIndex = new Map();
const EMPTY_PENDING: ReadonlySet<string> = new Set();

/** Keys whose default action scrolls the scroller (desktop parity set). */
const SCROLL_INTENT_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return (
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  );
}

/** Nested-thread rendering inputs — see the `threadLayout` prop. */
export interface ThreadLayout {
  /** Message id → tree depth. 0/absent renders flush, as before. */
  depthById: ReadonlyMap<string, number>;
  /** Message id → its hidden sub-branch, when collapsed. */
  summaryById: ReadonlyMap<string, ThreadBranchSummary>;
  /** Expand the branch under this message. */
  onExpand: (parentId: string) => void;
}

export function ChannelTimeline({
  messages,
  profiles,
  replyCounts,
  onOpenThread,
  activeRootId,
  flat,
  workingAgent,
  reactions,
  onReact,
  onUnreact,
  onEdit,
  onDelete,
  onShare,
  selfPubkey,
  agentPubkeys,
  highlightId,
  unreadBefore,
  typingNames,
  pendingIds,
  tailKey,
  onLoadOlder,
  loadingOlder,
  historyExhausted,
  threadLayout,
}: {
  messages: MessageBuffer;
  profiles: Map<string, Profile>;
  replyCounts: Map<string, number>;
  onOpenThread: (message: TimelineMessage) => void;
  /** Root id of the currently open thread — highlights it in the timeline. */
  activeRootId?: string | null;
  /**
   * Thread-panel mode: render EVERY message as a full row. Without this,
   * replies render as inline previews under their root — correct for the
   * channel timeline, but inside an open thread the replies ARE the
   * conversation and must show in full.
   */
  flat?: boolean;
  /** When set, renders the "received and working" typing row at the bottom. */
  workingAgent?: { name: string; startedAt: number } | null;
  /** Kind-7 reactions aggregated per target id. */
  reactions?: ReactionIndex;
  /** Send a reaction (emoji) on a message. */
  onReact?: (messageId: string, emoji: string) => void;
  /**
   * Remove the viewer's OWN reaction — a NIP-09 kind-5 deletion of their
   * kind-7, not a second kind-7. Without it, a chip the viewer is already
   * part of renders pressed but is inert (clicking would otherwise re-send a
   * reaction the relay dedupes server-side, so the chip would never clear).
   */
  onUnreact?: (messageId: string, emoji: string) => void;
  /** Begin editing one of the viewer's own messages. */
  onEdit?: (message: TimelineMessage) => void;
  /** Delete one of the viewer's own messages (confirmed in the action bar). */
  onDelete?: (messageId: string) => void;
  /** Copy a permalink to any message. */
  onShare?: (messageId: string) => void;
  /** The viewer's pubkey — gates edit/delete and drives reaction self-state. */
  selfPubkey?: string | null;
  /**
   * Authors known to be agents (derived from the observer store — any agent
   * that has emitted frames this session). Rows get the desktop's identity
   * treatment: an "agent" chip plus the author's truncated address.
   */
  agentPubkeys?: ReadonlySet<string>;
  /** Permalink target — the row scrolls into view and flashes once. */
  highlightId?: string | null;
  /** createdAt of the first UNSEEN message — renders the unread divider. */
  unreadBefore?: number | null;
  /** Display names of people typing in this channel (footer row). */
  typingNames?: string[];
  /**
   * Ids of optimistically inserted sends still awaiting their relay OK. Those
   * rows render the desktop's "Sending…" status. The web client has no
   * optimistic insert yet, so this is empty in production today; the row
   * surface exists so wiring one is a prop change rather than a redesign.
   */
  pendingIds?: ReadonlySet<string>;
  /**
   * Auto-tail trigger: every change scrolls the list to its bottom (the
   * desktop's VList pattern) — but only while the reader is FOLLOWING (at
   * the bottom; any upward scroll pauses, returning to the bottom resumes —
   * see lib/scrollFollow.ts). Compose it from the view + newest message id
   * (`${channelId}:${lastMessageId}` in the timeline,
   * `${rootId}:${lastReply.id}:${count}` in a thread panel): the FIRST
   * segment identifies the view, and a change of it (channel/thread switch)
   * always re-lands on the newest row. Null disables tailing.
   */
  tailKey?: string | null;
  /** Scroll-up pagination: called when the viewport reaches the top. */
  onLoadOlder?: () => void;
  /** An older-history page is in flight (renders the top loading row). */
  loadingOlder?: boolean;
  /** Older pagination already hit the channel start — stop offering it. */
  historyExhausted?: boolean;
  /**
   * Nested-thread rendering (thread panel only, alongside `flat`).
   *
   * `depthById` indents a reply by its position in the NIP-10 tree, and
   * `summaryById` puts a collapsed-branch chip under any reply whose own
   * sub-branch is hidden. Omit it and the list renders exactly as before —
   * the channel timeline never nests, because its rows are thread ROOTS.
   */
  threadLayout?: ThreadLayout;
}) {
  const listRef = useRef<VListHandle>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  /**
   * Zero-height recovery (D-025 height leg, 2026-09-15): WebKit can drop
   * the VList's size notification inside a ResizeObserver cycle that its
   * own row churn trips (see lib/timelineRecovery.ts for the traced
   * mechanism), freezing the list at height 0 while the wrapper stays
   * tall. The wrapper can't lose its height — the shell reserves it — so
   * "wrapper tall, list near zero, sustained" means the race was lost and
   * a remount is the recovery (no reader position exists at height 0 to
   * preserve; a HEALTHY list must never hit this path — the guard fires
   * only near zero, CO's constraint). Bounded: MAX_RECOVERIES remounts,
   * watcher stands down once the list measures tall.
   */
  const [recoveryNonce, bumpRecovery] = useReducer((x: number) => x + 1, 0);
  const collapsedBeatsRef = useRef(0);
  const recoveriesRef = useRef(0);
  const [diagLines, setDiagLines] = useState<string[] | null>(null);
  /**
   * Geometry self-diagnostic (D-025 criterion 1): every rig fills; only a
   * real device has shown the squeeze, so when the on-screen geometry is
   * wrong the phone reports its own DOM (see lib/geometryDiagnostic.ts for
   * the trigger and the named healthy exclusions). Debounced two beats so
   * mount flicker cannot arm it; fires once per mount.
   */
  const diagBeatsRef = useRef(0);
  const diagFiredRef = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (diagFiredRef.current) { window.clearInterval(timer); return; }
      const wrap = wrapRef.current;
      if (!wrap) return;
      const list = wrap.querySelector<HTMLElement>(".buzz-timeline-scrollbar");
      if (!list) return;
      const composer = [...document.querySelectorAll("textarea")].find(
        (t) => t.getBoundingClientRect().height > 10,
      );
      const decision = decideGeometryDiagnostic({
        timelineMounted: true,
        timelineRows: list.children.length,
        composerPresent: Boolean(composer),
        timelineHeight: Math.round(list.getBoundingClientRect().height),
        wrapperHeight: Math.round(wrap.getBoundingClientRect().height),
      });
      if (!decision.fire) { diagBeatsRef.current = 0; return; }
      diagBeatsRef.current += 1;
      if (diagBeatsRef.current < 2) return;
      diagFiredRef.current = true;
      window.clearInterval(timer);
      const scriptTag = document.querySelector<HTMLScriptElement>('script[src*="index-"]');
      const lines = [
        `buzz-geometry-diag trigger=${decision.trigger} vh=${window.innerHeight} vw=${window.innerWidth}`,
        `bundle=${scriptTag ? scriptTag.src.split("/").pop() : "unknown"}`,
        `rows=${list.children.length} listH=${Math.round(list.getBoundingClientRect().height)} wrapH=${Math.round(wrap.getBoundingClientRect().height)}`,
        "chain:",
      ];
      let el: HTMLElement | null = list;
      for (let depth = 0; el && depth < 14; depth++) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        lines.push(
          chainEntry(
            depth,
            el.tagName.toLowerCase(),
            typeof el.className === "string" ? el.className : "",
            Math.round(r.top),
            Math.round(r.height),
            `${cs.flexGrow}/${cs.flexShrink}/${cs.flexBasis}`,
            cs.alignItems,
            cs.justifyContent,
          ),
        );
        el = el.parentElement;
      }
      setDiagLines(lines);
    }, 500);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    collapsedBeatsRef.current = 0;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const list = wrap.querySelector<HTMLElement>(".buzz-timeline-scrollbar");
      const wrapperHeight = wrap.getBoundingClientRect().height;
      const listHeight = list ? list.getBoundingClientRect().height : 0;
      if (listHeight > LIST_COLLAPSED_MAX) {
        // Genuinely tall: stand down for this mount lineage.
        window.clearInterval(timer);
        return;
      }
      const decision = decideTimelineRecovery({
        wrapperHeight,
        listHeight,
        collapsedBeats: collapsedBeatsRef.current,
        recoveries: recoveriesRef.current,
      });
      collapsedBeatsRef.current = decision.collapsedBeats;
      if (decision.action === "recover") {
        recoveriesRef.current += 1;
        window.clearInterval(timer);
        bumpRecovery();
      } else if (Date.now() - startedAt > 12_000) {
        // Cold-start budget exhausted without a collapse: stop watching.
        window.clearInterval(timer);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [recoveryNonce]);
  /**
   * Follow-the-tail state (see features/agents/lib/scrollFollow.ts — the
   * InputFollowState engine): the timeline tails new messages ONLY while
   * following. Tailing pauses on a reader's upward INPUT (touch, wheel,
   * scrollbar, scroll keys — armed by the input listeners below, paused by
   * the first upward movement that input produces) so a fast stream cannot
   * re-pin the bottom between the reader's small upward deltas and erase
   * them before they add up to an escape ("it stops for a second, then it
   * just keeps scrolling on by" — Sam, 2026-09-13). Scrolling back to the
   * very bottom resumes.
   *
   * Pause is keyed on INPUT, not on scroll deltas (the engine ported from
   * the desktop's useVirtualizedBottomSettle, 2026-09-14): a virtualizer
   * emits plenty of upward scroll EVENTS of its own while converging on a
   * programmatic scrollToIndex, and on iOS WKWebView they arrive detached
   * from the jump that caused them — a delta-paused engine then pauses its
   * own tail mid-settle, and every later send lands below the fold (live
   * incident, Sam 2026-09-14). Scroll events are still read — in a
   * CAPTURE-phase listener on the wrapper div, reading the scroller's
   * NATIVE metrics (scrollTop/scrollHeight/clientHeight off event.target) —
   * but only to consume armed inputs and to detect the at-bottom resume,
   * never through virtua's handle, whose scrollOffset/scrollSize can still
   * hold the pre-event values when the handler runs (measured live: a
   * reader 275px up was yanked to the bottom because the handler computed
   * at-bottom from stale handle metrics).
   */
  const followRef = useRef(createInputFollowState(true));
  /**
   * Has this view completed its FIRST auto-tail to the newest row? The
   * older-history pagination trigger must not fire before it: on mount the
   * scroller sits at offset 0 and iOS emits a spurious top-reached scroll
   * during first layout / URL-bar settle (dvh) — firing loadOlder there
   * pins the viewport to the OLDEST row via the pagination restore and
   * suppresses the tail outright (pagePhase never returns to idle before
   * it), which is exactly "I enter the channel and it starts at the very
   * first message" (Sam, 2026-09-14, iPhone).
   */
  const tailedRef = useRef(false);
  /** Newest row index, refreshed every render for the geometry re-pin. */
  const itemsLengthRef = useRef(0);
  /** Pending rAF of the geometry re-pin (coalesced like the desktop's). */
  const pinRafRef = useRef<number | null>(null);
  /** View identity (tailKey's first segment: channel id / thread root). */
  const viewKeyRef = useRef<string | null>(null);
  /**
   * Pagination scroll anchor: when an older page lands, the list must not
   * jump to the NEW top — it re-pins to the row the user was reading. The
   * phases: idle → loading (top reached, page requested) → restore (page
   * landed, pin the anchor) → idle.
   */
  const pagePhase = useRef<"idle" | "loading" | "restore">("idle");
  const anchorIdRef = useRef<string | null>(null);
  /** message id → item index, rebuilt every render by the row loop. */
  const rowIndexRef = useRef<Map<string, number> | null>(null);
  /**
   * Per-item day label and "is itself a day divider", rebuilt every render
   * and read through refs so the scroll handler stays reference-stable.
   */
  const itemDaysRef = useRef<(string | null)[]>([]);
  const itemIsDividerRef = useRef<boolean[]>([]);
  const [pinnedDay, setPinnedDay] = useState<string | null>(null);
  const isEmpty = messages.length === 0;
  const pending = pendingIds ?? EMPTY_PENDING;
  let lastAuthor: string | null = null;
  let lastKind = 0;
  /** Tree depth of the previously rendered row — a change breaks grouping. */
  let lastDepth = 0;
  // createdAt (Unix seconds) of the previous RENDERED message — the anchor
  // for the grouping window. Chained like the desktop: each message compares
  // against its immediate predecessor, grouped or not.
  let lastRenderedAt: number | null = null;
  let lastDay = "";
  let currentDayLabel = "";
  let unreadShown = false;
  const rows: ReactElement[] = [];
  /** Day label in force for each entry of `rows`, and divider-ness. */
  const rowDays: string[] = [];
  const rowIsDivider: boolean[] = [];
  const pushRow = (row: ReactElement, isDivider = false) => {
    rows.push(row);
    rowDays.push(currentDayLabel);
    rowIsDivider.push(isDivider);
  };
  const rowIndex = new Map<string, number>();
  rowIndexRef.current = rowIndex;
  /** Which roots the buffer can actually render under — see the orphan branch. */
  const bufferedIds = new Set(messages.map((message) => message.id));
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    // Deleted messages disappear from the timeline entirely (desktop parity:
    // the overlay tombstones them out of the rendered list).
    if (message.deleted) {
      lastAuthor = null;
      lastRenderedAt = null;
      continue;
    }
    const day = new Date(message.createdAt * 1000).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      lastAuthor = null;
      lastRenderedAt = null;
      currentDayLabel = formatDayLabel(message.createdAt);
      pushRow(<DayDivider key={`day:${day}`} label={currentDayLabel} />, true);
    }
    if (
      !unreadShown &&
      unreadBefore != null &&
      message.createdAt >= unreadBefore
    ) {
      unreadShown = true;
      pushRow(<UnreadDivider key="unread" />);
    }
    // Kind 40099 is a SYSTEM row, not a message row: joins, leaves and
    // deletion tombstones. It renders centered and muted with no author
    // card, so it never participates in author grouping — reset the chain so
    // the next real message starts a fresh block instead of merging with the
    // one before the system row. A payload the row cannot describe (an event
    // type outside this pass's scope) renders nothing at all rather than
    // spilling raw JSON into the conversation.
    if (message.kind === SYSTEM_MESSAGE_KIND) {
      lastAuthor = null;
      lastRenderedAt = null;
      const description = describeSystemMessage(message, profiles);
      if (!description) {
        continue;
      }
      rowIndex.set(message.id, rows.length);
      pushRow(<SystemMessageRow key={message.id} description={description} />);
      continue;
    }
    // Replies render INLINE under their root (desktop pattern: indented
    // previews with a connector rail, click opens the full thread panel) —
    // but only when the root is in the buffer to render under. An orphan
    // (root older than the fetched page, deleted, or pruned) used to
    // `continue` into nothing while its day divider still rendered above
    // it: the timeline claimed the day's activity and refused to show it
    // (D-025 follow-up, reproduced on the CK DM — divider, zero rows). It
    // now falls through as a top-level row, so the newest message is always
    // visible somewhere.
    if (!flat && (message.rootId || message.replyToId)) {
      const rootId = message.rootId ?? message.replyToId ?? "";
      if (bufferedIds.has(rootId)) {
        lastAuthor = null;
        continue;
      }
      lastAuthor = null;
    }
    const replies = flat
      ? []
      : messages.filter(
          (m) => m.rootId === message.id || m.replyToId === message.id,
        );
    // Continuation = consecutive same author + kind AND inside the desktop's
    // 10-minute grouping window. The window is the fix for messages from
    // "earlier in the day" rendering merged into a prior block with no
    // timestamp of their own.
    // Nested threads: a reply's own indent is part of how it is read, so a
    // depth change always starts a fresh block. Grouping it into the row
    // above would drop its avatar and leave an indented, unattributed
    // paragraph hanging under someone else's reply.
    const depth = threadLayout?.depthById.get(message.id) ?? 0;
    const grouped =
      message.authorPubkey === lastAuthor &&
      message.kind === lastKind &&
      depth === lastDepth &&
      isWithinGroupingWindow(lastRenderedAt, message.createdAt);
    lastAuthor = message.authorPubkey;
    lastKind = message.kind;
    lastDepth = depth;
    lastRenderedAt = message.createdAt;
    rowIndex.set(message.id, rows.length);
    const branch = threadLayout?.summaryById.get(message.id) ?? null;
    const row = (
      <MessageRow
        key={message.id}
        message={message}
        profiles={profiles}
        grouped={grouped}
        replyCount={flat ? 0 : (replyCounts.get(message.id) ?? 0)}
        onOpenThread={onOpenThread}
        active={!flat && activeRootId === message.id}
        reactionGroups={groupReactions(
          reactions ?? EMPTY_REACTIONS,
          message.id,
          selfPubkey,
        )}
        onReact={onReact}
        onUnreact={onUnreact}
        onEdit={onEdit}
        onDelete={onDelete}
        onShare={onShare}
        canModify={selfPubkey === message.authorPubkey}
        isAgent={agentPubkeys?.has(message.authorPubkey) ?? false}
        highlighted={message.id === highlightId}
        pending={pending.has(message.id)}
        selfPubkey={selfPubkey}
      >
        {replies.length > 0 && (
          <ThreadPreview
            replies={replies}
            profiles={profiles}
            onOpenThread={onOpenThread}
            root={message}
          />
        )}
        {branch && threadLayout && (
          <ThreadBranchChip
            summary={branch}
            profiles={profiles}
            onExpand={threadLayout.onExpand}
          />
        )}
      </MessageRow>
    );
    if (depth > 0) {
      // Indent the whole row, with a rail on its leading edge so the eye can
      // follow a branch down the panel. `paddingInlineStart` (not a margin)
      // keeps the rail flush against the row it belongs to.
      pushRow(
        <div
          key={message.id}
          data-testid="thread-reply-indent"
          data-depth={depth}
          className="border-l border-border/60"
          style={{ marginInlineStart: `${threadIndentRem(depth)}rem` }}
        >
          {row}
        </div>,
      );
      continue;
    }
    pushRow(row);
  }
  // Virtualized (virtua VList — the desktop's timeline virtualizer): only the
  // visible window of rows mounts, so a 500-message buffer scrolls smoothly.
  // Each row carries its own max-w centering wrapper so line lengths stay
  // readable on wide desktops without affecting phone layout.
  const items: ReactNode[] = [
    ...rows.map((row) => (
      <div key={row.key} className="mx-auto w-full max-w-3xl px-1 sm:px-3">
        {row}
      </div>
    )),
  ];
  const itemDays: (string | null)[] = [...rowDays];
  const itemIsDivider: boolean[] = [...rowIsDivider];
  if (loadingOlder) {
    // Prepended (not appended): the reader is at the top waiting for it.
    // This row exists only while a page is in flight, so it never shifts
    // the anchor math of a completed restore.
    items.unshift(
      <div
        key="older-loading"
        className="mx-auto w-full max-w-3xl px-1 sm:px-3"
      >
        <div className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
          <span className="inline-block size-3 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-transparent" />
          <span>Loading earlier messages…</span>
        </div>
      </div>,
    );
    itemDays.unshift(null);
    itemIsDivider.unshift(false);
  }
  if (typingNames && typingNames.length > 0) {
    items.push(
      <div key="typing" className="mx-auto w-full max-w-3xl px-1 sm:px-3">
        <div className="mt-1 flex items-center gap-2 px-2 py-0.5 text-sm text-muted-foreground">
          <span className="flex gap-0.5">
            <span className="animate-bounce [animation-delay:0ms]">·</span>
            <span className="animate-bounce [animation-delay:150ms]">·</span>
            <span className="animate-bounce [animation-delay:300ms]">·</span>
          </span>
          <span>
            {typingNames.slice(0, 3).join(", ")}
            {typingNames.length > 3 ? ` +${typingNames.length - 3}` : ""}{" "}
            {typingNames.length === 1 ? "is" : "are"} typing
          </span>
        </div>
      </div>,
    );
    itemDays.push(null);
    itemIsDivider.push(false);
  }
  if (workingAgent) {
    items.push(
      <div key="working" className="mx-auto w-full max-w-3xl px-1 sm:px-3">
        <div className="mt-2 flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <span>{workingAgent.name} received it and is working</span>
          <span className="tabular-nums">
            ·{" "}
            {formatElapsed(
              workingAgent.startedAt,
              Math.floor(Date.now() / 1000),
            )}
          </span>
        </div>
      </div>,
    );
    itemDays.push(null);
    itemIsDivider.push(false);
  }
  itemDaysRef.current = itemDays;
  itemIsDividerRef.current = itemIsDivider;
  // Newest row index for the geometry-driven re-pin below (kept in a ref so
  // the ResizeObserver callback never closes over a stale render).
  itemsLengthRef.current = items.length;

  /**
   * Which day the row at the top of the viewport belongs to. Null while that
   * row IS the day's own divider, so the pinned pill and the in-flow pill
   * never render on top of each other.
   */
  const resolvePinnedDay = useCallback((offset: number) => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const index = list.findItemIndex(offset);
    const days = itemDaysRef.current;
    if (index < 0 || index >= days.length || itemIsDividerRef.current[index]) {
      setPinnedDay(null);
      return;
    }
    setPinnedDay(days[index]);
  }, []);

  // Auto-tail: tailKey changes → scroll to the newest row. Double-rAF lets
  // virtua measure freshly mounted rows; the settle pass catches late-sizing
  // media, and the ResizeObserver settle below catches it even later (iOS
  // images size in seconds after the jump — a 250ms guess is not a
  // mechanism). Tailing is keyed on tailKey ONLY — an older-history page
  // growing the list must not yank the reader to the bottom — and never
  // fires while a pagination restore is pinning the viewport to its anchor
  // row. And it fires only WHILE FOLLOWING (followRef): a reader scrolled up
  // to read is never yanked to the bottom by a new message; the tail resumes
  // when they scroll back to the bottom (see handleScroll). Two always-follow
  // exceptions, both desktop parity: a view switch (channel / thread change —
  // tailKey's first segment) re-lands on the newest row, and the reader's
  // OWN send force-follows so their message is never left below the fold
  // (desktop `prepareForOwnMessage`: "the user's own send is the deliberate
  // Zulip exception" — a send is the clearest possible show-me-the-bottom
  // signal, even when the reader had scrolled up).
  // items.length is read for the bottom index only; tailKey is the trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pagination pages must not re-tail
  useEffect(() => {
    if (!tailKey || pagePhase.current !== "idle") {
      return;
    }
    const viewKey = tailKey.split(":")[0];
    if (viewKeyRef.current !== viewKey) {
      viewKeyRef.current = viewKey;
      forceInputFollow(followRef.current);
      followRef.current.prevScrollTop = 0;
      tailedRef.current = false;
    }
    // The own-send exception: the tailKey that just changed named THIS
    // message as the newest row, and it is the viewer's own.
    if (
      selfPubkey != null &&
      messages.length > 0 &&
      messages[messages.length - 1].authorPubkey === selfPubkey
    ) {
      forceInputFollow(followRef.current);
    }
    const toBottom = () => {
      if (!followRef.current.follow) {
        return;
      }
      tailedRef.current = true;
      listRef.current?.scrollToIndex(itemsLengthRef.current - 1, {
        align: "end",
      });
    };
    const raf = requestAnimationFrame(() => requestAnimationFrame(toBottom));
    const settle = window.setTimeout(toBottom, 250);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
  }, [tailKey]);

  // Follow tick: a NATIVE capture-phase scroll listener on the wrapper div,
  // attached in an effect — not a React prop. Measured live: native capture
  // delivery to the wrapper works, but React's onScrollCapture never fires
  // for descendant scroll events (React does not delegate or direct-attach
  // capture listeners for non-bubbling events). Reads the scroller's own
  // metrics off event.target — see the followRef doc above for why the
  // virtua handle is not trusted. Inner per-message scrollers (horizontal
  // code blocks) are skipped: they have no vertical extent.
  const handleFollowScroll = useCallback((event: Event) => {
    const el = event.target as HTMLElement;
    if (!el || el === event.currentTarget) {
      return;
    }
    if (el.scrollHeight - el.clientHeight < 2) {
      return;
    }
    applyInputFollowScroll(
      followRef.current,
      el.scrollTop,
      el.scrollHeight,
      el.clientHeight,
      performance.now(),
    );
  }, []);

  // Reader-input arm: the pause signal for the follow engine. touchmove /
  // wheel / a direct scroller pointerdown (scrollbar or background drag) /
  // scroll-intent keys — the desktop useVirtualizedBottomSettle retire set,
  // here as ARMS: the engine pauses only when an armed input is followed by
  // actual upward movement (see scrollFollow.ts). A descendant pointerdown
  // is ordinary row interaction and deliberately does not arm.
  // biome-ignore lint/correctness/useExhaustiveDependencies: isEmpty re-attaches on the 0 → N mount
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) {
      return;
    }
    const scroller = wrap.firstElementChild;
    const arm = () => armFollowInput(followRef.current, performance.now());
    const armForPointer = (event: PointerEvent) => {
      if (event.target === scroller) {
        arm();
      }
    };
    const armForScrollKey = (event: KeyboardEvent) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !(event.target instanceof Node) ||
        !(scroller instanceof Node) ||
        !scroller.contains(event.target) ||
        isEditableKeyboardTarget(event.target)
      ) {
        return;
      }
      if (SCROLL_INTENT_KEYS.has(event.key)) {
        arm();
      }
    };
    wrap.addEventListener("touchmove", arm, { capture: true, passive: true });
    wrap.addEventListener("wheel", arm, { capture: true, passive: true });
    wrap.addEventListener("pointerdown", armForPointer, {
      capture: true,
      passive: true,
    });
    window.addEventListener("keydown", armForScrollKey, true);
    wrap.addEventListener("scroll", handleFollowScroll, {
      capture: true,
      passive: true,
    });
    return () => {
      wrap.removeEventListener("touchmove", arm, { capture: true });
      wrap.removeEventListener("wheel", arm, { capture: true });
      wrap.removeEventListener("pointerdown", armForPointer, {
        capture: true,
      } as EventListenerOptions);
      window.removeEventListener("keydown", armForScrollKey, true);
      wrap.removeEventListener("scroll", handleFollowScroll, {
        capture: true,
      } as EventListenerOptions);
    };
    // isEmpty: the empty state renders BEFORE the wrapper div exists, so the
    // 0 → N message transition must re-attach.
  }, [handleFollowScroll, isEmpty]);

  // Geometry settle (desktop parity, useVirtualizedBottomSettle): while
  // following, ANY geometry change re-pins the newest row — virtua measuring
  // freshly mounted rows, inline media sizing in after the jump (frames grew
  // 384x256 → 720x540 on 2026-09-13, so this is no longer sub-pixel), the
  // iOS keyboard collapsing the scroller. The rAF coalesces the burst of
  // observer callbacks a virtualized remount produces. Not following → no
  // pin, so a reader scrolled up is never yanked by a resize.
  // biome-ignore lint/correctness/useExhaustiveDependencies: isEmpty re-attaches on the 0 → N mount
  useEffect(() => {
    const wrap = wrapRef.current;
    const scroller = wrap?.firstElementChild;
    if (!(scroller instanceof HTMLElement)) {
      return;
    }
    const pin = () => {
      if (!followRef.current.follow || pinRafRef.current !== null) {
        return;
      }
      pinRafRef.current = requestAnimationFrame(() => {
        pinRafRef.current = null;
        // Re-check inside the frame: reader input can pause follow between the
        // ResizeObserver callback and this frame. The reader's pause wins — a
        // pin scheduled one frame earlier must not yank them back to the tail
        // (both panels already re-check here; D-027 parity, measured live as a
        // ~580px post-pause jump in Platform Team 2026-09-16).
        if (followRef.current.follow) {
          listRef.current?.scrollToIndex(itemsLengthRef.current - 1, {
            align: "end",
          });
        }
      });
    };
    const observer = new ResizeObserver(pin);
    observer.observe(scroller);
    const content = scroller.firstElementChild;
    if (content instanceof HTMLElement) {
      observer.observe(content);
    }
    return () => {
      observer.disconnect();
      if (pinRafRef.current !== null) {
        cancelAnimationFrame(pinRafRef.current);
        pinRafRef.current = null;
      }
    };
    // isEmpty: same re-attach reason as the listener effect above.
  }, [isEmpty]);

  // Top reached → request one older page (once per flight). Also the pinned
  // day-divider tick: it is the only scroll signal virtua gives us. The
  // pagination trigger is gated on the FIRST auto-tail having landed: before
  // it, offset 0 means "just mounted", not "the reader reached the top" —
  // iOS emits a spurious top-reached scroll during first layout / URL-bar
  // settle, and an un-gated loadOlder there pins the view to the oldest row
  // (the pagination restore) while suppressing the tail — the enter-at-top
  // bug. A short channel whose whole history fits (top === bottom) still
  // paginates: the tail lands instantly there, then offset 0 counts.
  const handleScroll = useCallback(
    (offset: number) => {
      resolvePinnedDay(offset);
      if (
        !tailedRef.current ||
        offset > 4 ||
        pagePhase.current !== "idle" ||
        loadingOlder ||
        historyExhausted ||
        messages.length === 0 ||
        !onLoadOlder
      ) {
        return;
      }
      anchorIdRef.current = messages[0].id;
      pagePhase.current = "loading";
      onLoadOlder();
    },
    [loadingOlder, historyExhausted, messages, onLoadOlder, resolvePinnedDay],
  );

  // Older page landed: pin the viewport back to the row the user was reading
  // instead of letting the list jump to its new top.
  useEffect(() => {
    if (pagePhase.current !== "loading" || loadingOlder) {
      return;
    }
    const anchorId = anchorIdRef.current;
    const landedNew =
      anchorId != null && messages.length > 0 && messages[0].id !== anchorId;
    if (!landedNew) {
      pagePhase.current = "idle";
      anchorIdRef.current = null;
      return;
    }
    pagePhase.current = "restore";
    const target = rowIndexRef.current?.get(anchorId);
    if (target == null) {
      pagePhase.current = "idle";
      return;
    }
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        listRef.current?.scrollToIndex(target, { align: "start" });
        pagePhase.current = "idle";
        anchorIdRef.current = null;
      }),
    );
    return () => cancelAnimationFrame(raf);
  }, [loadingOlder, messages]);

  // First paint (and any change to the rendered set) settles the pinned pill
  // without waiting for the reader to scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-resolve whenever the rendered set changes
  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      resolvePinnedDay(listRef.current?.scrollOffset ?? 0),
    );
    return () => cancelAnimationFrame(raf);
  }, [resolvePinnedDay, items.length, tailKey]);

  // Empty state AFTER the hooks — conditional hook order would break the
  // 0 → N message transition.
  if (isEmpty) {
    return (
      <p className="p-8 text-center text-sm text-muted-foreground">
        No messages yet. Say something.
      </p>
    );
  }
  return (
    <div ref={wrapRef} className="relative flex min-h-0 flex-1 flex-col">
      {pinnedDay && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
          <div className="mx-auto w-full max-w-3xl px-1 sm:px-3">
            <DayDivider label={pinnedDay} pinned />
          </div>
        </div>
      )}
      {diagLines && <GeometryDiagnosticOverlay lines={diagLines} />}
      <VList
        key={recoveryNonce}
        ref={listRef}
        className="buzz-timeline-scrollbar min-h-0 flex-1"
        onScroll={handleScroll}
      >
        {items}
      </VList>
    </div>
  );
}

/**
 * Inline thread previews under a root message, in the desktop's shape:
 * indented under the avatar's center line, a connector rail on the left,
 * the newest replies as one-line author + excerpt rows, and the whole block
 * opens the thread panel on click.
 */
function ThreadPreview({
  replies,
  profiles,
  onOpenThread,
  root,
}: {
  replies: TimelineMessage[];
  profiles: Map<string, Profile>;
  onOpenThread: (message: TimelineMessage) => void;
  root: TimelineMessage;
}) {
  const newest = [...replies].sort((a, b) => b.createdAt - a.createdAt);
  const shown = newest.slice(0, 2);
  return (
    <div className="mt-1 ml-[18px] border-l-2 border-border/45 pl-3">
      {shown.map((reply) => (
        <button
          key={reply.id}
          type="button"
          className="flex w-full items-center gap-2 rounded-lg py-0.5 pr-2 text-left hover:bg-muted/50"
          onClick={() => onOpenThread(root)}
        >
          <AuthorAvatar
            pubkey={reply.authorPubkey}
            label={authorLabel(reply.authorPubkey, profiles)}
            picture={profiles.get(reply.authorPubkey)?.avatar}
            size="sm"
          />
          <span className="shrink-0 text-sm font-medium">
            {authorLabel(reply.authorPubkey, profiles)}
          </span>
          <span className="truncate text-sm text-muted-foreground">
            {plainExcerpt(reply.content)}
          </span>
        </button>
      ))}
      {newest.length > shown.length && (
        <button
          type="button"
          className="py-0.5 pr-2 text-sm font-medium text-muted-foreground hover:underline"
          onClick={() => onOpenThread(root)}
        >
          +{newest.length - shown.length} more →
        </button>
      )}
    </div>
  );
}

function plainExcerpt(content: string): string {
  return content.replace(/[`*_~#>]/g, "").slice(0, 120);
}
