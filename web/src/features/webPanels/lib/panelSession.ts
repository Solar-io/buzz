/**
 * Tabbed panel state, as pure reducers.
 *
 * A tab is a panel **instance** (`<panelId>#<seq>`), so the same site can be
 * open twice — two file-manager tabs in two directories is the case that makes
 * a dock worth having over a single swappable frame. Every open instance stays
 * mounted; only the active one is visible, which is what preserves scroll
 * position, form state, and any session the embedded site holds. That is the
 * whole reason this is not just "one iframe whose src changes".
 *
 * Instances are capped: each one is a live iframe with its own network,
 * memory, and (for a logged-in site) session.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

/** Live tabs allowed at once — each is a full iframe. */
export const MAX_PANEL_INSTANCES = 6;

export interface PanelInstance {
  instanceId: string;
  panelId: string;
}

export interface PanelSnapshot {
  instances: PanelInstance[];
  activeInstanceId: string | null;
  /** Sequence allocator; persisted so a restore cannot reuse a live id. */
  nextSeq: number;
}

export const EMPTY_PANEL_SNAPSHOT: PanelSnapshot = {
  instances: [],
  activeInstanceId: null,
  nextSeq: 1,
};

export type OpenResult =
  | { ok: true; snapshot: PanelSnapshot; instanceId: string }
  | { ok: false; reason: "cap" | "unknown-panel" };

/** Open a new tab for `panelId`, if the registry knows it and there is room. */
export function openInstance(
  snapshot: PanelSnapshot,
  panelId: string,
  knownPanelIds: ReadonlySet<string>,
): OpenResult {
  if (!knownPanelIds.has(panelId)) {
    return { ok: false, reason: "unknown-panel" };
  }
  if (snapshot.instances.length >= MAX_PANEL_INSTANCES) {
    return { ok: false, reason: "cap" };
  }
  const instanceId = `${panelId}#${snapshot.nextSeq}`;
  return {
    ok: true,
    instanceId,
    snapshot: {
      instances: [...snapshot.instances, { instanceId, panelId }],
      activeInstanceId: instanceId,
      nextSeq: snapshot.nextSeq + 1,
    },
  };
}

/**
 * Close one tab.
 *
 * The active tab falls to its **left** neighbour, or to the new tab at the
 * same index when it was leftmost — the browser-tab convention, and the one
 * that keeps the user's eye where it already was.
 */
export function closeInstance(
  snapshot: PanelSnapshot,
  instanceId: string,
): PanelSnapshot {
  const index = snapshot.instances.findIndex(
    (instance) => instance.instanceId === instanceId,
  );
  if (index === -1) {
    return snapshot;
  }
  const instances = snapshot.instances.filter(
    (instance) => instance.instanceId !== instanceId,
  );
  if (instances.length === 0) {
    return { instances, activeInstanceId: null, nextSeq: snapshot.nextSeq };
  }
  const activeInstanceId =
    snapshot.activeInstanceId === instanceId
      ? (instances[index - 1] ?? instances[index]).instanceId
      : snapshot.activeInstanceId;
  return { instances, activeInstanceId, nextSeq: snapshot.nextSeq };
}

export function activateInstance(
  snapshot: PanelSnapshot,
  instanceId: string,
): PanelSnapshot {
  if (
    snapshot.activeInstanceId === instanceId ||
    !snapshot.instances.some((instance) => instance.instanceId === instanceId)
  ) {
    return snapshot;
  }
  return { ...snapshot, activeInstanceId: instanceId };
}

/**
 * Header-button semantics for a panel TYPE: focus an existing tab of that
 * type, or open one. Unlike the desktop's `toggleWebPanel` this never *closes*
 * on a second press — the dock here fills the content area rather than sharing
 * the window, so a button that sometimes closes the thing you are looking at
 * is a trap rather than a toggle.
 */
export function focusOrOpen(
  snapshot: PanelSnapshot,
  panelId: string,
  knownPanelIds: ReadonlySet<string>,
): OpenResult {
  const existing = snapshot.instances.filter(
    (instance) => instance.panelId === panelId,
  );
  const last = existing[existing.length - 1];
  if (last) {
    return {
      ok: true,
      instanceId: last.instanceId,
      snapshot: activateInstance(snapshot, last.instanceId),
    };
  }
  return openInstance(snapshot, panelId, knownPanelIds);
}

/** Drop every tab whose panel the registry no longer knows (a removed site). */
export function pruneUnknownPanels(
  snapshot: PanelSnapshot,
  knownPanelIds: ReadonlySet<string>,
): PanelSnapshot {
  const instances = snapshot.instances.filter((instance) =>
    knownPanelIds.has(instance.panelId),
  );
  if (instances.length === snapshot.instances.length) {
    return snapshot;
  }
  const activeStillOpen = instances.some(
    (instance) => instance.instanceId === snapshot.activeInstanceId,
  );
  return {
    instances,
    activeInstanceId: activeStillOpen
      ? snapshot.activeInstanceId
      : (instances[instances.length - 1]?.instanceId ?? null),
    nextSeq: snapshot.nextSeq,
  };
}

export const PANEL_SESSION_STORAGE_KEY = "buzz:web-panel-session.v1";

export interface PanelSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PersistedSession {
  version: 1;
  instances: PanelInstance[];
  activeInstanceId: string | null;
  nextSeq: number;
}

export function serializePanelSession(
  snapshot: PanelSnapshot,
): PersistedSession | null {
  if (snapshot.instances.length === 0) {
    return null;
  }
  return {
    version: 1,
    instances: snapshot.instances.map(({ instanceId, panelId }) => ({
      instanceId,
      panelId,
    })),
    activeInstanceId: snapshot.activeInstanceId,
    nextSeq: snapshot.nextSeq,
  };
}

/**
 * Restore, dropping anything unusable rather than throwing.
 *
 * `nextSeq` is recomputed from the restored ids as well as read, because a
 * persisted allocator that lags behind its own instances would mint a
 * duplicate `instanceId` on the next open — and React would then key two live
 * iframes identically.
 */
export function parsePanelSession(
  raw: string | null,
  knownPanelIds: ReadonlySet<string>,
): PanelSnapshot | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as Partial<PersistedSession>;
  if (candidate.version !== 1 || !Array.isArray(candidate.instances)) {
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
    if (typeof panelId !== "string" || !knownPanelIds.has(panelId)) {
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
  const activeInstanceId = instances.some(
    (instance) => instance.instanceId === candidate.activeInstanceId,
  )
    ? (candidate.activeInstanceId as string)
    : instances[instances.length - 1].instanceId;
  return {
    instances,
    activeInstanceId,
    nextSeq: Math.max(
      typeof candidate.nextSeq === "number" &&
        Number.isFinite(candidate.nextSeq)
        ? Math.floor(candidate.nextSeq)
        : 1,
      nextSequenceAfter(instances),
    ),
  };
}

/** One past the highest sequence any restored instance id holds. */
export function nextSequenceAfter(instances: readonly PanelInstance[]): number {
  let highest = 0;
  for (const instance of instances) {
    const seq = Number.parseInt(instance.instanceId.split("#").pop() ?? "", 10);
    if (Number.isFinite(seq) && seq > highest) {
      highest = seq;
    }
  }
  return highest + 1;
}

export function readPanelSession(
  storage: PanelSessionStorage | null | undefined,
  knownPanelIds: ReadonlySet<string>,
): PanelSnapshot | null {
  if (!storage) {
    return null;
  }
  try {
    return parsePanelSession(
      storage.getItem(PANEL_SESSION_STORAGE_KEY),
      knownPanelIds,
    );
  } catch {
    return null;
  }
}

export function writePanelSession(
  storage: PanelSessionStorage | null | undefined,
  snapshot: PanelSnapshot,
): void {
  if (!storage) {
    return;
  }
  try {
    const payload = serializePanelSession(snapshot);
    if (payload === null) {
      storage.removeItem(PANEL_SESSION_STORAGE_KEY);
      return;
    }
    storage.setItem(PANEL_SESSION_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // The dock works without persistence.
  }
}
