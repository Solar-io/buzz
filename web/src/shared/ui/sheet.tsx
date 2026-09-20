import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { cn } from "@/shared/lib/cn";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { MODAL_BACKDROP_BLUR_CLASS } from "@/shared/ui/modalBackdrop";
import { MODAL_OVERLAY_MOTION_CLASS } from "@/shared/ui/modalMotion";

/**
 * A bottom sheet: the same Radix Dialog the rest of the app uses, anchored to
 * the bottom edge and sized for a thumb.
 *
 * ## Why a sheet exists at all (measured, not preferred)
 *
 * At 390×844 the channel timeline's scroller is 617 px tall and sits PINNED to
 * the bottom (`scrollTop + clientHeight === scrollHeight` at every step), so
 * every pixel an inline card grows by is taken off its TOP. Advancing a
 * 4-question card from a short question to a tall one took the card from
 * 394 px to 1071 px and its top from +? to −358: the title, the progress rail
 * and the question being answered were all off-screen while the user chose
 * between options 3 and 8. A 1071 px card cannot fit a 617 px scroller at ANY
 * scroll position, so the fix is to take the interaction out of the scroller
 * rather than to scroll harder.
 *
 * Radix gives the rest for free and correctly: focus trap, Escape, an inert
 * background, and scroll-lock on the body — which is what actually keeps the
 * timeline still while the sheet is driven.
 *
 * ## The dimensions are load-bearing
 *
 * - `max-h-[85dvh]` — **d**vh, not vh. On mobile Safari and Chrome `vh` is the
 *   LARGE viewport (chrome retracted), so a `85vh` sheet is taller than the
 *   visible area whenever the URL bar is showing, and its footer sits under
 *   the bar. `dvh` tracks the viewport that actually exists right now.
 * - `pb-[max(0.75rem,env(safe-area-inset-bottom))]` — the home indicator.
 * - `overscroll-contain` — a flick that reaches the end of the sheet's own
 *   scroll must not chain into whatever is behind it.
 *
 * ## Drag-to-dismiss
 *
 * Pointer Events, not touch events: one implementation then covers finger,
 * stylus and mouse, and the mouse case is the only one an automated browser
 * can exercise at all. Dragging DOWN past a threshold closes; anything else
 * springs back. A drag never publishes anything — dismissal keeps the draft,
 * which is the card's rule and not this component's to change.
 */

const SHEET_CONTENT_MOTION_CLASS =
  "transition-none duration-200 ease-out data-[state=closed]:duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom motion-reduce:animate-none";

/** How far down a drag must travel, in CSS px, before it dismisses. */
const DISMISS_DRAG_PX = 80;

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => {
  const { isDark } = useTheme();
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50",
        MODAL_OVERLAY_MOTION_CLASS,
        MODAL_BACKDROP_BLUR_CLASS,
        isDark ? "bg-black/60" : "bg-black/10",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
SheetOverlay.displayName = "SheetOverlay";

export interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Rendered below the scroll area, outside it — a footer stays reachable. */
  footer?: React.ReactNode;
  /**
   * Close the sheet. Required for the handle, because dismissal here is not
   * only a click: a drag has to close it too, and `DialogPrimitive.Close`
   * offers no imperative form. The host already owns `open`, so this is the
   * same setter it passes to `Sheet`.
   */
  onDismiss?: () => void;
  /** Hide the grab handle (and with it drag-to-dismiss). */
  showHandle?: boolean;
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(
  (
    { className, children, footer, onDismiss, showHandle = true, ...props },
    ref,
  ) => {
    const [dragY, setDragY] = React.useState(0);
    const dragFrom = React.useRef<number | null>(null);
    /** A drag that fell short must not also read as a tap on the handle. */
    const swallowClick = React.useRef(false);

    function endDrag(event: React.PointerEvent<HTMLElement>) {
      if (dragFrom.current === null) {
        return;
      }
      const travelled = event.clientY - dragFrom.current;
      dragFrom.current = null;
      setDragY(0);
      if (travelled > DISMISS_DRAG_PX) {
        swallowClick.current = true;
        onDismiss?.();
        return;
      }
      swallowClick.current = travelled > 0;
    }

    return (
      <SheetPortal>
        <SheetOverlay data-testid="sheet-overlay" />
        <DialogPrimitive.Content
          data-testid="sheet"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col",
            "rounded-t-2xl border-t bg-background shadow-2xl outline-hidden",
            "pb-[max(0.75rem,env(safe-area-inset-bottom))]",
            SHEET_CONTENT_MOTION_CLASS,
            className,
          )}
          // Translated only WHILE dragging, so the class-based enter/exit
          // animation owns the transform the rest of the time.
          style={
            dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined
          }
          ref={ref}
          {...props}
        >
          {showHandle && (
            <button
              type="button"
              data-testid="sheet-handle"
              aria-label="Close"
              className="flex shrink-0 cursor-grab touch-none justify-center py-2.5"
              onPointerDown={(event) => {
                dragFrom.current = event.clientY;
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (dragFrom.current === null) {
                  return;
                }
                // Downward only: an upward drag on a bottom sheet has nowhere
                // to go, and rubber-banding it would imply it did.
                setDragY(Math.max(0, event.clientY - dragFrom.current));
              }}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onClick={() => {
                if (swallowClick.current) {
                  swallowClick.current = false;
                  return;
                }
                onDismiss?.();
              }}
            >
              <span
                aria-hidden
                className="h-1 w-10 rounded-full bg-muted-foreground/30"
              />
            </button>
          )}
          <div
            data-testid="sheet-scroll"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-2"
          >
            {children}
          </div>
          {footer !== undefined && (
            <div
              data-testid="sheet-footer"
              className="shrink-0 border-t px-4 pt-2"
            >
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </SheetPortal>
    );
  },
);
SheetContent.displayName = "SheetContent";

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    className={cn("min-w-0 break-words text-sm font-semibold", className)}
    ref={ref}
    {...props}
  />
));
SheetTitle.displayName = "SheetTitle";

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    className={cn("text-xs text-muted-foreground", className)}
    ref={ref}
    {...props}
  />
));
SheetDescription.displayName = "SheetDescription";

export {
  DISMISS_DRAG_PX,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
