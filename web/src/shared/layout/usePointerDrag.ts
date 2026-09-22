import { useRef, type PointerEvent } from "react";

type DragElementEvent = PointerEvent<HTMLElement>;

/**
 * Pointer handlers for a horizontal drag handle that work for touch and pen
 * as well as the mouse (Sam's iPad, 2026-09-22: the side panes could not be
 * resized at all).
 *
 * Two things the old inline handlers got wrong on iPadOS:
 * - They read `event.movementX`, which WebKit reports as 0 for touch
 *   pointers. Deltas here come from `clientX` against the last position.
 * - Without `touch-action: none` on the handle the browser claims a touch
 *   drag as a pan and fires `pointercancel`. Pair these handlers with the
 *   `touch-none` class (see `PANE_RESIZE_HANDLE_CLASSES`).
 *
 * `onDrag` receives the raw rightward delta in px; the caller decides what
 * direction grows its pane. `onRelease` fires once per drag, on release or
 * cancel.
 */
export function usePointerDrag({
  onDrag,
  onRelease,
}: {
  onDrag: (deltaX: number) => void;
  onRelease?: () => void;
}) {
  const lastX = useRef<number | null>(null);
  const end = (event: DragElementEvent) => {
    if (lastX.current === null) {
      return;
    }
    lastX.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onRelease?.();
  };
  return {
    onPointerDown: (event: DragElementEvent) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      lastX.current = event.clientX;
    },
    onPointerMove: (event: DragElementEvent) => {
      if (lastX.current === null) {
        return;
      }
      const delta = event.clientX - lastX.current;
      lastX.current = event.clientX;
      if (delta !== 0) {
        onDrag(delta);
      }
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
  };
}

/**
 * Shared hit-area classes for a pane resize handle: `touch-none` so a finger
 * drag is not taken for a scroll, and an invisible ::before that widens the
 * grab target around the 4px visible strip (wider still on coarse pointers,
 * see `.buzz-resize-hit` in globals.css).
 */
export const PANE_RESIZE_HANDLE_CLASSES = "buzz-resize-hit touch-none";
