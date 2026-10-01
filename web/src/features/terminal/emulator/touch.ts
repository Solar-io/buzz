/**
 * The PURE arithmetic behind touch scroll (evie-ui ADR-032, `term-touch.js`,
 * carried verbatim in behaviour). iOS never fires `wheel` for a touch drag,
 * and herdr turns mouse tracking on for the whole session, so xterm's own
 * touch scroll is dead. input.ts turns a drag into synthetic WheelEvents that
 * xterm encodes itself; this file is everything that can be wrong in a way a
 * unit test can catch.
 */

/** Tap-vs-drag threshold in CSS px (iOS's own tap slop). Movement only, no time limit. */
export const TOUCH_SLOP_PX = 10;
export const NOTCH_MIN_PX = 8;
export const NOTCH_MAX_PX = 48;
/** Used when the screen measurement is degenerate (not laid out, rows 0). */
export const NOTCH_FALLBACK_PX = 17;
/** Rows of finger travel per wheel report. */
export const TOUCH_NOTCH_ROWS = 1;
/** At most this many reports from ONE touchmove; the surplus is carried, not lost. */
export const MAX_NOTCHES_PER_MOVE = 8;

/**
 * One notch = one row of finger travel, measured at touchstart. EVERY
 * degenerate input lands on the fallback: a 0/NaN notch would make the drain
 * loop spin forever, emitting wheel reports into a live agent's TUI.
 */
export function resolveNotchPx(
  screenHeightPx: number,
  rows: number,
  rowsPerNotch = TOUCH_NOTCH_ROWS,
): number {
  const h = Number(screenHeightPx);
  const r = Number(rows);
  if (!Number.isFinite(h) || !Number.isFinite(r) || h <= 0 || r <= 0) {
    return NOTCH_FALLBACK_PX;
  }
  const cell = h / r;
  if (!Number.isFinite(cell) || cell <= 0) {
    return NOTCH_FALLBACK_PX;
  }
  const notch =
    cell *
    (Number.isFinite(rowsPerNotch) && rowsPerNotch > 0 ? rowsPerNotch : 1);
  if (!Number.isFinite(notch) || notch <= 0) {
    return NOTCH_FALLBACK_PX;
  }
  return Math.min(Math.max(notch, NOTCH_MIN_PX), NOTCH_MAX_PX);
}

/** Finger travel since the last sample, UP positive (client Y grows downward). */
export function fingerDeltaUp(prevY: number, y: number): number {
  return prevY - y;
}

/** ±1 with DOM_DELTA_LINE: the one shape guaranteed to give exactly one report. */
export function wheelDeltaY(dir: number): number {
  return dir > 0 ? 1 : -1;
}

export function isWithinSlop(
  dx: number,
  dy: number,
  slop = TOUCH_SLOP_PX,
): boolean {
  return Math.hypot(dx, dy) <= slop;
}

/** Drain whole notches; the remainder is CARRIED so a long drag never drifts. */
export function drainNotches(
  accum: number,
  notchPx: number,
  cap = MAX_NOTCHES_PER_MOVE,
): { dir: number; count: number; accum: number } {
  const px = Number(notchPx);
  if (!Number.isFinite(px) || px <= 0) {
    return { dir: 0, count: 0, accum };
  }
  let a = Number(accum);
  if (!Number.isFinite(a)) {
    return { dir: 0, count: 0, accum: 0 };
  }
  if (Math.abs(a) < px) {
    return { dir: 0, count: 0, accum: a };
  }
  const dir = a > 0 ? 1 : -1;
  const limit = Number.isFinite(cap) && cap > 0 ? cap : MAX_NOTCHES_PER_MOVE;
  let count = 0;
  while (Math.abs(a) >= px && count < limit) {
    a -= dir * px;
    count += 1;
  }
  return { dir: count > 0 ? dir : 0, count, accum: a };
}
