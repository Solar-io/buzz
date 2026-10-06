import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelEdit,
  changeDraft,
  type DiskDocState,
  gone,
  isDirty,
  LOCATING,
  loaded,
  OFF,
  polled,
  readonly,
  reasonFor,
  saveConflicted,
  saveErrorText,
  saveFailed,
  saveStarted,
  saveSucceeded,
  startEdit,
  takeTheirs,
} from "./lib/diskDocument.ts";
import { filesTarget, type SharePath } from "./lib/shareEvent.ts";
import {
  type LocateResult,
  locate,
  readFile,
  type StashAddress,
  saveFile,
  sha256Hex,
} from "./lib/stashClient.ts";

/** stash's own editor polls at this rate (`FAST_POLL_MS`, editor-tabs.js). */
export const POLL_MS = 3_000;
/** After this many network failures in a row the poll slows to BACKOFF_MS. */
export const POLL_FAILURES_BEFORE_BACKOFF = 3;
export const BACKOFF_MS = 30_000;

/** `locate` answers per absolute path, for the session (only successes). */
const locateCache = new Map<string, Promise<LocateResult>>();

function locateCached(filesUrl: string, abs: string): Promise<LocateResult> {
  const key = `${filesUrl}\n${abs}`;
  const hit = locateCache.get(key);
  if (hit) {
    return hit;
  }
  const promise = locate(filesUrl, abs).then((result) => {
    if (result.kind !== "ok") {
      locateCache.delete(key);
    }
    return result;
  });
  locateCache.set(key, promise);
  return promise;
}

function forgetLocate(filesUrl: string, abs: string): void {
  locateCache.delete(`${filesUrl}\n${abs}`);
}

export interface DiskDocument {
  state: DiskDocState;
  dirty: boolean;
  edit: () => void;
  change: (draft: string) => void;
  cancel: () => void;
  /** Save the draft. Resolves true when the disk holds it. */
  save: () => Promise<boolean>;
  /** After a 409: write the draft over their version (explicit, one click). */
  overwrite: () => Promise<boolean>;
  /** Replace the draft with the disk's current version (caller confirmed). */
  showTheirs: () => Promise<void>;
}

/**
 * The disk copy of a shared file, through stash (useDiskDocument in the
 * canvas edit plan): locate → load → a visibility-gated 3 s poll (304s while
 * unchanged) → save behind the digest precondition.
 *
 * `path` is the share's `host:path`; `filesUrl` the configured Files URL
 * (empty = feature off). No path, a share whose author is neither the viewer
 * nor a known agent, or a path on another host, is read-only with a reason
 * before any request is made. Nothing is ever written except by an explicit
 * Save / Overwrite / Save-and-send: there is no autosave.
 */
export function useDiskDocument(
  path: SharePath | null,
  filesUrl: string,
  /** diskTrusted(): the share's author is the viewer or a known agent. */
  trusted: boolean,
): DiskDocument {
  const [state, setState] = useState<DiskDocState>(OFF);
  const stateRef = useRef(state);
  stateRef.current = state;
  const addressRef = useRef<StashAddress | null>(null);
  const abs = path ? filesTarget(path, filesUrl) : null;
  const pathKey = path ? `${path.host}:${path.path}` : "";

  const apply = useCallback(
    (update: (previous: DiskDocState) => DiskDocState) => {
      setState((previous) => {
        const next = update(previous);
        stateRef.current = next;
        return next;
      });
    },
    [],
  );

  // Locate + first load whenever the file (or the Files URL) changes.
  useEffect(() => {
    addressRef.current = null;
    if (filesUrl === "") {
      apply(() => OFF);
      return;
    }
    if (pathKey === "") {
      apply(() => readonly("no-path"));
      return;
    }
    // Confused-deputy gate (diskDocument.ts diskTrusted): a share by anyone
    // else never makes this browser read or write its path with the viewer's
    // stash session.
    if (!trusted) {
      apply(() => readonly("untrusted-author"));
      return;
    }
    if (abs === null) {
      apply(() => readonly("other-host"));
      return;
    }
    let cancelled = false;
    apply(() => LOCATING);
    void (async () => {
      const where = await locateCached(filesUrl, abs);
      if (cancelled) {
        return;
      }
      if (where.kind !== "ok") {
        apply(() => readonly(reasonFor(where.kind)));
        return;
      }
      const read = await readFile(filesUrl, where.address);
      if (cancelled) {
        return;
      }
      if (read.kind === "ok") {
        addressRef.current = where.address;
        apply(() => loaded(read.doc));
        return;
      }
      if (read.kind === "forbidden" || read.kind === "gone") {
        forgetLocate(filesUrl, abs);
      }
      apply(() =>
        readonly(
          read.kind === "not-modified" ? "unreachable" : reasonFor(read.kind),
        ),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [filesUrl, abs, pathKey, trusted, apply]);

  const phase = state.phase;
  const saving = state.saving;

  // The poll: every 3 s while the document is live, the tab visible and no
  // save is in flight. 304 = nothing. Network failures back off to 30 s and
  // are never shown as editor errors (stash's own rule).
  useEffect(() => {
    if (phase !== "live" || saving || abs === null) {
      return;
    }
    let cancelled = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const visible = () =>
      typeof document === "undefined" || document.visibilityState !== "hidden";
    const schedule = () => {
      if (cancelled) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(
        tick,
        failures >= POLL_FAILURES_BEFORE_BACKOFF ? BACKOFF_MS : POLL_MS,
      );
    };
    const tick = async () => {
      timer = null;
      const address = addressRef.current;
      const current = stateRef.current;
      if (cancelled || !address || !visible() || current.saving) {
        if (!cancelled && visible()) {
          schedule();
        }
        return;
      }
      const known =
        current.changedOnDisk?.mtimeMs ??
        current.editing?.base.mtimeMs ??
        current.live?.mtimeMs ??
        null;
      const result = await readFile(filesUrl, address, known);
      if (cancelled) {
        return;
      }
      if (result.kind === "unreachable") {
        failures += 1;
      } else {
        failures = 0;
      }
      if (result.kind === "ok") {
        apply((previous) => polled(previous, result.doc));
      } else if (result.kind === "gone") {
        forgetLocate(filesUrl, abs);
        apply((previous) => gone(previous));
        return;
      }
      schedule();
    };
    const onVisibility = () => {
      if (visible()) {
        failures = 0;
        schedule();
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const onFocus = () => {
      failures = 0;
      if (visible()) {
        schedule();
      }
    };
    if (visible()) {
      schedule();
    }
    document.addEventListener?.("visibilitychange", onVisibility);
    globalThis.addEventListener?.("focus", onFocus);
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
      document.removeEventListener?.("visibilitychange", onVisibility);
      globalThis.removeEventListener?.("focus", onFocus);
    };
  }, [phase, saving, abs, filesUrl, apply]);

  const put = useCallback(
    async (digest: string): Promise<boolean> => {
      const address = addressRef.current;
      const editing = stateRef.current.editing;
      if (!address || !editing || stateRef.current.saving) {
        return false;
      }
      const draft = editing.draft;
      apply(saveStarted);
      const result = await saveFile(filesUrl, address, draft, digest);
      switch (result.kind) {
        case "ok":
          apply((previous) =>
            saveSucceeded(previous, draft, result.digest, result.mtimeMs),
          );
          return true;
        case "conflict":
          apply((previous) =>
            saveConflicted(previous, result.digest, result.mtimeMs),
          );
          return false;
        case "gone":
          apply((previous) => gone(previous));
          return false;
        case "unreachable": {
          // No automatic retry (a PUT is not idempotent against a moving
          // digest). Re-load: if the disk already holds the draft, the save
          // landed and only its answer was lost.
          const check = await readFile(filesUrl, address);
          const want = await sha256Hex(draft);
          if (
            check.kind === "ok" &&
            want !== null &&
            check.doc.digest === want
          ) {
            apply((previous) =>
              saveSucceeded(
                previous,
                draft,
                check.doc.digest,
                check.doc.mtimeMs,
              ),
            );
            return true;
          }
          apply((previous) => saveFailed(previous, saveErrorText(result.kind)));
          return false;
        }
        default:
          apply((previous) => saveFailed(previous, saveErrorText(result.kind)));
          return false;
      }
    },
    [filesUrl, apply],
  );

  const save = useCallback(async () => {
    const editing = stateRef.current.editing;
    if (!editing) {
      return false;
    }
    // Always the digest of the version the draft was based on (D7).
    return put(editing.base.digest);
  }, [put]);

  const overwrite = useCallback(async () => {
    const conflict = stateRef.current.conflict;
    if (!conflict) {
      return false;
    }
    return put(conflict.digest);
  }, [put]);

  const showTheirs = useCallback(async () => {
    const address = addressRef.current;
    if (!address) {
      return;
    }
    const result = await readFile(filesUrl, address);
    if (result.kind === "ok") {
      apply((previous) => takeTheirs(previous, result.doc));
    } else if (result.kind === "gone") {
      apply((previous) => gone(previous));
    }
  }, [filesUrl, apply]);

  return {
    state,
    dirty: isDirty(state),
    edit: useCallback(() => apply(startEdit), [apply]),
    change: useCallback(
      (draft: string) => apply((previous) => changeDraft(previous, draft)),
      [apply],
    ),
    cancel: useCallback(() => apply(cancelEdit), [apply]),
    save,
    overwrite,
    showTheirs,
  };
}
