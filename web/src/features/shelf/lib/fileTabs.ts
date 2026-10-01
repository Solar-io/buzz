/**
 * The right pane's file tabs (web redesign Phase 6; Shelf and Preview
 * artboards): opening a file from chat or the Shelf adds a tab beside Work.
 *
 * File tabs sit AFTER the shell's own tabs (Work, Thinking) and over them:
 * while a file is active it is what the pane shows; `active: null` hands the
 * pane back to whichever shell tab was on screen. Closing the active file
 * moves to the file on its left, and from the first file back to the shell
 * tab — "closing a tab returns to the previous one" (phase-1 §3).
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
}

export interface FileTabsState {
  files: OpenFile[];
  /** The file on screen, or null for the shell's own tab. */
  active: string | null;
  /** The active file covers the conversation (expand-to-full). */
  expanded: boolean;
}

export const EMPTY_FILE_TABS: FileTabsState = {
  files: [],
  active: null,
  expanded: false,
};

/** More than this and the oldest tab you are not looking at closes. */
export const MAX_FILE_TABS = 6;

/** One tab per (message, file): the same blob shared twice has two threads. */
export function fileTabKey(messageId: string | null, url: string): string {
  return `${messageId ?? "-"}|${url}`;
}

export function openFileTab(
  state: FileTabsState,
  file: OpenFile,
): FileTabsState {
  if (state.files.some((open) => open.key === file.key)) {
    return { ...state, active: file.key };
  }
  let files = [...state.files, file];
  while (files.length > MAX_FILE_TABS) {
    const drop = files.findIndex(
      (open) => open.key !== file.key && open.key !== state.active,
    );
    files = files.filter((_, index) => index !== (drop === -1 ? 0 : drop));
  }
  return { ...state, files, active: file.key };
}

export function closeFileTab(state: FileTabsState, key: string): FileTabsState {
  const index = state.files.findIndex((open) => open.key === key);
  if (index === -1) {
    return state;
  }
  const files = state.files.filter((open) => open.key !== key);
  if (state.active !== key) {
    return { ...state, files };
  }
  const active = index > 0 ? files[index - 1].key : null;
  return { files, active, expanded: active === null ? false : state.expanded };
}

/** Pick a file tab, or `null` for the shell's own tab (which also unexpands). */
export function selectFileTab(
  state: FileTabsState,
  key: string | null,
): FileTabsState {
  if (key !== null && !state.files.some((open) => open.key === key)) {
    return state;
  }
  return {
    ...state,
    active: key,
    expanded: key === null ? false : state.expanded,
  };
}

export function setFileTabsExpanded(
  state: FileTabsState,
  expanded: boolean,
): FileTabsState {
  if (state.active === null) {
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
