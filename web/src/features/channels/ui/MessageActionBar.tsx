import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  CornerUpLeft,
  Link2,
  Pencil,
  SmilePlus,
  Trash2,
  X,
} from "lucide-react";
import { EmojiPicker } from "@/shared/ui/EmojiPicker";
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
 * Two deliberate differences from the desktop bar:
 *
 * 1. The desktop parks edit/delete inside a "More actions" dropdown. The web
 *    client has no dropdown primitive yet, so they sit inline.
 *    TODO(primitives): fold edit + delete into `shared/ui/dropdown-menu`
 *    behind an `EllipsisVertical` trigger once that primitive lands.
 * 2. The quick-reaction row is kept. It is existing web functionality (the
 *    old glyph stack rendered {@link QUICK_REACTIONS} inline) and the desktop
 *    has no equivalent, so dropping it while restyling would be a silent
 *    feature removal.
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
  onReact,
  onReply,
  onShare,
  onEdit,
  onDelete,
}: {
  messageId: string;
  /** The viewer authored this message — gates edit and delete. */
  canModify?: boolean;
  onReact?: (emoji: string) => void;
  onReply: () => void;
  onShare?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
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

  const canDelete = Boolean(canModify && onDelete);

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
        // Forced open while the emoji palette is up or a delete is armed, so
        // the bar does not vanish out from under the interaction.
        pickerOpen || confirmingDelete
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

      {canModify && onEdit && (
        <button
          type="button"
          aria-label="Edit message"
          title="Edit message"
          data-testid={`edit-message-${messageId}`}
          className={ACTION_BUTTON_CLASS}
          onClick={onEdit}
        >
          <Pencil className={ACTION_ICON_CLASS} aria-hidden="true" />
        </button>
      )}

      {canDelete &&
        (confirmingDelete ? (
          <>
            <button
              type="button"
              aria-label="Confirm delete message"
              title="Confirm delete"
              data-testid={`confirm-delete-message-${messageId}`}
              className={cn(
                ACTION_BUTTON_CLASS,
                "bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:text-destructive-foreground",
              )}
              onClick={() => {
                disarm();
                onDelete?.();
              }}
            >
              <Check className={ACTION_ICON_CLASS} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Cancel delete message"
              title="Cancel"
              data-testid={`cancel-delete-message-${messageId}`}
              className={ACTION_BUTTON_CLASS}
              onClick={disarm}
            >
              <X className={ACTION_ICON_CLASS} aria-hidden="true" />
            </button>
          </>
        ) : (
          <button
            type="button"
            aria-label="Delete message"
            title="Delete message"
            data-testid={`delete-message-${messageId}`}
            className={cn(ACTION_BUTTON_CLASS, "hover:text-destructive")}
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 className={ACTION_ICON_CLASS} aria-hidden="true" />
          </button>
        ))}
    </div>
  );
}
