import { useSyncExternalStore } from "react";

import { isFilesPath } from "./lib/openInFiles.ts";

/**
 * "Open in Files" from anywhere (Shelf rows, later a message's file card):
 * `openInFiles("/abs/path")` shows the Files page on that file (or folder). Module
 * scope, like the web layer's own store, so a caller needs no shell props.
 *
 * Each call is a new request (a fresh `nonce`) even for the same path: the
 * viewer may have browsed away inside Files since the last one.
 */

export interface FilesPathRequest {
  path: string;
  nonce: number;
}

let request: FilesPathRequest | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

/** Show Files on `absPath`. False (and nothing happens) for a bad path. */
export function openInFiles(absPath: string): boolean {
  if (!isFilesPath(absPath)) {
    return false;
  }
  nonce += 1;
  request = { path: absPath, nonce };
  for (const listener of listeners) {
    listener();
  }
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => request;

/** The latest request, or null before the first. */
export function useFilesPathRequest(): FilesPathRequest | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test seam. */
export function resetFilesPathForTests(): void {
  request = null;
  listeners.clear();
}
