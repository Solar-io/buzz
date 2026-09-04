/**
 * Where the picker panel goes.
 *
 * Extracted from the component so the arithmetic can be tested: it is the part
 * that silently breaks (a panel half off-screen, or covering the composer it
 * was opened from) and the part no render assertion would notice.
 */

/** Panel box, in CSS pixels. Fixed size: the grid is nine columns wide. */
export const PANEL_W = 340;
export const PANEL_H = 420;
/** Breathing room against the anchor and against the viewport edges. */
export const GAP = 8;

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
}

export interface Viewport {
  width: number;
  height: number;
}

function currentViewport(): Viewport {
  if (typeof window === "undefined") {
    return { width: 0, height: 0 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * Clamp the panel into the viewport, preferring to open ABOVE the anchor —
 * both call sites (the composer toolbar, a message's hover bar) sit low in the
 * window, so opening downwards would push the panel off the bottom.
 *
 * The `top` clamp is a `max(GAP, …)` and not just a `min`: in a window shorter
 * than the panel the min alone goes negative and the panel's search field ends
 * up above the top edge, unreachable.
 */
export function placePanel(
  rect: AnchorRect | null,
  viewport: Viewport = currentViewport(),
): { left: number; top: number } {
  if (!rect) {
    return { left: 0, top: 0 };
  }
  const left = Math.max(
    GAP,
    Math.min(rect.left, viewport.width - PANEL_W - GAP),
  );
  const fitsAbove = rect.top > PANEL_H + GAP * 2;
  const top = fitsAbove
    ? rect.top - PANEL_H - GAP
    : Math.max(
        GAP,
        Math.min(rect.bottom + GAP, viewport.height - PANEL_H - GAP),
      );
  return { left, top };
}
