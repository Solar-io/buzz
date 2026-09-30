import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  Check,
  Clock,
  EllipsisVertical,
  Link2,
  MessageCircle,
  Pencil,
  SmilePlus,
  Trash2,
  X,
} from "lucide-react";
import { useRemindMeLater } from "@/features/reminders/ui/RemindMeLaterProvider";
import { EmojiPicker } from "@/shared/ui/EmojiPicker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { cn } from "@/shared/lib/cn";
import { QUICK_REACTIONS } from "../lib/reactions.ts";

/**
 * The floating hover toolbar for one message row (Main artboard): a small
 * elevated card that overlaps the row's top-right corner and appears on
 * hover OR focus-within.
 *
 * Focus-within is not decoration. Without it the bar is unreachable by
 * keyboard: tabbing into a button that is `opacity-0` and
 * `pointer-events-none` leaves the user operating an invisible control.
 *
 * The bar carries the one-click actions: react, reply in thread, and
 * **Feedback** — the one labelled control, because it is the redesign's
 * fastest way to say "not now": one click files the message as a reminder
 * due tomorrow 9:00 AM (kind 30300), where it waits in Work → Needs you.
 * Everything rarer — copy link, remind at a chosen time, edit, delete —
 * lives behind the overflow menu.
 *
 * The quick-reaction row is kept from the old bar: one-click 👍 is existing
 * web behaviour, and dropping it while restyling would be a silent removal.
 */

const ACTION_BUTTON_CLASS = cn(
  "inline-flex h-7 w-7.5 shrink-0 items-center justify-center rounded-[7px]",
  "text-ink-2 transition-colors",
  "hover:bg-accent hover:text-foreground",
  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
);
const ACTION_ICON_CLASS = "h-4 w-4";

export function MessageActionBar({
  messageId,
  canModify,
  channelId,
  authorPubkey,
  messagePreview,
  onReact,
  onReply,
  onShare,
  onEdit,
  onDelete,
}: {
  messageId: string;
  /** The viewer authored this message — gates edit and delete. */
  canModify?: boolean;
  /**
   * Channel the message lives in. Carried into a reminder so it can navigate
   * back to the conversation.
   */
  channelId?: string | null;
  /**
   * The message author's pubkey. Carried into a reminder so the row can say
   * who it is about.
   */
  authorPubkey?: string | null;
  /**
   * The message text, carried into a reminder so the row says what it is
   * about. Optional: without it a reminder still works and still navigates,
   * it just reads "Reminder" instead of the message.
   */
  messagePreview?: string;
  onReact?: (emoji: string) => void;
  /**
   * Open the thread on this message. Optional: rows that cannot offer it
   * (inside the flat thread pane) omit it, and the ↩ button drops out rather
   * than promising a mid-thread reply the composer would not send
   * (Sam 2026-09-20).
   */
  onReply?: () => void;
  onShare?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { openReminder, sendToFeedback, feedbackPending, pendingEventIds } =
    useRemindMeLater();
  // Already filed: the button says so instead of filing a second reminder.
  const inFeedback = pendingEventIds.has(messageId);
  // One target for both reminder entry points, so Feedback and "Remind me
  // later" cannot drift apart on what they point at.
  const reminderTarget = () => ({
    eventId: messageId,
    channelId: channelId ?? "",
    preview: messagePreview ?? "",
    authorPubkey: authorPubkey ?? "",
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [touchExpanded, setTouchExpanded] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const disarmTimer = useRef<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // `EmojiPicker` owns its own open state and exposes no change callback, so
  // this mirror exists only to pin the bar visible while the palette is up —
  // otherwise moving the pointer onto the palette drops `:hover` on the row
  // and the bar (which contains the palette) fades out mid-choice. Every one
  // of the picker's own close paths is mirrored here: select, Escape, and a
  // pointerdown outside the bar.
  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!barRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPickerOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  const disarm = useCallback(() => {
    if (disarmTimer.current !== null) {
      window.clearTimeout(disarmTimer.current);
      disarmTimer.current = null;
    }
    setConfirmingDelete(false);
  }, []);

  // An armed confirm that the user walks away from must not stay armed and
  // catch a later stray click. Escape cancels; so does five seconds of
  // nothing. (Replaces `window.confirm`, which froze the event loop and
  // rendered as an OS chrome dialog that looked nothing like the app.)
  useEffect(() => {
    if (!confirmingDelete) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        disarm();
      }
    };
    window.addEventListener("keydown", onKey);
    disarmTimer.current = window.setTimeout(disarm, 5_000);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (disarmTimer.current !== null) {
        window.clearTimeout(disarmTimer.current);
        disarmTimer.current = null;
      }
    };
  }, [confirmingDelete, disarm]);

  const canEdit = Boolean(canModify && onEdit);
  const canDelete = Boolean(canModify && onDelete);

  return (
    <>
      <button
        type="button"
        aria-label={
          touchExpanded ? "Hide message actions" : "Show message actions"
        }
        aria-expanded={touchExpanded}
        className="buzz-touch-message-trigger"
        onClick={() => setTouchExpanded((open) => !open)}
      >
        <EllipsisVertical aria-hidden className="size-4" />
      </button>
      <div
        ref={barRef}
        // A toolbar is what this is: a labelled group of controls acting on one
        // object. The role also satisfies a11y linting for the mouse handlers
        // below, which exist to disarm the delete confirm and mirror the emoji
        // palette's open state.
        role="toolbar"
        aria-label="Message actions"
        aria-orientation="horizontal"
        data-testid={`message-action-bar-${messageId}`}
        data-picker-open={pickerOpen ? "true" : undefined}
        data-menu-open={menuOpen ? "true" : undefined}
        onMouseLeave={disarm}
        // A click on a sibling action closes the palette (EmojiPicker's own
        // outside-click rule counts it as outside), so drop the mirror too.
        // Capture phase only reads the target; the button's own handler still
        // runs.
        onClickCapture={(event) => {
          if (!pickerOpen) {
            return;
          }
          const target = event.target as Element | null;
          if (
            target?.closest('[data-testid^="react-message-"]') ||
            target?.closest('[role="menu"]')
          ) {
            return;
          }
          setPickerOpen(false);
        }}
        className={cn(
          "buzz-message-actions absolute right-2.5 top-0 z-10 -translate-y-1/2",
          "flex items-center gap-px rounded-[10px] border border-border bg-card p-[3px]",
          "shadow-[0_8px_18px_-10px_var(--elev-shadow)]",
          "transition-opacity duration-150 ease-out",
          // Hidden until the row is hovered or something inside it holds focus.
          // Forced open while the emoji palette or the overflow menu is up, or a
          // delete is armed, so the bar does not vanish out from under the
          // interaction. (The overflow menu portals out of this element, so
          // without `menuOpen` the pointer leaving the row would fade the bar —
          // and with it the trigger the open menu is anchored to.)
          pickerOpen || menuOpen || confirmingDelete || touchExpanded
            ? "pointer-events-auto opacity-100"
            : cn(
                "pointer-events-none opacity-0",
                "group-hover/message:pointer-events-auto group-hover/message:opacity-100",
                "group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100",
              ),
        )}
      >
        {onReact && (
          <>
            <div className="hidden items-center gap-0.5 sm:flex">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`React with ${emoji}`}
                  title={`React with ${emoji}`}
                  data-testid={`quick-react-${emoji}-${messageId}`}
                  className={cn(ACTION_BUTTON_CLASS, "text-sm leading-none")}
                  onClick={() => onReact(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <span
              aria-hidden="true"
              className="mx-0.5 hidden h-4 w-px bg-border/70 sm:block"
            />
            <EmojiPicker
              label="Add reaction"
              onSelect={(emoji) => {
                setPickerOpen(false);
                onReact(emoji);
              }}
            >
              {(props) => (
                <button
                  type="button"
                  ref={props.ref}
                  aria-label={props["aria-label"]}
                  aria-expanded={pickerOpen}
                  title="Add reaction"
                  data-testid={`react-message-${messageId}`}
                  className={cn(
                    ACTION_BUTTON_CLASS,
                    pickerOpen && "bg-accent text-accent-foreground",
                  )}
                  onClick={() => {
                    setPickerOpen((open) => !open);
                    props.onClick();
                  }}
                >
                  <SmilePlus className={ACTION_ICON_CLASS} aria-hidden="true" />
                </button>
              )}
            </EmojiPicker>
          </>
        )}

        {onReply && (
          <button
            type="button"
            aria-label="Reply in thread"
            title="Reply in thread"
            data-testid={`reply-message-${messageId}`}
            className={ACTION_BUTTON_CLASS}
            onClick={onReply}
          >
            <MessageCircle className={ACTION_ICON_CLASS} aria-hidden="true" />
          </button>
        )}

        <span
          aria-hidden="true"
          className="mx-[3px] h-4.5 w-px shrink-0 bg-border"
        />

        {/* Send to Feedback: one click, due tomorrow 9:00 AM (plan default
          3). Unconditional for the same reason as the overflow menu's
          "Remind me later": it is offered on every message, whoever wrote
          it. A message already filed says so and cannot be filed twice. */}
        <button
          type="button"
          aria-label={inFeedback ? "In Feedback" : "Send to Feedback"}
          title={
            inFeedback
              ? "Already in Feedback — change it from Work"
              : "Send to Feedback: reply later, with an AI summary"
          }
          data-testid={`feedback-message-${messageId}`}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] bg-chip px-2.25 text-xs font-semibold text-foreground transition-colors",
            "hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:opacity-60",
          )}
          disabled={feedbackPending || inFeedback}
          onClick={() => sendToFeedback(reminderTarget())}
        >
          {inFeedback ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <Bell className="size-3.5" aria-hidden="true" />
          )}
          <span className="hidden sm:inline">
            {inFeedback ? "In Feedback" : "Feedback"}
          </span>
        </button>

        {/* Always mounted: "Remind me later" is offered on every message,
          authored by anyone — the rarer edit/delete items gate themselves
          inside. Wrapping this menu in a condition would silently revoke
          reminders on messages the viewer did not write. */}
        <DropdownMenu
          open={menuOpen}
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (!open) {
              disarm();
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More actions"
              title="More actions"
              data-testid={`more-actions-${messageId}`}
              className={cn(
                ACTION_BUTTON_CLASS,
                menuOpen && "bg-accent text-accent-foreground",
              )}
            >
              <EllipsisVertical
                className={ACTION_ICON_CLASS}
                aria-hidden="true"
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onShare && (
              <DropdownMenuItem
                data-testid={`copy-link-message-${messageId}`}
                onClick={onShare}
              >
                <Link2 className={ACTION_ICON_CLASS} aria-hidden="true" />
                Copy link to message
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              data-testid={`remind-message-${messageId}`}
              onClick={() => openReminder(reminderTarget())}
            >
              <Clock className={ACTION_ICON_CLASS} aria-hidden="true" />
              Remind me at…
            </DropdownMenuItem>

            {canEdit && (
              <DropdownMenuItem
                data-testid={`edit-message-${messageId}`}
                onClick={() => onEdit?.()}
              >
                <Pencil className={ACTION_ICON_CLASS} aria-hidden="true" />
                Edit message
              </DropdownMenuItem>
            )}

            {canDelete &&
              (confirmingDelete ? (
                <>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    data-testid={`confirm-delete-message-${messageId}`}
                    onClick={() => {
                      disarm();
                      onDelete?.();
                    }}
                  >
                    <Check className={ACTION_ICON_CLASS} aria-hidden="true" />
                    Confirm delete
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid={`cancel-delete-message-${messageId}`}
                    onClick={disarm}
                  >
                    <X className={ACTION_ICON_CLASS} aria-hidden="true" />
                    Cancel
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  data-testid={`delete-message-${messageId}`}
                  // Arming must not close the menu, or the confirm step it
                  // arms would be unreachable.
                  onSelect={(event) => event.preventDefault()}
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 className={ACTION_ICON_CLASS} aria-hidden="true" />
                  Delete message
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
