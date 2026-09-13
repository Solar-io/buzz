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
 */
export const THREAD_WIDTH_STORAGE_KEY = "buzz.thread-width.v1";
export const THREAD_WIDTH_MIN = 288;
export const THREAD_WIDTH_DEFAULT = 384;
/** The channel column keeps at least this much, so widening the thread
 * never crushes the timeline to a sliver. */
const CHANNEL_COLUMN_FLOOR = 360;

export function threadWidthMax(rowWidth: number): number {
  return Math.max(THREAD_WIDTH_MIN, rowWidth - CHANNEL_COLUMN_FLOOR);
}

export function clampThreadWidth(value: number, rowWidth: number): number {
  return Math.min(
    threadWidthMax(rowWidth),
    Math.max(THREAD_WIDTH_MIN, value),
  );
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
