/**
 * Right-pane (thread / agent activity) width policy. The pane is
 * drag-resizable and its width persists in localStorage
 * (`buzz.thread-width.v1`). The ceiling is relative to the LAYOUT ROW —
 * the flex row that holds timeline + drag handle + pane, i.e. the window
 * minus the app sidebar — so the thread may take everything except a
 * livable channel column (Sam 9/13: expand it "as wide as I want"),
 * replacing the old fixed 640px cap. Clamping against the window instead
 * lets the pane starve the timeline whenever the sidebar is open (QA
 * 9/13: 56px of timeline at max width). The floor keeps the pane usable;
 * on rows too narrow for both columns, the floor wins.
 *
 * Everything here is pure math; only `paneRowStyle`'s SHAPE is React's (the
 * row's inline style) — a type-only import, no runtime dependency.
 */
import type { CSSProperties } from "react";

export const THREAD_WIDTH_STORAGE_KEY = "buzz.thread-width.v1";
export const THREAD_WIDTH_MIN = 288;
/**
 * The width a pane opens at, and the floor it can never sit below on a row
 * that can afford it (Sam 9/17: "at least 600px" — a 384 default read as
 * "very small" on every DM/channel open). Rows too narrow for 600 plus a
 * livable channel column keep the responsive `THREAD_WIDTH_MIN` behavior.
 */
export const THREAD_WIDTH_COMFORT_MIN = 600;
export const THREAD_WIDTH_DEFAULT = THREAD_WIDTH_COMFORT_MIN;
/** The channel column keeps at least this much, so widening the thread
 * never crushes the timeline to a sliver. */
const CHANNEL_COLUMN_FLOOR = 360;
/** The channel column a row must leave beside a 600 pane before the 600
 * comfort floor applies (see `threadWidthFloor`). */
const CHANNEL_COLUMN_COMFORT = 640;

/** The portrait rail never shrinks below this (readability floor). */
export const PORTRAIT_RAIL_MIN_WIDTH = 160;
/** …never grows above this, whatever the pane is doing. */
export const PORTRAIT_RAIL_MAX_WIDTH = 300;
/** Chrome above/below the portrait frame (app header + paddings). */
export const PORTRAIT_FRAME_CHROME_PX = 176;

/**
 * The stationary portrait rail's width, in JS — ONE source of truth for
 * both the rendered rail (repos.tsx sets it as the row's
 * `--portrait-rail-w` var) and the width-cap reservation.
 *
 * Two competing terms: the rail wants 38% of the pane's width (it grows
 * with the pane the user drags), but it must also stay a 3:4 frame that
 * FITS the viewport height — so it is capped at 0.75× the space between
 * the app chrome, which makes the frame's height ≤ viewport − chrome and
 * means the frame never needs a max-height or crop of its own. The result
 * is clamped to [PORTRAIT_RAIL_MIN_WIDTH, PORTRAIT_RAIL_MAX_WIDTH].
 */
export function portraitRailWidth(
  threadWidthPx: number,
  viewportHeightPx: number,
): number {
  return Math.min(
    PORTRAIT_RAIL_MAX_WIDTH,
    Math.max(
      PORTRAIT_RAIL_MIN_WIDTH,
      Math.min(
        threadWidthPx * 0.38,
        (viewportHeightPx - PORTRAIT_FRAME_CHROME_PX) * 0.75,
      ),
    ),
  );
}

/**
 * Ceiling for the pane width on a layout row of `rowWidth` px.
 *
 * `reservedPx` carves space out of the row budget first: the stationary
 * portrait rail is part of the pane's column at lg, so while it is up the
 * reservation (`portraitRailWidth` of the candidate being clamped) must
 * come off the budget BEFORE the channel column's floor is applied —
 * otherwise the pane + rail pair can crush the timeline below its livable
 * floor even while every clamp is "passing". `reservedPx = 0` (the
 * default) is exactly the pre-reservation math; the floor still wins on
 * rows too narrow for everything.
 */
export function threadWidthMax(rowWidth: number, reservedPx = 0): number {
  return Math.max(
    THREAD_WIDTH_MIN,
    rowWidth - CHANNEL_COLUMN_FLOOR - reservedPx,
  );
}

/**
 * The floor `clampThreadWidth` enforces: 600 wherever the row affords it,
 * degrading to the responsive minimum only on rows too narrow for a 600 pane
 * plus a livable channel column. A stale persisted width from before the
 * comfort floor (a 288 min-drag, the old 384 default) is resurrected to 600
 * by this — on wide rows — instead of replaying "very small" on every open.
 *
 * "Affords it" means the channel column keeps CHANNEL_COLUMN_COMFORT beside
 * a 600 pane, not merely its 360 floor. On an iPad (Sam 9/22: ~1084px row)
 * the old rule pinned the pane at 600 and left the chat ~480px, where the
 * composer's buttons collided — and the pane could not be dragged narrower.
 * Rows below that keep the responsive THREAD_WIDTH_MIN floor so the user can
 * trade pane width for chat width.
 */
export function threadWidthFloor(rowWidth: number, reservedPx = 0): number {
  if (
    rowWidth - reservedPx <
    THREAD_WIDTH_COMFORT_MIN + CHANNEL_COLUMN_COMFORT
  ) {
    return THREAD_WIDTH_MIN;
  }
  return Math.min(
    THREAD_WIDTH_COMFORT_MIN,
    threadWidthMax(rowWidth, reservedPx),
  );
}

export function clampThreadWidth(
  value: number,
  rowWidth: number,
  reservedPx = 0,
): number {
  return Math.min(
    threadWidthMax(rowWidth, reservedPx),
    Math.max(threadWidthFloor(rowWidth, reservedPx), value),
  );
}

/**
 * The DM layout row's inline style: the pane width and the portrait rail's
 * computed width (the output of `portraitRailWidth`, so the rendered rail
 * and the width-cap reservation can never disagree). The rail var reads
 * 0px while the rail is hidden — nothing consumes it then (the rail is not
 * mounted). Extracted pure so the row's style WIRING is unit-testable
 * without mounting the whole route (QA 2026-09-14: deleting the style prop
 * left every other test green).
 */
export function paneRowStyle(
  threadWidthPx: number,
  viewportHeightPx: number,
  railVisible: boolean,
): CSSProperties {
  return {
    ["--thread-width" as string]: `${threadWidthPx}px`,
    ["--portrait-rail-w" as string]: railVisible
      ? `${portraitRailWidth(threadWidthPx, viewportHeightPx)}px`
      : "0px",
  };
}

/**
 * Parse a persisted width. Returns null when absent or below the floor —
 * callers fall back to the default rather than resurrecting a junk value.
 * Values above the old 640 cap are accepted here; the row clamp is
 * applied by the caller so a width persisted on a big screen still loads
 * (clamped) on a small one.
 */
export function parseStoredThreadWidth(raw: string | null): number | null {
  const stored = Number.parseFloat(raw ?? "");
  return Number.isFinite(stored) && stored >= THREAD_WIDTH_MIN ? stored : null;
}
