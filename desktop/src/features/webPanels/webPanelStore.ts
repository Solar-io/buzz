import * as React from "react";

export type WebPanelMode = "closed" | "docked" | "maximized";

type Snapshot = {
  mode: WebPanelMode;
  openPanelId: string | null;
};

let snapshot: Snapshot = { mode: "closed", openPanelId: null };
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function setWebPanelMode(mode: WebPanelMode) {
  if (snapshot.mode === mode) return;
  publish({ ...snapshot, mode });
}

/**
 * Open a panel, replacing whichever panel is currently open; toggling the
 * already-open panel closes it. Switching panels keeps the current mode, so
 * a maximized dock stays maximized across a swap.
 */
export function toggleWebPanel(panelId: string) {
  if (snapshot.openPanelId === panelId && snapshot.mode !== "closed") {
    publish({ mode: "closed", openPanelId: null });
    return;
  }
  publish({
    mode: snapshot.mode === "closed" ? "docked" : snapshot.mode,
    openPanelId: panelId,
  });
}

export function useWebPanel() {
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

export function resetWebPanelForTests() {
  snapshot = { mode: "closed", openPanelId: null };
}

export function getWebPanelSnapshotForTests() {
  return snapshot;
}
