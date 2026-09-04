import { useEffect, useRef, type ReactNode } from "react";
import type { TimelineMessage } from "../lib/messageBuffer.ts";
import type { Profile } from "../hooks.ts";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { authorLabel } from "../lib/authorLabel.ts";
import {
  formatClockTime,
  formatFullDateTime,
  formatTime,
} from "../lib/dateFormatters.ts";
import type { ReactionGroup } from "../lib/reactions.ts";
import { UserProfilePopover } from "@/features/profile/ui/UserProfilePopover";
import { AuthorAvatar } from "./AuthorAvatar.tsx";
import { LinkPreviewCards } from "./LinkPreviewCards.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { MessageActionBar } from "./MessageActionBar.tsx";
import { ReactionChips } from "./ReactionChips.tsx";

/** Desktop parity: the timestamp tooltip waits half a second before opening. */
const TIMESTAMP_TOOLTIP_DELAY_MS = 500;

/**
 * A timestamp that reveals its absolute date on hover. Two modes, matching
 * `desktop/.../MessageTimestamp.tsx`:
 *
 * - header — the relative ladder ("Yesterday at 9:05 AM"), because the day
 *   divider that would otherwise supply the date scrolls out of view while
 *   its messages stay on screen.
 * - gutter — clock only, AM/PM stripped, sized for the 36px avatar column it
 *   borrows on continuation rows.
 */
function MessageTimestamp({
  createdAt,
  gutter = false,
  className,
}: {
  createdAt: number;
  gutter?: boolean;
  className?: string;
}) {
  return (
    <Tooltip delayDuration={TIMESTAMP_TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>
        <span
          data-testid="message-timestamp"
          className={cn(
            "shrink-0 cursor-default whitespace-nowrap tabular-nums text-muted-foreground",
            gutter ? "text-badge" : "text-xs",
            className,
          )}
        >
          {gutter ? formatClockTime(createdAt) : formatTime(createdAt)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        {formatFullDateTime(createdAt)}
      </TooltipContent>
    </Tooltip>
  );
}

export function MessageRow({
  message,
  profiles,
  grouped,
  replyCount,
  onOpenThread,
  active,
  reactionGroups,
  onReact,
  onUnreact,
  onEdit,
  onDelete,
  onShare,
  canModify,
  isAgent,
  highlighted,
  pending,
  selfPubkey,
  onOpenDm,
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
  onUnreact?: (messageId: string, emoji: string) => void;
  onEdit?: (message: TimelineMessage) => void;
  onDelete?: (messageId: string) => void;
  onShare?: (messageId: string) => void;
  canModify?: boolean;
  isAgent?: boolean;
  highlighted?: boolean;
  /** Optimistic send still in flight — renders the desktop's "Sending…". */
  pending?: boolean;
  selfPubkey?: string | null;
  /**
   * Open a DM with the author, offered by the profile card. The shell owns DM
   * creation, so this is optional here; when it is omitted the card falls back
   * to `ProfileActionsProvider` from `features/profile`, and when neither is
   * present it simply does not render the action.
   */
  onOpenDm?: (pubkey: string) => void;
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
  const label = authorLabel(message.authorPubkey, profiles);
  // Avatar and author name are the two things a reader points at to ask "who
  // is this?", and until now both were inert. They share one card so the two
  // answers cannot drift.
  const profileCard = (children: ReactNode, triggerClassName?: string) => (
    <UserProfilePopover
      fallbackLabel={label}
      onOpenDm={onOpenDm}
      picture={profiles.get(message.authorPubkey)?.avatar}
      pubkey={message.authorPubkey}
      selfPubkey={selfPubkey}
      triggerClassName={triggerClassName}
    >
      {children}
    </UserProfilePopover>
  );
  return (
    // Desktop message cards: rounded-2xl rows, hover muted wash; the open
    // thread's root keeps a persistent tint so the selection is traceable.
    // `relative` + the named `group/message` are what the floating action bar
    // anchors and reveals against — it must not be renamed to a bare `group`
    // or nested groups (forum rows) would trigger each other.
    <div
      ref={rowRef}
      data-testid={`message-row-${message.id}`}
      className={cn(
        "group/message relative flex gap-3 rounded-2xl px-2 transition-colors hover:bg-muted/50",
        grouped ? "mt-0.5" : "mt-3",
        active && "bg-muted/40 hover:bg-muted/40",
        pending && "opacity-70",
        highlighted &&
          "bg-primary/10 ring-1 ring-primary/40 [animation:pingFlash_1.2s_ease-out_1]",
      )}
    >
      <div className="w-9 shrink-0">
        {grouped ? (
          // Continuation rows borrow the avatar column for a right-aligned
          // clock that fades in on hover/focus — otherwise a grouped message
          // carries no time of its own at all.
          <div className="flex justify-end pt-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100">
            <MessageTimestamp createdAt={message.createdAt} gutter />
          </div>
        ) : (
          profileCard(
            <AuthorAvatar
              pubkey={message.authorPubkey}
              label={label}
              picture={profiles.get(message.authorPubkey)?.avatar}
            />,
            "rounded-full",
          )
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            {profileCard(
              <span className="text-sm font-semibold hover:underline">
                {label}
              </span>,
            )}
            {isAgent && (
              <>
                <span className="rounded bg-accent/50 px-1 text-badge font-medium uppercase tracking-wide text-accent-foreground/80">
                  agent
                </span>
                <span
                  className="hidden font-mono text-badge text-muted-foreground/60 sm:inline"
                  title={message.authorPubkey}
                >
                  {truncatePubkey(message.authorPubkey)}
                </span>
              </>
            )}
            <MessageTimestamp createdAt={message.createdAt} />
            {pending && (
              <span
                data-testid="message-send-status"
                className="text-xs font-normal text-muted-foreground/70"
              >
                Sending…
              </span>
            )}
          </div>
        )}
        {grouped && pending && (
          <span
            data-testid="message-send-status"
            className="text-xs font-normal text-muted-foreground/70"
          >
            Sending…
          </span>
        )}
        <MarkdownContent
          content={message.content}
          mentionNames={mentionNames}
          imetaByUrl={message.imetaByUrl}
          snapshotSharedBy={label}
        />
        {message.edited && (
          <span className="ml-1 align-baseline text-xs text-muted-foreground/70">
            (edited)
          </span>
        )}
        <LinkPreviewCards previews={message.linkPreviews} />
        {replyCount > 2 && (
          <button
            type="button"
            className="mt-0.5 text-sm font-medium text-primary hover:underline"
            onClick={() => onOpenThread(message)}
          >
            View all {replyCount} {replyCount === 1 ? "reply" : "replies"} →
          </button>
        )}
        <ReactionChips
          messageId={message.id}
          groups={reactionGroups}
          nameOf={(pubkey) => authorLabel(pubkey, profiles)}
          selfPubkey={selfPubkey}
          onReact={onReact}
          onUnreact={onUnreact}
        />
        {children}
      </div>
      <MessageActionBar
        messageId={message.id}
        canModify={canModify}
        // Moderation authority is two-axis and per-channel, so the bar needs
        // both the channel it is judging within and the author it would act
        // against. Both already ride on TimelineMessage.
        channelId={message.channelId}
        authorPubkey={message.authorPubkey}
        messagePreview={message.content}
        onReact={onReact ? (emoji) => onReact(message.id, emoji) : undefined}
        onReply={() => onOpenThread(message)}
        onShare={onShare ? () => onShare(message.id) : undefined}
        onEdit={onEdit ? () => onEdit(message) : undefined}
        onDelete={onDelete ? () => onDelete(message.id) : undefined}
      />
    </div>
  );
}
