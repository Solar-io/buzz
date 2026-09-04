import { useCallback, useMemo, useSyncExternalStore } from "react";

import { getConfiguredFilesUrl } from "@/features/files/filesConfig";

import {
  addCustomPanel,
  allPanels,
  readCustomPanels,
  removeCustomPanel,
  writeCustomPanels,
  type WebPanelDef,
} from "./lib/panelRegistry.ts";
import {
  EMPTY_PANEL_SNAPSHOT,
  activateInstance,
  closeInstance,
  focusOrOpen,
  openInstance,
  pruneUnknownPanels,
  readPanelSession,
  writePanelSession,
  type OpenResult,
  type PanelSnapshot,
} from "./lib/panelSession.ts";

/**
 * Module-level store for the dock.
 *
 * Module scope rather than React state because the dock outlives the
 * component that renders it: closing the Files overlay and reopening it must
 * find the same tabs, and a `useState` in the overlay would be destroyed with
 * it. The reducers are all in `lib/panelSession.ts`; this file is only the
 * subscription plumbing and the persistence side effects.
 */

let customs: WebPanelDef[] = [];
let session: PanelSnapshot = EMPTY_PANEL_SNAPSHOT;
let hydrated = false;
const listeners = new Set<() => void>();

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function knownIds(): Set<string> {
  return new Set(allPanels(getConfiguredFilesUrl(), customs).map((p) => p.id));
}

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * One-shot hydration on first read.
 *
 * Order matters: the custom sites load first, because a restored session names
 * panel ids and a session restored against an empty registry would drop every
 * custom tab as unknown.
 */
function hydrate() {
  if (hydrated) {
    return;
  }
  hydrated = true;
  customs = readCustomPanels(storage());
  session = readPanelSession(storage(), knownIds()) ?? EMPTY_PANEL_SNAPSHOT;
}

function setSession(next: PanelSnapshot) {
  if (next === session) {
    return;
  }
  session = next;
  writePanelSession(storage(), session);
  emit();
}

function setCustoms(next: WebPanelDef[]) {
  customs = next;
  writeCustomPanels(storage(), customs);
  // A removed site's tabs cannot stay open — their iframe has no src.
  setSession(pruneUnknownPanels(session, knownIds()));
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): PanelSnapshot {
  hydrate();
  return session;
}

function customsSnapshot(): WebPanelDef[] {
  hydrate();
  return customs;
}

export interface WebPanelDock {
  /** Every site the dock can host: the built-in Files panel plus custom ones. */
  panels: WebPanelDef[];
  /** Open tabs, in order. */
  instances: PanelSnapshot["instances"];
  activeInstanceId: string | null;
  open: (panelId: string) => OpenResult;
  focusOrOpen: (panelId: string) => OpenResult;
  close: (instanceId: string) => void;
  activate: (instanceId: string) => void;
  addSite: (input: {
    url: string;
    label?: string;
  }) => { ok: true } | { ok: false; reason: string };
  removeSite: (panelId: string) => void;
}

export function useWebPanelDock(): WebPanelDock {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const custom = useSyncExternalStore(
    subscribe,
    customsSnapshot,
    customsSnapshot,
  );
  // The Files URL is per-browser settings rather than reactive state, so it is
  // re-read on every render and used AS a memo dependency. Memoizing on
  // `custom` alone would pin the registry to the URL that happened to be set
  // when the custom list last changed — so saving a Files URL in the setup
  // form would leave the dock still believing it has no panels.
  const filesUrl = getConfiguredFilesUrl();
  const panels = useMemo(() => allPanels(filesUrl, custom), [filesUrl, custom]);

  const open = useCallback((panelId: string) => {
    const result = openInstance(session, panelId, knownIds());
    if (result.ok) {
      setSession(result.snapshot);
    }
    return result;
  }, []);

  const focus = useCallback((panelId: string) => {
    const result = focusOrOpen(session, panelId, knownIds());
    if (result.ok) {
      setSession(result.snapshot);
    }
    return result;
  }, []);

  const close = useCallback((instanceId: string) => {
    setSession(closeInstance(session, instanceId));
  }, []);

  const activate = useCallback((instanceId: string) => {
    setSession(activateInstance(session, instanceId));
  }, []);

  const addSite = useCallback((input: { url: string; label?: string }) => {
    const result = addCustomPanel(customs, input);
    if (!result.ok) {
      return { ok: false as const, reason: result.reason };
    }
    setCustoms(result.panels);
    return { ok: true as const };
  }, []);

  const removeSite = useCallback((panelId: string) => {
    setCustoms(removeCustomPanel(customs, panelId));
  }, []);

  return {
    panels,
    instances: state.instances,
    activeInstanceId: state.activeInstanceId,
    open,
    focusOrOpen: focus,
    close,
    activate,
    addSite,
    removeSite,
  };
}

/** Test seam: forget everything the module store holds. */
export function resetWebPanelStoreForTests(): void {
  customs = [];
  session = EMPTY_PANEL_SNAPSHOT;
  hydrated = false;
  listeners.clear();
}
