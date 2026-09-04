/**
 * The thread as a TREE, not a list.
 *
 * Web threads were one level deep: every reply hung off the root and the
 * composer's NIP-10 `reply` marker was hardcoded to the newest message. The
 * marker was fixed first (lib/threadTarget.ts); this module is the other
 * half — reading those markers back out and rendering the shape they
 * describe.
 *
 * Ported from the desktop's `features/messages/lib/threadPanel.ts` (the
 * index, the descendant stats, the expand-on-demand entry builder) and
 * `threadTreeLayout.ts` (the indent geometry). Pure, so the shape is
 * unit-testable without a DOM.
 *
 * PARENT RESOLUTION. Buzz's wire shape (`buildReplyTags` in the desktop's
 * `messages/lib/threading.ts`, mirrored by web's send path) is:
 *   - reply to the ROOT     → `["e", root, "", "reply"]`  (single tag)
 *   - reply to a REPLY      → `["e", root, "", "root"]` + `["e", parent, "", "reply"]`
 * `timelineMessageFromEvent` already decodes both into `replyToId`, so
 * `replyToId` IS the immediate parent for anything Buzz emitted.
 *
 * The third shape is NIP-10's own: a direct reply to the root MAY carry only
 * a `root`-marked tag and no `reply` marker. The desktop treats that as
 * `parentId: null` — i.e. as a TOP-LEVEL message — which quietly hoists a
 * foreign client's reply out of its thread. Here it resolves to the root,
 * which is what NIP-10 says it means. See `parentIdOf`.
 */

import type { MessageBuffer, TimelineMessage } from "./messageBuffer.ts";

/** Deepest indent step the layout draws; deeper replies share it. */
export const THREAD_MAX_VISIBLE_DEPTH = 6;
/** Indent added per visible depth step, in rem (desktop: Tailwind spacing-9). */
export const THREAD_DEPTH_STEP_REM = 2.25;
/** How many recent participants a collapsed branch's facepile names. */
export const MAX_BRANCH_PARTICIPANTS = 3;

/**
 * The immediate parent of a message, or null when it opens its own thread.
 *
 * Order matters: an explicit `reply` marker (or the single-`e` shorthand,
 * which `timelineMessageFromEvent` folds into the same field) wins over the
 * `root` marker, because only the reply marker names the message the author
 * was actually answering.
 */
export function parentIdOf(message: TimelineMessage): string | null {
  return message.replyToId ?? message.rootId;
}

export interface ThreadDescendantStats {
  /** Every descendant, at any depth. Deleted messages do not count. */
  descendantCount: number;
  /** Direct children only — the relay's `reply_count` analogue. */
  directReplyCount: number;
  /** Newest descendant's created_at, or null when there are none. */
  lastReplyAt: number | null;
  /** Up to MAX_BRANCH_PARTICIPANTS distinct pubkeys, newest first. */
  participantsNewestFirst: string[];
}

export interface ThreadTreeIndex {
  /** Parent id → its direct children, oldest first. */
  childrenByParentId: Map<string, TimelineMessage[]>;
  /** Every message by id, so an entry can resolve its own parent chain. */
  messageById: Map<string, TimelineMessage>;
  /** Descendant rollups, keyed by the ancestor's id. */
  statsById: Map<string, ThreadDescendantStats>;
}

/** A collapsed sub-branch's headline: how many replies, who, and when. */
export interface ThreadBranchSummary {
  /** The message whose branch this summarizes. */
  parentId: string;
  replyCount: number;
  lastReplyAt: number | null;
  /** Oldest-first, so the newest replier renders rightmost (desktop order). */
  participants: string[];
}

export interface ThreadEntry {
  message: TimelineMessage;
  /** 0 = the root; 1 = a direct reply; 2+ = nested. */
  depth: number;
  /** Set when this reply's own branch is collapsed under a summary chip. */
  summary: ThreadBranchSummary | null;
}

function emptyStats(): ThreadDescendantStats {
  return {
    descendantCount: 0,
    directReplyCount: 0,
    lastReplyAt: null,
    participantsNewestFirst: [],
  };
}

/**
 * Index a buffer into a tree.
 *
 * Structure keeps deleted messages (their children must stay attached to
 * something), but the rollups in `statsById` ignore them — a tombstoned
 * reply is not a reply, and the relay decrements its own counters the same
 * way (`crates/buzz-db/src/thread.rs`).
 */
export function buildThreadIndex(buffer: MessageBuffer): ThreadTreeIndex {
  const childrenByParentId = new Map<string, TimelineMessage[]>();
  const messageById = new Map<string, TimelineMessage>();
  const statsById = new Map<string, ThreadDescendantStats>();

  const ordered = buffer
    .map((message, index) => ({ message, index }))
    .sort((left, right) =>
      left.message.createdAt !== right.message.createdAt
        ? left.message.createdAt - right.message.createdAt
        : left.index - right.index,
    )
    .map((entry) => entry.message);

  for (const message of ordered) {
    messageById.set(message.id, message);
    statsById.set(message.id, emptyStats());
  }
  for (const message of ordered) {
    const parentId = parentIdOf(message);
    if (!parentId) {
      continue;
    }
    const siblings = childrenByParentId.get(parentId);
    if (siblings) {
      siblings.push(message);
    } else {
      childrenByParentId.set(parentId, [message]);
    }
  }

  // Walk newest → oldest so the first participant an ancestor sees is the
  // most recent one, matching the relay's `participants` ordering.
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index];
    if (message.deleted) {
      continue;
    }
    const parentId = parentIdOf(message);
    if (!parentId) {
      continue;
    }
    const directParentStats = statsById.get(parentId);
    if (directParentStats) {
      directParentStats.directReplyCount += 1;
    }
    let ancestorId: string | null = parentId;
    // A malformed cycle must not spin forever; the buffer is the bound.
    let hops = 0;
    while (ancestorId && hops <= ordered.length) {
      const stats = statsById.get(ancestorId);
      if (!stats) {
        break;
      }
      stats.descendantCount += 1;
      stats.lastReplyAt = Math.max(stats.lastReplyAt ?? 0, message.createdAt);
      if (
        stats.participantsNewestFirst.length < MAX_BRANCH_PARTICIPANTS &&
        !stats.participantsNewestFirst.includes(message.authorPubkey)
      ) {
        stats.participantsNewestFirst.push(message.authorPubkey);
      }
      const ancestor = messageById.get(ancestorId);
      ancestorId = ancestor ? parentIdOf(ancestor) : null;
      hops += 1;
    }
  }

  return { childrenByParentId, messageById, statsById };
}

/** The collapsed-branch headline for one message, or null when it has none. */
export function branchSummary(
  index: ThreadTreeIndex,
  messageId: string,
): ThreadBranchSummary | null {
  const stats = index.statsById.get(messageId);
  if (!stats || stats.descendantCount === 0) {
    return null;
  }
  return {
    parentId: messageId,
    replyCount: stats.descendantCount,
    lastReplyAt: stats.lastReplyAt,
    participants: [...stats.participantsNewestFirst].reverse(),
  };
}

/**
 * The rows a thread panel renders, in display order.
 *
 * Direct replies of the root always render. A reply that has its own
 * descendants renders collapsed — one summary chip instead of the branch —
 * until its id is in `expandedIds`, which is exactly the desktop's
 * `appendExpandedReplies` behaviour.
 *
 * Deleted replies are not rendered, and their children are PROMOTED to the
 * deleted message's own depth rather than disappearing with it. Threads
 * survive a moderator removing a message in the middle of them.
 */
export function buildThreadEntries(
  index: ThreadTreeIndex,
  rootId: string,
  expandedIds: ReadonlySet<string> = new Set(),
): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  const visited = new Set<string>([rootId]);

  const append = (parentId: string, depth: number) => {
    for (const child of index.childrenByParentId.get(parentId) ?? []) {
      if (visited.has(child.id)) {
        continue;
      }
      visited.add(child.id);
      if (child.deleted) {
        append(child.id, depth);
        continue;
      }
      const expanded = expandedIds.has(child.id);
      entries.push({
        message: child,
        depth,
        summary: expanded ? null : branchSummary(index, child.id),
      });
      if (expanded) {
        append(child.id, depth + 1);
      }
    }
  };

  append(rootId, 1);
  return entries;
}

/**
 * Indent for a reply at `depth`, in rem.
 *
 * The desktop's ladder exactly: depth 1 (a direct reply) sits flush, each
 * further level adds one step, and everything past
 * THREAD_MAX_VISIBLE_DEPTH shares the deepest indent so a runaway thread
 * cannot push its text off the panel.
 */
export function threadIndentRem(depth: number): number {
  const visible = Math.min(
    Math.max(Math.max(0, depth - 1), 0),
    THREAD_MAX_VISIBLE_DEPTH,
  );
  return visible * THREAD_DEPTH_STEP_REM;
}

/** Every reply under a root at any depth, oldest first. */
export function threadDescendants(
  index: ThreadTreeIndex,
  rootId: string,
): TimelineMessage[] {
  const out: TimelineMessage[] = [];
  const seen = new Set<string>([rootId]);
  const walk = (parentId: string) => {
    for (const child of index.childrenByParentId.get(parentId) ?? []) {
      if (seen.has(child.id)) {
        continue;
      }
      seen.add(child.id);
      out.push(child);
      walk(child.id);
    }
  };
  walk(rootId);
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
