import { useCallback, useSyncExternalStore } from "react";

import {
  readUserLabels,
  setUserLabel,
  writeUserLabels,
  type UserLabels,
} from "./lib/userLabels.ts";

/**
 * Local nicknames, shared by every surface that shows a name.
 *
 * A module store rather than per-component state: renaming somebody in their
 * profile card has to change the timeline, the member list and the DM row in
 * the same frame, and a hook-local copy would leave three of them stale until
 * their next unrelated re-render.
 */

let labels: UserLabels | null = null;
const listeners = new Set<() => void>();

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function snapshot(): UserLabels {
  labels ??= readUserLabels(storage());
  return labels;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface UserLabelsApi {
  labels: UserLabels;
  /** Set a nickname, or clear it with an empty string. */
  rename: (pubkey: string, label: string) => void;
}

export function useUserLabels(): UserLabelsApi {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);

  const rename = useCallback((pubkey: string, label: string) => {
    labels = setUserLabel(snapshot(), pubkey, label);
    writeUserLabels(storage(), labels);
    for (const listener of listeners) {
      listener();
    }
  }, []);

  return { labels: current, rename };
}

/** Test seam: forget the in-memory copy so the next read re-hydrates. */
export function resetUserLabelsForTests(): void {
  labels = null;
  listeners.clear();
}
