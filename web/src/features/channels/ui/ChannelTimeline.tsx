import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { VList, type VListHandle } from "virtua";
import type { MessageBuffer, TimelineMessage } from "../lib/messageBuffer.ts";
export type { ChannelMember, Profile } from "../hooks.ts";
import type { Profile } from "../hooks.ts";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { fetchSignedMedia } from "@/shared/api/blossom";
import { EmojiPicker } from "@/shared/ui/EmojiPicker";
import { cn } from "@/shared/lib/cn";
import { formatElapsed } from "@/features/agents/ui/WorkingBadge";
import { isWithinGroupingWindow } from "@/features/channels/lib/messageGrouping";
import {
  QUICK_REACTIONS,
  reactionGroups as groupReactions,
  type ReactionGroup,
  type ReactionIndex,
} from "../lib/reactions.ts";
import { MarkdownContent } from "./MarkdownContent.tsx";

const EMPTY_REACTIONS: ReactionIndex = new Map();

function formatDayLabel(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) {
    return "Today";
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }
  return date.toLocaleDateString([], {
    month: "long",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 px-2 py-2">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function UnreadDivider() {
  return (
    <div className="flex items-center gap-3 px-2 py-1">
      <span className="h-px flex-1 bg-border" />
      <span className="rounded-full bg-emerald-600/20 px-2 py-0.5 text-xs font-semibold text-emerald-500">
        New
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * Desktop-qualified timestamps: time-only today, "Yesterday at …", weekday
 * within the week, "Aug 28 at …" beyond. Day dividers carry the day for
 * scanning; the qualifier keeps individual rows self-describing.
 */
function formatTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const today = new Date();
  const dayKey = (d: Date) => d.toDateString();
  if (dayKey(date) === dayKey(today)) {
    return time;
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) {
    return `Yesterday at ${time}`;
  }
  if (today.getTime() - date.getTime() < 7 * 86_400_000) {
    return `${date.toLocaleDateString([], { weekday: "long" })} at ${time}`;
  }
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

export function authorLabel(
  pubkey: string,
  profiles: Map<string, Profile>,
): string {
  return profiles.get(pubkey)?.displayName ?? truncatePubkey(pubkey);
}

/** Deterministic hue from a pubkey — the identicon fallback color. */
function pubkeyHue(pubkey: string): number {
  let hash = 0;
  for (let i = 0; i < pubkey.length; i++) {
    hash = (hash * 31 + pubkey.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/**
 * Author avatar: the profile picture when one is published (relay media is
 * auth-gated, so it goes through the signed fetch), else a hue-hash initials
 * circle in the desktop client's identicon style. Exported for the sidebar's
 * DM rows.
 */
export function AuthorAvatar({
  pubkey,
  label,
  picture,
  size = "md",
}: {
  pubkey: string;
  label: string;
  picture?: string;
  size?: "sm" | "dm" | "md" | "md-sm";
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setObjectUrl(null);
    if (!picture) {
      return;
    }
    fetchSignedMedia(picture)
      .then((url) => {
        if (!cancelled) {
          setObjectUrl(url);
        }
      })
      .catch(() => {
        // Unavailable media falls back to the identicon below.
      });
    return () => {
      cancelled = true;
    };
  }, [picture]);
  const box =
    size === "sm"
      ? "h-5 w-5 text-[10px]"
      : size === "dm"
        ? "h-6 w-6 text-[10px]"
        : size === "md-sm"
          ? "h-7 w-7 text-xs"
          : "h-9 w-9 text-sm";
  if (objectUrl) {
    return (
      <img
        src={objectUrl}
        alt=""
        className={`rounded-full object-cover ${box}`}
      />
    );
  }
  return (
    <div
      className={`flex items-center justify-center rounded-full font-semibold text-white ${box}`}
      style={{ backgroundColor: `hsl(${pubkeyHue(pubkey)}, 45%, 42%)` }}
    >
      {label.slice(0, 2)}
    </div>
  );
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
  onEdit,
  onDelete,
  onShare,
  selfPubkey,
  agentPubkeys,
  highlightId,
  unreadBefore,
  typingNames,
  tailKey,
  onLoadOlder,
  loadingOlder,
  historyExhausted,
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
  /** Begin editing one of the viewer's own messages. */
  onEdit?: (message: TimelineMessage) => void;
  /** Delete one of the viewer's own messages (after confirm). */
  onDelete?: (messageId: string) => void;
  /** Copy a permalink to any message. */
  onShare?: (messageId: string) => void;
  /** The viewer's pubkey — gates edit/delete to own messages. */
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
   * Auto-tail trigger: every change scrolls the list to its bottom (the
   * desktop's VList pattern). Compose it from the channel + newest message id
   * (`${channelId}:${lastMessageId}`) so both new messages and channel
   * switches re-tail. Null disables tailing.
   */
  tailKey?: string | null;
  /** Scroll-up pagination: called when the viewport reaches the top. */
  onLoadOlder?: () => void;
  /** An older-history page is in flight (renders the top loading row). */
  loadingOlder?: boolean;
  /** Older pagination already hit the channel start — stop offering it. */
  historyExhausted?: boolean;
}) {
  const listRef = useRef<VListHandle>(null);
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
  const isEmpty = messages.length === 0;
  let lastAuthor: string | null = null;
  let lastKind = 0;
  // createdAt (Unix seconds) of the previous RENDERED message — the anchor
  // for the grouping window. Chained like the desktop: each message compares
  // against its immediate predecessor, grouped or not.
  let lastRenderedAt: number | null = null;
  let lastDay = "";
  let unreadShown = false;
  const rows: ReactElement[] = [];
  const rowIndex = new Map<string, number>();
  rowIndexRef.current = rowIndex;
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
      rows.push(
        <DayDivider
          key={`day:${day}`}
          label={formatDayLabel(message.createdAt)}
        />,
      );
    }
    if (
      !unreadShown &&
      unreadBefore != null &&
      message.createdAt >= unreadBefore
    ) {
      unreadShown = true;
      rows.push(<UnreadDivider key="unread" />);
    }
    // Replies render INLINE under their root (desktop pattern: indented
    // previews with a connector rail, click opens the full thread panel).
    if (!flat && (message.rootId || message.replyToId)) {
      lastAuthor = null;
      continue;
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
    const grouped =
      message.authorPubkey === lastAuthor &&
      message.kind === lastKind &&
      isWithinGroupingWindow(lastRenderedAt, message.createdAt);
    lastAuthor = message.authorPubkey;
    lastKind = message.kind;
    lastRenderedAt = message.createdAt;
    rowIndex.set(message.id, rows.length);
    rows.push(
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
        )}
        onReact={onReact}
        onEdit={onEdit}
        onDelete={onDelete}
        onShare={onShare}
        canModify={selfPubkey === message.authorPubkey}
        isAgent={agentPubkeys?.has(message.authorPubkey) ?? false}
        highlighted={message.id === highlightId}
      >
        {replies.length > 0 && (
          <ThreadPreview
            replies={replies}
            profiles={profiles}
            onOpenThread={onOpenThread}
            root={message}
          />
        )}
      </MessageRow>,
    );
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
  if (loadingOlder) {
    // Prepended (not appended): the reader is at the top waiting for it.
    // This row exists only while a page is in flight, so it never shifts
    // the anchor math of a completed restore.
    items.unshift(
      <div key="older-loading" className="mx-auto w-full max-w-3xl px-1 sm:px-3">
        <div className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground">
          <span className="inline-block size-3 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-transparent" />
          <span>Loading earlier messages…</span>
        </div>
      </div>,
    );
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
  }
  // Auto-tail: tailKey changes → scroll to the newest row. Double-rAF lets
  // virtua measure freshly mounted rows; the settle pass catches late-sizing
  // media. (Same pattern the timeline used before virtualization.) Tailing is
  // keyed on tailKey ONLY — an older-history page growing the list must not
  // yank the reader to the bottom — and never fires while a pagination
  // restore is pinning the viewport to its anchor row.
  // items.length is read for the bottom index only; tailKey is the trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pagination pages must not re-tail
  useEffect(() => {
    if (!tailKey || pagePhase.current !== "idle") {
      return;
    }
    const toBottom = () =>
      listRef.current?.scrollToIndex(items.length - 1, { align: "end" });
    const raf = requestAnimationFrame(() => requestAnimationFrame(toBottom));
    const settle = window.setTimeout(toBottom, 250);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
  }, [tailKey]);

  // Top reached → request one older page (once per flight).
  const handleScroll = useCallback(
    (offset: number) => {
      if (
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
    [loadingOlder, historyExhausted, messages, onLoadOlder],
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
    <VList ref={listRef} className="min-h-0 flex-1" onScroll={handleScroll}>
      {items}
    </VList>
  );
}

function MessageRow({
  message,
  profiles,
  grouped,
  replyCount,
  onOpenThread,
  active,
  reactionGroups,
  onReact,
  onEdit,
  onDelete,
  onShare,
  canModify,
  isAgent,
  highlighted,
  children,
}: {
  message: TimelineMessage;
  profiles: Map<string, Profile>;
  grouped: boolean;
  replyCount: number;
  onOpenThread: (message: TimelineMessage) => void;
  active: boolean;
  reactionGroups: ReactionGroup[];
  onReact?: (messageId: string, emoji: string) => void;
  onEdit?: (message: TimelineMessage) => void;
  onDelete?: (messageId: string) => void;
  onShare?: (messageId: string) => void;
  canModify?: boolean;
  isAgent?: boolean;
  highlighted?: boolean;
  children?: ReactNode;
}) {
  const mentionNames = new Set(
    message.mentionPubkeys.map((pubkey) =>
      authorLabel(pubkey, profiles).toLowerCase(),
    ),
  );
  const rowRef = useRef<HTMLDivElement>(null);
  // Permalink arrival: scroll the target into view (centered) and flash a
  // ring. Runs once per mount with `highlighted` — the route drops ?m from
  // the URL right after, so this never fights the auto-tail scroll.
  useEffect(() => {
    if (!highlighted) {
      return;
    }
    rowRef.current?.scrollIntoView({ block: "center" });
  }, [highlighted]);
  return (
    // Desktop message cards: rounded-2xl rows, hover muted wash; the open
    // thread's root keeps a persistent tint so the selection is traceable.
    <div
      ref={rowRef}
      className={cn(
        "group flex gap-3 rounded-2xl px-2 transition-colors hover:bg-muted/50",
        grouped ? "mt-0.5" : "mt-3",
        active && "bg-muted/40 hover:bg-muted/40",
        highlighted &&
          "bg-primary/10 ring-1 ring-primary/40 [animation:pingFlash_1.2s_ease-out_1]",
      )}
    >
      <div className="w-9 shrink-0">
        {!grouped && (
          <AuthorAvatar
            pubkey={message.authorPubkey}
            label={authorLabel(message.authorPubkey, profiles)}
            picture={profiles.get(message.authorPubkey)?.avatar}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">
              {authorLabel(message.authorPubkey, profiles)}
            </span>
            {isAgent && (
              <>
                <span className="rounded bg-accent/50 px-1 text-[10px] font-medium uppercase tracking-wide text-accent-foreground/80">
                  agent
                </span>
                <span
                  className="hidden font-mono text-[10px] text-muted-foreground/60 sm:inline"
                  title={message.authorPubkey}
                >
                  {truncatePubkey(message.authorPubkey)}
                </span>
              </>
            )}
            <span className="text-xs text-muted-foreground">
              {formatTime(message.createdAt)}
            </span>
          </div>
        )}
        <MarkdownContent
          content={message.content}
          mentionNames={mentionNames}
          imetaByUrl={message.imetaByUrl}
          snapshotSharedBy={authorLabel(message.authorPubkey, profiles)}
        />
        {message.edited && (
          <span className="ml-1 align-baseline text-xs text-muted-foreground/70">
            (edited)
          </span>
        )}
        {replyCount > 2 && (
          <button
            type="button"
            className="mt-0.5 text-sm font-medium text-primary hover:underline"
            onClick={() => onOpenThread(message)}
          >
            View all {replyCount} {replyCount === 1 ? "reply" : "replies"} →
          </button>
        )}
        {reactionGroups.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {reactionGroups.map((group) => (
              <button
                key={group.emoji}
                type="button"
                title={group.pubkeys.length.toString()}
                className="flex items-center gap-1 rounded-full border border-border/60 bg-card/60 px-2 py-0.5 text-sm hover:bg-accent"
                onClick={() => onReact?.(message.id, group.emoji)}
              >
                <span>{group.emoji}</span>
                {group.pubkeys.length > 1 && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {group.pubkeys.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {children}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-1 self-start">
        {canModify && onEdit && (
          <button
            type="button"
            aria-label="Edit message"
            className="rounded p-1 text-xs text-muted-foreground transition-opacity hover:bg-accent lg:opacity-0 lg:group-hover:opacity-100"
            onClick={() => onEdit(message)}
          >
            ✎
          </button>
        )}
        {canModify && onDelete && (
          <button
            type="button"
            aria-label="Delete message"
            className="rounded p-1 text-xs text-muted-foreground transition-opacity hover:bg-accent lg:opacity-0 lg:group-hover:opacity-100"
            onClick={() => {
              if (window.confirm("Delete this message?")) onDelete(message.id);
            }}
          >
            🗑
          </button>
        )}
        {onReact &&
          QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              className="hidden rounded p-0.5 text-xs text-muted-foreground transition-opacity hover:bg-accent group-hover:block lg:opacity-0 lg:group-hover:opacity-100"
              onClick={() => onReact(message.id, emoji)}
            >
              {emoji}
            </button>
          ))}
        {onReact && (
          <EmojiPicker
            label="More reactions"
            onSelect={(emoji) => onReact(message.id, emoji)}
          >
            {(props) => (
              <button
                type="button"
                ref={props.ref}
                aria-label={props["aria-label"]}
                className="hidden rounded p-1 text-xs text-muted-foreground transition-opacity hover:bg-accent group-hover:block lg:opacity-0 lg:group-hover:opacity-100"
                onClick={props.onClick}
              >
                ＋
              </button>
            )}
          </EmojiPicker>
        )}
        {onShare && (
          <button
            type="button"
            aria-label="Copy link to message"
            title="Copy link to message"
            className="rounded p-1 text-xs text-muted-foreground transition-opacity hover:bg-accent lg:opacity-0 lg:group-hover:opacity-100"
            onClick={() => onShare(message.id)}
          >
            🔗
          </button>
        )}
        <button
          type="button"
          aria-label="Reply in thread"
          className="rounded p-1 text-xs text-muted-foreground transition-opacity hover:bg-accent lg:opacity-0 lg:group-hover:opacity-100"
          onClick={() => onOpenThread(message)}
        >
          ↩
        </button>
      </div>
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
