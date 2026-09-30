import { useEffect, useRef, type ReactNode } from "react";
import type { TimelineMessage } from "../lib/messageBuffer.ts";
import type { Profile } from "../hooks.ts";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { authorLabel, messageAuthorLabel } from "../lib/authorLabel.ts";
import {
  formatClockTime,
  formatFullDateTime,
  formatTime,
} from "../lib/dateFormatters.ts";
import type { AgentReceipt, ReactionGroup } from "../lib/reactions.ts";
import { UserProfilePopover } from "@/features/profile/ui/UserProfilePopover";
import { AgentAvatarHoverCard } from "./AgentAvatarHoverCard.tsx";
import { AuthorAvatar } from "./AuthorAvatar.tsx";
import { DecisionCard } from "./DecisionCard.tsx";
import { HandoffChip, handoffTask } from "./HandoffChip.tsx";
import { QuickReplies } from "./QuickReplies.tsx";
import { isRenderableCard } from "../lib/decisionCard.ts";
import { LinkPreviewCards } from "./LinkPreviewCards.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { MessageActionBar } from "./MessageActionBar.tsx";
import { ReactionChips } from "./ReactionChips.tsx";
import { ScheduledWakeRow } from "./ScheduledWakeRow.tsx";
import { isScheduledWake } from "../lib/wakeMessage.ts";
import {
  StageOpenCard,
  stageOpenCardTag,
} from "@/features/stage/ui/StageOpenCard";
import { StagePartChip } from "@/features/stage/ui/StagePartChip";
import { useRelaySelf } from "@/shared/lib/relaySelf";

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
  cardAnswer = null,
  onOpenThread,
  active,
  reactionGroups,
  agentReceipt = null,
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
  showActions = true,
  onOpenDm,
  density = "default",
  needsYou = false,
  quickReply = null,
  children,
}: {
  message: TimelineMessage;
  profiles: Map<string, Profile>;
  grouped: boolean;
  /**
   * When this row is a decision card, MY answer to it from the same buffer
   * (`answeredCardReplies`). The row cannot derive this itself — it sees one
   * message, and the answer is a different event — so the host that holds the
   * buffer looks it up. Absent means "no answer", which is also what a host
   * with no buffer to consult says, and that degrades to an answerable card
   * rather than to a false "you replied".
   */
  cardAnswer?: TimelineMessage | null;
  /**
   * Open this message's thread — in place, under the row, with the caret in
   * its reply box (web redesign Phase 2). Optional: a row inside a thread, or
   * in a read-only list, passes nothing and the reply action drops out,
   * because replying to a mid-thread message is not something the reply box
   * sends (Sam 2026-09-20).
   */
  onOpenThread?: (message: TimelineMessage) => void;
  active: boolean;
  reactionGroups: ReactionGroup[];
  /** Agent read receipt (✓ seen / ✓✓ responding) for this message. */
  agentReceipt?: AgentReceipt;
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
  /** Hide the action bar when the row is embedded read-only in a call. */
  showActions?: boolean;
  /**
   * Open a DM with the author, offered by the profile card. The shell owns DM
   * creation, so this is optional here; when it is omitted the card falls back
   * to `ProfileActionsProvider` from `features/profile`, and when neither is
   * present it simply does not render the action.
   */
  onOpenDm?: (pubkey: string) => void;
  /**
   * "thread" is a reply inside an inline thread: a 20 px avatar, one step
   * smaller type, no author grouping. The row is otherwise the same row —
   * cards, reactions and the hover bar all work inside a thread.
   */
  density?: "default" | "thread";
  /**
   * This row is waiting on the VIEWER (an unanswered card aimed at them, an
   * open yes/no ask): it gets the coral wash and the "needs you" label of the
   * Main artboard. Decided by the host, which holds the buffer.
   */
  needsYou?: boolean;
  /**
   * The message explicitly asked the viewer for a yes or a no and is still
   * open (`openQuickReplies`). `onAnswer` sends the choice as an ordinary
   * threaded reply.
   */
  quickReply?: {
    onAnswer: (choice: string) => Promise<{ ok: boolean; message: string }>;
  } | null;
  children?: ReactNode;
}) {
  const thread = density === "thread";
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
  // Only rows carrying a buzz-system tag need the relay key (NIP-11 read,
  // cached per page); every other row skips it.
  const relaySelf = useRelaySelf(Boolean(message.buzzSystem));
  const label = messageAuthorLabel(message, profiles, relaySelf);
  // Scheduled wakes (reminder firings from the services identity) render as
  // one collapsed line — see lib/wakeMessage.ts. The shell above (ref,
  // testid, highlight flash, permalink scroll) stays theirs so a jump to a
  // wake row behaves like a jump to any message.
  const wake = isScheduledWake(message);
  const avatar = (
    <AuthorAvatar
      pubkey={message.authorPubkey}
      label={label}
      picture={profiles.get(message.authorPubkey)?.avatar}
      size={thread ? "sm" : "md"}
    />
  );
  // A `/handoff` row: the seat's name and the task, drawn as one bar.
  const handoffSeat =
    message.handoff != null ? authorLabel(message.handoff, profiles) : null;
  // Avatar and author name are the two things a reader points at to ask "who
  // is this?", and until now both were inert. They share one card so the two
  // answers cannot drift. Agent config (model, effort…) rides the AVATAR only
  // (owner ask): the hover card wraps it, and `showAgentConfig` is the tap path.
  const profileCard = (
    children: ReactNode,
    triggerClassName?: string,
    showAgentConfig = false,
  ) => (
    <UserProfilePopover
      fallbackLabel={label}
      onOpenDm={onOpenDm}
      picture={profiles.get(message.authorPubkey)?.avatar}
      pubkey={message.authorPubkey}
      selfPubkey={selfPubkey}
      showAgentConfig={showAgentConfig}
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
      data-needs-you={needsYou ? "true" : undefined}
      className={cn(
        "group/message relative flex transition-colors",
        thread
          ? "gap-2.25 rounded-lg px-1 py-1 hover:bg-accent"
          : "gap-3 rounded-[10px] px-2.5 hover:bg-accent",
        !thread && (grouped ? "py-0.5" : "mt-1.5 py-1.5"),
        needsYou && "bg-coral-wash hover:bg-coral-wash",
        active && !needsYou && "bg-accent",
        pending && "opacity-70",
        highlighted &&
          "bg-primary/10 ring-1 ring-primary/40 [animation:pingFlash_1.2s_ease-out_1]",
      )}
    >
      {wake ? (
        <ScheduledWakeRow message={message} label={label} />
      ) : (
        <>
          <div className={cn("shrink-0", thread ? "w-5 pt-0.5" : "w-9")}>
            {grouped ? (
              // Continuation rows borrow the avatar column for a right-aligned
              // clock that fades in on hover/focus — otherwise a grouped message
              // carries no time of its own at all.
              <div className="flex justify-end pt-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100">
                <MessageTimestamp createdAt={message.createdAt} gutter />
              </div>
            ) : isAgent ? (
              <AgentAvatarHoverCard label={label} pubkey={message.authorPubkey}>
                {profileCard(avatar, "rounded-full", true)}
              </AgentAvatarHoverCard>
            ) : (
              profileCard(avatar, "rounded-full")
            )}
          </div>
          <div className="min-w-0 flex-1">
            {!grouped && (
              <div className="flex flex-wrap items-baseline gap-x-2">
                {profileCard(
                  <span
                    className={cn(
                      "font-semibold hover:underline",
                      thread ? "text-sidebar-meta" : "text-sm",
                    )}
                  >
                    {label}
                  </span>,
                )}
                {isAgent && !thread && (
                  // The author's key lives on the chip's tooltip and in the
                  // profile card — a hex fragment in every header was noise.
                  <span
                    title={truncatePubkey(message.authorPubkey)}
                    className="self-center rounded border border-line-2 px-1 font-mono text-badge font-semibold uppercase leading-4 tracking-[0.06em] text-muted-foreground"
                  >
                    Agent
                  </span>
                )}
                <MessageTimestamp
                  createdAt={message.createdAt}
                  className="font-mono text-2xs"
                />
                {needsYou && (
                  <span
                    data-testid="message-needs-you"
                    className="text-xs font-semibold text-coral-ink"
                  >
                    needs you
                  </span>
                )}
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
            {isRenderableCard(message.card) ? (
              // D-035: a well-formed card tag replaces the fallback markdown —
              // the content field stays the plain-client rendering of the same
              // question, not something the card view should repeat.
              //
              // `isRenderableCard` rather than truthiness: a card that did not
              // come from the parser (a pre-v2 cache shape) must fall through
              // to the markdown below — the same degradation as a null parse —
              // instead of reaching a renderer that reads `card.questions`.
              //
              // "Answer in chat instead" is the card's dismiss-and-type escape
              // hatch, and it is the SAME navigation as the row's ↩: open the
              // thread on this card, whose pane composer replies to it. The
              // main composer deliberately carries no threadRef any more (it
              // always posts top-level, Sam 2026-09-20), so re-aiming it would
              // be reintroducing exactly the trap that change removed. Where
              // the row has no `onOpenThread` — a flat thread pane — the link
              // is not rendered rather than rendered dead.
              <DecisionCard
                message={message}
                answer={cardAnswer}
                onAnswerInChat={
                  onOpenThread ? () => onOpenThread(message) : undefined
                }
              />
            ) : stageOpenCardTag(message) ? (
              // Agent Stage Mode: a well-formed open tag renders the Stage
              // card; a malformed one parsed to null and falls through to the
              // fallback markdown, like a card. Parts stay ordinary rows.
              <StageOpenCard message={message} />
            ) : handoffSeat !== null ? (
              // `/handoff`: the seat and the task as one bar. The content
              // stays the plain-client rendering ("@Seat task").
              <HandoffChip
                seatName={handoffSeat}
                task={handoffTask(message.content, handoffSeat)}
                receipt={agentReceipt}
              />
            ) : (
              <MarkdownContent
                content={message.content}
                mentionNames={mentionNames}
                imetaByUrl={message.imetaByUrl}
                snapshotSharedBy={label}
                compact={thread}
              />
            )}
            {quickReply && (
              <QuickReplies message={message} onAnswer={quickReply.onAnswer} />
            )}
            <StagePartChip message={message} />
            {message.edited && (
              <span className="ml-1 align-baseline text-xs text-muted-foreground/70">
                (edited)
              </span>
            )}
            <LinkPreviewCards previews={message.linkPreviews} />
            <ReactionChips
              messageId={message.id}
              groups={reactionGroups}
              receipt={agentReceipt}
              nameOf={(pubkey) => authorLabel(pubkey, profiles)}
              selfPubkey={selfPubkey}
              onReact={onReact}
              onUnreact={onUnreact}
            />
            {children}
          </div>
          {showActions && (
            <MessageActionBar
              messageId={message.id}
              canModify={canModify}
              // Reminders need the conversation and the author the row is about;
              // both already ride on TimelineMessage.
              channelId={message.channelId}
              authorPubkey={message.authorPubkey}
              messagePreview={message.content}
              onReact={
                onReact ? (emoji) => onReact(message.id, emoji) : undefined
              }
              // The ↩ affordance only exists where "reply in thread" is a
              // real navigation; flat rows drop it along with onOpenThread.
              onReply={onOpenThread ? () => onOpenThread(message) : undefined}
              onShare={onShare ? () => onShare(message.id) : undefined}
              onEdit={onEdit ? () => onEdit(message) : undefined}
              onDelete={onDelete ? () => onDelete(message.id) : undefined}
            />
          )}
        </>
      )}
    </div>
  );
}
