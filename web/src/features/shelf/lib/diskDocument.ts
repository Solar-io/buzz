/**
 * The Canvas file pane's DISK document (canvas edit plan
 * `~/.buzz/PLANS/CANVAS_EDIT_AGENT_BOX.md` §5): what the person and the
 * agent both edit is the file on the share's host, read and written through
 * stash. The relay blob stays the immutable "shared version".
 *
 *   off       — no Files URL configured: the feature is invisible (stock Buzz)
 *   locating  — asking stash where the path lives / loading it
 *   live      — disk content on screen; editable unless `editing` is open
 *   readonly  — the blob preview with a one-line reason (REASON_TEXT)
 *
 * Within `live`: `editing` (draft + the version it was based on), `saving`,
 * `conflict` (a 409's current state), `changedOnDisk` (a poll saw a new
 * version while the draft was dirty — the draft is kept).
 *
 * Every transition is a pure function so `node --test` drives the machine
 * directly; useDiskDocument.ts wires it to stashClient.ts.
 */

import type { StashDoc } from "./stashClient.ts";

export type ReadonlyReason =
  | "no-path"
  | "other-host"
  | "signed-out"
  | "unreachable"
  | "outside-roots"
  | "not-editable"
  | "too-large"
  | "lossy"
  | "gone";

/** The version of the file a document state knows. */
export interface DiskVersion {
  content: string;
  digest: string;
  mtimeMs: number;
}

export interface DiskDocState {
  phase: "off" | "locating" | "live" | "readonly";
  reason: ReadonlyReason | null;
  live: DiskVersion | null;
  editing: { draft: string; base: DiskVersion } | null;
  saving: boolean;
  conflict: { digest: string; mtimeMs: number | null } | null;
  /** A newer disk version than `editing.base`, held while the draft is dirty. */
  changedOnDisk: DiskVersion | null;
  /** The last save's refusal, in words (the draft is kept). */
  saveError: string | null;
  /** Set by a successful save; cleared by the next edit. */
  saved: boolean;
  /** A dirty draft whose file vanished: kept so it can still be copied. */
  orphanDraft: string | null;
}

export const OFF: DiskDocState = {
  phase: "off",
  reason: null,
  live: null,
  editing: null,
  saving: false,
  conflict: null,
  changedOnDisk: null,
  saveError: null,
  saved: false,
  orphanDraft: null,
};

export const LOCATING: DiskDocState = { ...OFF, phase: "locating" };

/** The one-line reason a document is read-only. `host` names the machine. */
export function reasonText(reason: ReadonlyReason, host = "crichton"): string {
  switch (reason) {
    case "no-path":
      return `Shared as a snapshot with no path on ${host}, so it can't be edited here. Ask the agent below.`;
    case "other-host":
      return "This file lives on another computer than the one Files opens, so it can't be edited here.";
    case "signed-out":
      return "Sign in to Files to edit";
    case "unreachable":
      return "Files isn't reachable";
    case "outside-roots":
      return "Outside the folders Files can open";
    case "not-editable":
      return "This file type isn't editable";
    case "too-large":
      return "Too large to edit here (over 2 MiB)";
    case "lossy":
      return "This file has bytes the editor can't round-trip";
    case "gone":
      return `This file was moved or deleted on ${host}`;
  }
}

/** The disk copy differs from the bytes that were shared (`imeta x`). */
export function editedSinceShared(
  liveDigest: string | null | undefined,
  sharedSha256: string | null | undefined,
): boolean {
  if (!liveDigest || !sharedSha256) {
    return false;
  }
  return liveDigest.toLowerCase() !== sharedSha256.toLowerCase();
}

export function isDirty(state: DiskDocState): boolean {
  return (
    state.editing !== null && state.editing.draft !== state.editing.base.content
  );
}

export function readonly(reason: ReadonlyReason): DiskDocState {
  return { ...OFF, phase: "readonly", reason };
}

const versionOf = (doc: StashDoc): DiskVersion => ({
  content: doc.content,
  digest: doc.digest,
  mtimeMs: doc.mtimeMs,
});

/** The first load answered 200. A lossy decode is read-only. */
export function loaded(doc: StashDoc): DiskDocState {
  if (doc.lossy) {
    return readonly("lossy");
  }
  return { ...OFF, phase: "live", live: versionOf(doc) };
}

/**
 * A poll answered 200 with a new version. Clean (or not editing): the new
 * content replaces what is on screen. Dirty: the draft is untouched and the
 * new version waits in `changedOnDisk` for the banner.
 */
export function polled(state: DiskDocState, doc: StashDoc): DiskDocState {
  if (state.phase !== "live") {
    return state;
  }
  if (doc.lossy) {
    return isDirty(state)
      ? { ...readonly("lossy"), orphanDraft: state.editing?.draft ?? null }
      : readonly("lossy");
  }
  const next = versionOf(doc);
  if (isDirty(state)) {
    return { ...state, changedOnDisk: next };
  }
  return {
    ...state,
    live: next,
    editing: state.editing ? { draft: next.content, base: next } : null,
    changedOnDisk: null,
  };
}

/** The file vanished (a poll or a save said so). A dirty draft survives. */
export function gone(state: DiskDocState): DiskDocState {
  return {
    ...readonly("gone"),
    orphanDraft: isDirty(state) ? (state.editing?.draft ?? null) : null,
  };
}

export function startEdit(state: DiskDocState): DiskDocState {
  if (state.phase !== "live" || !state.live || state.editing) {
    return state;
  }
  return {
    ...state,
    editing: { draft: state.live.content, base: state.live },
    saved: false,
    saveError: null,
  };
}

export function changeDraft(state: DiskDocState, draft: string): DiskDocState {
  if (!state.editing) {
    return state;
  }
  return {
    ...state,
    editing: { ...state.editing, draft },
    saved: false,
  };
}

export function cancelEdit(state: DiskDocState): DiskDocState {
  if (!state.editing) {
    return state;
  }
  // Leaving the editor shows the newest disk version we know of.
  const live = state.changedOnDisk ?? state.live;
  return {
    ...state,
    live,
    editing: null,
    conflict: null,
    changedOnDisk: null,
    saveError: null,
  };
}

export function saveStarted(state: DiskDocState): DiskDocState {
  return { ...state, saving: true, saveError: null, saved: false };
}

/** stash wrote the draft: it is the new live version and the new base. */
export function saveSucceeded(
  state: DiskDocState,
  content: string,
  digest: string,
  mtimeMs: number,
): DiskDocState {
  const live: DiskVersion = { content, digest, mtimeMs };
  return {
    ...state,
    live,
    editing: state.editing ? { draft: content, base: live } : null,
    saving: false,
    conflict: null,
    changedOnDisk: null,
    saveError: null,
    saved: true,
  };
}

export function saveConflicted(
  state: DiskDocState,
  digest: string,
  mtimeMs: number | null,
): DiskDocState {
  return { ...state, saving: false, conflict: { digest, mtimeMs } };
}

export function saveFailed(state: DiskDocState, message: string): DiskDocState {
  return { ...state, saving: false, saveError: message };
}

/**
 * Show their version: the disk's current content replaces the draft (the
 * caller confirmed the discard). Editing stays open on their version.
 */
export function takeTheirs(state: DiskDocState, doc: StashDoc): DiskDocState {
  if (doc.lossy) {
    return readonly("lossy");
  }
  const next = versionOf(doc);
  return {
    ...state,
    live: next,
    editing: state.editing ? { draft: next.content, base: next } : null,
    conflict: null,
    changedOnDisk: null,
    saveError: null,
  };
}

/** The words for a save the server refused (the draft is always kept). */
export function saveErrorText(
  kind:
    | "forbidden"
    | "too-large"
    | "not-editable"
    | "signed-out"
    | "unreachable",
): string {
  switch (kind) {
    case "forbidden":
      return "Files won't write here";
    case "too-large":
      return "Too large to save";
    case "not-editable":
      return "This file type isn't editable";
    case "signed-out":
      return "Not saved — sign in to Files";
    case "unreachable":
      return "Not saved — Files isn't reachable";
  }
}

/** A refusal from stash's locate / load, as a read-only reason. */
export function reasonFor(
  kind:
    | "not-editable"
    | "too-large"
    | "gone"
    | "signed-out"
    | "forbidden"
    | "unreachable",
): ReadonlyReason {
  switch (kind) {
    case "forbidden":
      return "outside-roots";
    default:
      return kind;
  }
}
