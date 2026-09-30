/**
 * Keep one element at the same viewport offset while the list around it
 * re-measures — an inline thread opening under its message.
 *
 * Measured 2026-09-30 (Phase 2 e2e): a row whose top sat above the fold grew
 * UPWARD when its thread opened, because the virtualizer anchors on the
 * first visible item and compensates a size change above it by scrolling.
 * The reader clicked "3 replies" and was shown the reply box of a thread
 * whose replies had all left the screen. Measuring the element before the
 * change and correcting the difference for a few frames (virtua measures
 * over more than one) makes the thread open downward, from where the reader
 * clicked.
 *
 * Call it BEFORE the state change that grows the row: the first reading
 * must be the old layout.
 */
export function holdAnchor(
  scroller: HTMLElement,
  selector: string,
  frames = 8,
): void {
  const top = () =>
    scroller.querySelector(selector)?.getBoundingClientRect().top;
  const before = top();
  if (before === undefined) {
    return;
  }
  let left = frames;
  const settle = () => {
    const now = top();
    if (now !== undefined && Math.abs(now - before) > 0.5) {
      scroller.scrollTop += now - before;
    }
    left -= 1;
    if (left > 0) {
      requestAnimationFrame(settle);
    }
  };
  requestAnimationFrame(settle);
}
