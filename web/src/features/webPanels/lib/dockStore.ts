/**
 * A dock store factory: tabbed panel sessions scoped to a named context.
 *
 * The Files dock was the only consumer of the module-level store in
 * `../hooks.ts`; the shortcut-bar overlay needs a SECOND dock whose tabs are
 * a different registry and persist per channel rather than for the whole
 * browser. The reducers are all in `panelSession.ts` and are untouched —
 * this file is only where the sessions live, how they are keyed, and the
 * subscription plumbing.
 *
 * Sessions persist per SCOPE as `{version: 1, byScope: {<scope>: session}}`
 * under the caller's storage key. A file written by the previous flat
 * (single-session) format is still read: it is adopted as the Files scope's
 * session, so the Files dock's existing persisted tabs survive the format
 * change. New writes are always the scoped shape.
 */

import type { WebPanelDef } from "./panelRegistry.ts";
import {
  EMPTY_PANEL_SNAPSHOT,
  MAX_PANEL_INSTANCES,
  activateInstance,
  closeInstance,
  focusOrOpen,
  nextSequenceAfter,
  openInstance,
  type OpenResult,
  type PanelInstance,
  type PanelSnapshot,
  pruneUnknownPanels,
} from "./panelSession.ts";

/** The Files dock's scope — the only scope that store ever uses. */
export const FILES_DOCK_SCOPE = "files";

export interface DockStore {
  subscribe(listener: () => void): () => void;
  /** The current scope's open tabs. Cached object; changes only on mutation. */
  getSnapshot(): PanelSnapshot;
  getPanels(): WebPanelDef[];
  /**
   * Replace the registry this store opens tabs against, pruning any tab
   * whose panel is now unknown. Callers sync this during render; it is an
   * idempotent write and only notifies when the SESSION actually changed.
   */
  setPanels(panels: readonly WebPanelDef[]): void;
  open(panelId: string): OpenResult;
  focusOrOpen(panelId: string): OpenResult;
  close(instanceId: string): void;
  activate(instanceId: string): void;
  /**
   * Switch the session scope. Intended for mount/render time: the component
   * that owns the store calls it before any subscriber reads, so the emit
   * here is always a no-op in practice.
   */
  setScope(scope: string): void;
  getScope(): string;
  /** Test seam: forget everything, including persisted sessions. */
  resetForTests(): void;
}

interface StoredSession {
  instances: PanelInstance[];
  activeInstanceId: string | null;
  nextSeq: number;
}

interface ScopedSessionFile {
  version: 1;
  byScope: Record<string, StoredSession>;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Restore one stored session, dropping anything unusable rather than
 * throwing. Panel ids are NOT filtered against the registry here: at restore
 * time the caller's registry may not be set yet, and `setPanels` is what
 * prunes against it — pruning an empty registry would destroy a session the
 * caller cannot even see yet.
 */
function restoreSession(raw: unknown): PanelSnapshot | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Partial<StoredSession>;
  if (!Array.isArray(candidate.instances)) {
    return null;
  }
  const instances: PanelInstance[] = [];
  const seen = new Set<string>();
  for (const entry of candidate.instances) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { instanceId, panelId } = entry as Partial<PanelInstance>;
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      continue;
    }
    if (typeof panelId !== "string" || panelId.length === 0) {
      continue;
    }
    if (seen.has(instanceId)) {
      continue;
    }
    seen.add(instanceId);
    instances.push({ instanceId, panelId });
    if (instances.length === MAX_PANEL_INSTANCES) {
      break;
    }
  }
  if (instances.length === 0) {
    return null;
  }
  return {
    instances,
    activeInstanceId: instances.some(
      (instance) => instance.instanceId === candidate.activeInstanceId,
    )
      ? (candidate.activeInstanceId as string)
      : instances[instances.length - 1].instanceId,
    nextSeq: Math.max(
      typeof candidate.nextSeq === "number" &&
        Number.isFinite(candidate.nextSeq)
        ? Math.floor(candidate.nextSeq)
        : 1,
      nextSequenceAfter(instances),
    ),
  };
}

/** Accept both the scoped map and the legacy flat single-session file. */
function parseSessions(raw: string | null): Record<string, StoredSession> {
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const candidate = parsed as Partial<ScopedSessionFile> & {
    instances?: unknown;
  };
  if (
    candidate.version === 1 &&
    typeof candidate.byScope === "object" &&
    candidate.byScope !== null
  ) {
    return candidate.byScope;
  }
  // Legacy flat shape (the pre-scope file panelSession.ts used to write):
  // adopt it as the Files scope's session so an upgrade does not drop tabs.
  if (Array.isArray(candidate.instances)) {
    return { [FILES_DOCK_SCOPE]: candidate as StoredSession };
  }
  return {};
}

export function createDockStore(options: {
  storageKey: string;
  /** Initial scope. Defaults to `"default"`; the Files store pins
   * `FILES_DOCK_SCOPE` explicitly. */
  initialScope?: string;
}): DockStore {
  const { storageKey } = options;
  let scope = options.initialScope ?? "default";
  let panels: WebPanelDef[] = [];
  let sessions: Record<string, StoredSession> = {};
  let session: PanelSnapshot = EMPTY_PANEL_SNAPSHOT;
  let hydrated = false;
  const listeners = new Set<() => void>();

  function emit() {
    for (const listener of listeners) {
      listener();
    }
  }

  function hydrate() {
    if (hydrated) {
      return;
    }
    hydrated = true;
    let raw: string | null = null;
    try {
      raw = storage()?.getItem(storageKey) ?? null;
    } catch {
      raw = null;
    }
    sessions = parseSessions(raw);
    session = restoreSession(sessions[scope]) ?? EMPTY_PANEL_SNAPSHOT;
  }

  function persist() {
    const target = storage();
    if (!target) {
      return;
    }
    try {
      const byScope: Record<string, StoredSession> = {};
      for (const [key, snapshot] of Object.entries(sessions)) {
        if (snapshot.instances.length > 0) {
          byScope[key] = snapshot;
        }
      }
      if (Object.keys(byScope).length === 0) {
        target.removeItem(storageKey);
        return;
      }
      target.setItem(storageKey, JSON.stringify({ version: 1, byScope }));
    } catch {
      // Quota or private mode: the dock still works for this session.
    }
  }

  function setSession(next: PanelSnapshot) {
    if (next === session) {
      return;
    }
    session = next;
    sessions[scope] = {
      instances: next.instances.map(({ instanceId, panelId }) => ({
        instanceId,
        panelId,
      })),
      activeInstanceId: next.activeInstanceId,
      nextSeq: next.nextSeq,
    };
    persist();
    emit();
  }

  function knownIds(): Set<string> {
    return new Set(panels.map((panel) => panel.id));
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      hydrate();
      return session;
    },
    getPanels() {
      return panels;
    },
    setPanels(next) {
      panels = [...next];
      if (panels.length === 0) {
        // An empty registry usually means the caller has no data YET (the
        // Files setup screen renders before any URL is configured), not
        // that every site was removed — pruning against it would destroy a
        // session nobody can see. Callers that really emptied their
        // registry prune through their mutation paths instead.
        return;
      }
      const pruned = pruneUnknownPanels(session, knownIds());
      if (pruned !== session) {
        setSession(pruned);
      }
    },
    open(panelId) {
      hydrate();
      const result = openInstance(session, panelId, knownIds());
      if (result.ok) {
        setSession(result.snapshot);
      }
      return result;
    },
    focusOrOpen(panelId) {
      hydrate();
      const result = focusOrOpen(session, panelId, knownIds());
      if (result.ok) {
        setSession(result.snapshot);
      }
      return result;
    },
    close(instanceId) {
      hydrate();
      setSession(closeInstance(session, instanceId));
    },
    activate(instanceId) {
      hydrate();
      setSession(activateInstance(session, instanceId));
    },
    setScope(next) {
      if (next === scope) {
        return;
      }
      hydrate();
      scope = next;
      session = restoreSession(sessions[scope]) ?? EMPTY_PANEL_SNAPSHOT;
      emit();
    },
    getScope() {
      return scope;
    },
    resetForTests() {
      sessions = {};
      session = EMPTY_PANEL_SNAPSHOT;
      panels = [];
      scope = options.initialScope ?? "default";
      hydrated = false;
      listeners.clear();
      try {
        storage()?.removeItem(storageKey);
      } catch {
        // Nothing to forget.
      }
    },
  };
}
