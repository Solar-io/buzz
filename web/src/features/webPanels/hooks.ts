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
  PANEL_SESSION_STORAGE_KEY,
  type OpenResult,
  type PanelSnapshot,
} from "./lib/panelSession.ts";
import { createDockStore, FILES_DOCK_SCOPE } from "./lib/dockStore.ts";

/**
 * The Files dock.
 *
 * The session store is a {@link createDockStore} instance (scoped, so the
 * same machinery also drives the shortcut-bar overlay's per-channel dock
 * elsewhere); what remains here is the Files-specific part: the user's own
 * site list, its localStorage persistence, and the registry derivation from
 * the per-browser Files URL. The reducers are all in `lib/panelSession.ts`.
 */

const store = createDockStore({
  storageKey: PANEL_SESSION_STORAGE_KEY,
  initialScope: FILES_DOCK_SCOPE,
});

let customs: WebPanelDef[] = [];
let customsHydrated = false;
const customsListeners = new Set<() => void>();

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The full registry as of RIGHT NOW — the Files URL is a setting, not state. */
function currentRegistry(): WebPanelDef[] {
  return allPanels(getConfiguredFilesUrl(), customs);
}

function emitCustoms() {
  for (const listener of customsListeners) {
    listener();
  }
}

/**
 * One-shot hydration of the custom sites.
 *
 * Order matters: the custom sites load before the store hydrates its
 * session, because a restored session names panel ids and a session restored
 * against an empty registry would drop every custom tab as unknown.
 */
function hydrateCustoms() {
  if (customsHydrated) {
    return;
  }
  customsHydrated = true;
  customs = readCustomPanels(storage());
}

function setCustoms(next: WebPanelDef[]) {
  customs = next;
  writeCustomPanels(storage(), customs);
  // A removed site's tabs cannot stay open — their iframe has no src. This
  // sync is unconditional (unlike the render-time one below): a real removal
  // must kill its tabs even when that empties the registry.
  store.setPanels(currentRegistry());
  emitCustoms();
}

function subscribeCustoms(listener: () => void) {
  customsListeners.add(listener);
  return () => {
    customsListeners.delete(listener);
  };
}

function customsSnapshot(): WebPanelDef[] {
  hydrateCustoms();
  return customs;
}

/**
 * Core dock API — everything a dock host needs, whatever fills the registry.
 *
 * Site management is optional and only present on the Files dock: a dock
 * whose panels come from elsewhere (the shortcut-bar overlay) has no add or
 * remove affordances, and the component keys its UI off these being defined.
 */
export interface WebPanelDockApi {
  /** Every site the dock can host. */
  panels: WebPanelDef[];
  /** Open tabs, in order. */
  instances: PanelSnapshot["instances"];
  activeInstanceId: string | null;
  open: (panelId: string) => OpenResult;
  focusOrOpen: (panelId: string) => OpenResult;
  close: (instanceId: string) => void;
  activate: (instanceId: string) => void;
  addSite?: (input: {
    url: string;
    label?: string;
  }) => { ok: true } | { ok: false; reason: string };
  removeSite?: (panelId: string) => void;
}

/** The Files dock's extension: the user can add and remove sites. */
export interface WebPanelDockSites {
  addSite: (input: {
    url: string;
    label?: string;
  }) => { ok: true } | { ok: false; reason: string };
  removeSite: (panelId: string) => void;
}

/** What {@link useWebPanelDock} returns: the Files dock, sites included. */
export type WebPanelDock = WebPanelDockApi & WebPanelDockSites;

export function useWebPanelDock(): WebPanelDock {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const custom = useSyncExternalStore(
    subscribeCustoms,
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
  // Render-time registry sync. Skipped while the derived registry is EMPTY:
  // that is the unconfigured/setup state, not proof that every site was
  // removed, and pruning against it would destroy the tabs a configured dock
  // would restore. The mutation paths sync unconditionally.
  if (panels.length > 0) {
    store.setPanels(panels);
  }

  const open = useCallback((panelId: string) => {
    store.setPanels(currentRegistry());
    return store.open(panelId);
  }, []);

  const focus = useCallback((panelId: string) => {
    store.setPanels(currentRegistry());
    return store.focusOrOpen(panelId);
  }, []);

  const close = useCallback((instanceId: string) => {
    store.close(instanceId);
  }, []);

  const activate = useCallback((instanceId: string) => {
    store.activate(instanceId);
  }, []);

  const addSite = useCallback((input: { url: string; label?: string }) => {
    const result = addCustomPanel(customsSnapshot(), input);
    if (!result.ok) {
      return { ok: false as const, reason: result.reason };
    }
    setCustoms(result.panels);
    return { ok: true as const };
  }, []);

  const removeSite = useCallback((panelId: string) => {
    setCustoms(removeCustomPanel(customsSnapshot(), panelId));
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

/** Test seam: forget everything the module stores hold. */
export function resetWebPanelStoreForTests(): void {
  customs = [];
  customsHydrated = false;
  customsListeners.clear();
  store.resetForTests();
}
