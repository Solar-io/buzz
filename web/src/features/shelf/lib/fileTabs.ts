/**
 * The right pane's CANVAS (Sam, 2026-09-30): the pane has exactly two
 * top-level tabs, Work and Canvas. Work is the action feed; Canvas holds
 * documents — the conversation's channel canvas (kind 40100) first, then
 * every file opened from chat or the Shelf, each a closable sub-tab.
 *
 * Opening a file adds it to Canvas, selects it and puts Canvas on screen.
 * Picking Work (or Thinking) hides Canvas without forgetting what was
 * selected in it, so coming back lands on the same document. Closing the
 * selected document moves to its left neighbour (the right one from the
 * first); closing the last one hands the pane back to Work.
 *
 * Pure so `node --test` loads it directly; FileTabsProvider owns the state.
 */

/** Everything a tab needs to render its file without looking it up again. */
export interface OpenFile {
  key: string;
  url: string;
  filename: string;
  mime: string | null;
  size: number | null;
  /** The message that carried it (comments are replies to it). */
  channelId: string | null;
  messageId: string | null;
  authorPubkey: string | null;
  createdAt: number | null;
  /** The share's thread markers, for the comment's root. */
  rootId: string | null;
  replyToId: string | null;
  /** Raw `path` tag value (`crichton:/abs`), when the share carried one. */
  path: string | null;
  /**
   * The shared bytes' SHA-256 (`imeta x`), for "Edited since shared". Tabs
   * opened before this field existed lack it: read with `?? null` and heal
   * from the Shelf (FilePreview), as `path` is healed.
   */
  sha256?: string | null;
}

export interface FileTabsState {
  files: OpenFile[];
  /**
   * The Canvas document last chosen: a file key or {@link CHANNEL_CANVAS_KEY}.
   * Null, or a key no longer present, means "the first document".
   */
  active: string | null;
  /** Canvas is the pane's tab on screen (over Work / Thinking). */
  open: boolean;
  /** The Canvas covers the conversation (expand-to-full). */
  expanded: boolean;
}

export const EMPTY_FILE_TABS: FileTabsState = {
  files: [],
  active: null,
  open: false,
  expanded: false,
};

/**
 * The conversation's channel canvas among the Canvas documents. It is not a
 * file (a file key always carries `|`), and it follows the conversation: in
 * #a it is #a's canvas, in #b it is #b's.
 */
export const CHANNEL_CANVAS_KEY = "canvas:channel";

/** More than this and the oldest tab you are not looking at closes. */
export const MAX_FILE_TABS = 6;

/** One tab per (message, file): the same blob shared twice has two threads. */
export function fileTabKey(messageId: string | null, url: string): string {
  return `${messageId ?? "-"}|${url}`;
}

/** The Canvas documents in sub-tab order: the channel canvas, then files. */
export function canvasItemKeys(
  files: readonly string[],
  channelCanvas: boolean,
): string[] {
  return channelCanvas ? [CHANNEL_CANVAS_KEY, ...files] : [...files];
}

/** The document on screen: the chosen one while it exists, else the first. */
export function resolveCanvasItem(
  items: readonly string[],
  active: string | null,
): string | null {
  if (active !== null && items.includes(active)) {
    return active;
  }
  return items[0] ?? null;
}

/**
 * The file the viewer chose and is looking at — what a tile or Shelf row
 * highlights. Null while Canvas is hidden or its choice is not a file.
 */
export function fileOnScreen(state: FileTabsState): string | null {
  if (!state.open || state.active === null) {
    return null;
  }
  return state.files.some((open) => open.key === state.active)
    ? state.active
    : null;
}

export function openFileTab(
  state: FileTabsState,
  file: OpenFile,
): FileTabsState {
  if (state.files.some((open) => open.key === file.key)) {
    return { ...state, active: file.key, open: true };
  }
  let files = [...state.files, file];
  while (files.length > MAX_FILE_TABS) {
    const drop = files.findIndex(
      (open) => open.key !== file.key && open.key !== state.active,
    );
    files = files.filter((_, index) => index !== (drop === -1 ? 0 : drop));
  }
  return { ...state, files, active: file.key, open: true };
}

/**
 * Close one file. `items` is the Canvas order as drawn (the channel canvas
 * included); without it the files alone are the order.
 */
export function closeFileTab(
  state: FileTabsState,
  key: string,
  items: readonly string[] = state.files.map((open) => open.key),
): FileTabsState {
  if (!state.files.some((open) => open.key === key)) {
    return state;
  }
  const files = state.files.filter((open) => open.key !== key);
  const order = items.includes(key) ? items : [...items, key];
  if (resolveCanvasItem(order, state.active) !== key) {
    return { ...state, files };
  }
  const index = order.indexOf(key);
  const remaining = order.filter((item) => item !== key);
  const active = index > 0 ? order[index - 1] : (remaining[0] ?? null);
  if (active === null) {
    // Nothing left in Canvas: the pane goes back to Work.
    return { files, active: null, open: false, expanded: false };
  }
  return { ...state, files, active };
}

/** Pick a Canvas document (a file, or the channel canvas) and show Canvas. */
export function selectFileTab(
  state: FileTabsState,
  key: string,
): FileTabsState {
  if (
    key !== CHANNEL_CANVAS_KEY &&
    !state.files.some((open) => open.key === key)
  ) {
    return state;
  }
  return { ...state, active: key, open: true };
}

/** Show Canvas, or hand the pane back to Work / Thinking (which unexpands). */
export function showCanvas(state: FileTabsState, open: boolean): FileTabsState {
  if (open) {
    return state.open ? state : { ...state, open: true };
  }
  return state.open || state.expanded
    ? { ...state, open: false, expanded: false }
    : state;
}

export function setFileTabsExpanded(
  state: FileTabsState,
  expanded: boolean,
): FileTabsState {
  if (!state.open) {
    return state.expanded ? { ...state, expanded: false } : state;
  }
  return state.expanded === expanded ? state : { ...state, expanded };
}

/** The file pane's own width (Preview artboard: 540), like the Work rail's. */
export const FILE_PANE_DEFAULT_WIDTH = 540;
export const FILE_PANE_MIN_WIDTH = 380;
export const FILE_PANE_MAX_WIDTH = 960;
const FILE_WIDTH_KEY = "buzz.file-width.v1";

export function clampFileWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return FILE_PANE_DEFAULT_WIDTH;
  }
  return Math.round(
    Math.min(FILE_PANE_MAX_WIDTH, Math.max(FILE_PANE_MIN_WIDTH, width)),
  );
}

export function loadFileWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(FILE_WIDTH_KEY);
    return raw ? clampFileWidth(Number(raw)) : FILE_PANE_DEFAULT_WIDTH;
  } catch {
    return FILE_PANE_DEFAULT_WIDTH;
  }
}

export function saveFileWidth(width: number): void {
  try {
    globalThis.localStorage?.setItem(FILE_WIDTH_KEY, String(width));
  } catch {
    // Best effort: the default still applies.
  }
}
