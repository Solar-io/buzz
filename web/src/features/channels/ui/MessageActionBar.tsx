import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  CornerUpLeft,
  EllipsisVertical,
  Flag,
  Link2,
  Pencil,
  SmilePlus,
  Trash2,
  X,
} from "lucide-react";
import { MessageModerationMenuItems } from "@/features/moderation/ui/MessageModerationMenuItems";
import { ReportMessageDialog } from "@/features/moderation/ui/ReportMessageDialog";
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
 * The floating hover action bar for one message row, in the desktop's shape
 * (`desktop/src/features/messages/ui/MessageActionBar.tsx`): a rounded pill
 * on a translucent, blurred surface that overlaps the top-right corner of the
 * row and appears on hover OR focus-within.
 *
 * Focus-within is not decoration. Without it the bar is unreachable by
 * keyboard: tabbing into a button that is `opacity-0` and
 * `pointer-events-none` leaves the user operating an invisible control.
 *
 * The pill carries the frequent, one-click actions (react, reply, copy link).
 * Everything rarer — edit, delete, report, and the moderator cluster — lives
 * behind the overflow menu, matching the desktop's "More actions" dropdown.
 * (This resolves the former `TODO(primitives)`: `shared/ui/dropdown-menu`
 * has since landed in the web client.)
 *
 * One deliberate difference from the desktop bar remains: the quick-reaction
 * row is kept. It is existing web functionality (the old glyph stack rendered
 * {@link QUICK_REACTIONS} inline) and the desktop has no equivalent, so
 * dropping it while restyling would be a silent feature removal.
 */

const ACTION_BUTTON_CLASS = cn(
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
  "text-muted-foreground transition-colors",
  "hover:bg-accent hover:text-accent-foreground",
  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
);
const ACTION_ICON_CLASS = "h-4 w-4";

export function MessageActionBar({
  messageId,
  canModify,
  channelId,
  authorPubkey,
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
   * Channel the message lives in. Required by the channel-scoped moderator
   * commands (kind:9005 remove, kind:9001 kick) — both carry it as the `h`
   * tag, and the relay resolves the actor's channel role from it.
   */
  channelId?: string | null;
  /**
   * The message author's pubkey. The `p` target of a report and of every
   * author-directed moderator command; without it neither can be offered.
   */
  authorPubkey?: string | null;
  onReact?: (emoji: string) => void;
  onReply: () => void;
  onShare?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
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
  // A report needs both target ids the relay's `parse_report` demands. The
  // moderator cluster gates itself and renders nothing when unauthorized, so
  // it is always mounted (given an author) and never consulted here.
  const canReport = Boolean(authorPubkey);

  return (
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
        "absolute right-2 top-1 z-10 -translate-y-1/2",
        "flex items-center gap-0.5 rounded-full border border-border/70 p-1",
        "bg-background/95 shadow-xs backdrop-blur-sm supports-[backdrop-filter]:bg-background/85",
        "transition-opacity duration-150 ease-out",
        // Hidden until the row is hovered or something inside it holds focus.
        // Forced open while the emoji palette or the overflow menu is up, or a
        // delete is armed, so the bar does not vanish out from under the
        // interaction. (The overflow menu portals out of this element, so
        // without `menuOpen` the pointer leaving the row would fade the bar —
        // and with it the trigger the open menu is anchored to.)
        pickerOpen || menuOpen || confirmingDelete
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

      <button
        type="button"
        aria-label="Reply in thread"
        title="Reply in thread"
        data-testid={`reply-message-${messageId}`}
        className={ACTION_BUTTON_CLASS}
        onClick={onReply}
      >
        <CornerUpLeft className={ACTION_ICON_CLASS} aria-hidden="true" />
      </button>

      {onShare && (
        <button
          type="button"
          aria-label="Copy link to message"
          title="Copy link to message"
          data-testid={`copy-link-message-${messageId}`}
          className={ACTION_BUTTON_CLASS}
          onClick={onShare}
        >
          <Link2 className={ACTION_ICON_CLASS} aria-hidden="true" />
        </button>
      )}

      {(canEdit || canDelete || canReport) && (
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

            {canReport && (
              <DropdownMenuItem
                data-testid={`report-message-${messageId}`}
                onClick={() => setReportOpen(true)}
              >
                <Flag className={ACTION_ICON_CLASS} aria-hidden="true" />
                Report message
              </DropdownMenuItem>
            )}

            <MessageModerationMenuItems
              messageId={messageId}
              channelId={channelId}
              authorPubkey={authorPubkey}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {authorPubkey && (
        <ReportMessageDialog
          open={reportOpen}
          onOpenChange={setReportOpen}
          authorPubkey={authorPubkey}
          eventId={messageId}
        />
      )}
    </div>
  );
}
