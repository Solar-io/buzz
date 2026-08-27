import * as React from "react";

import { getWebPanel } from "./webPanelRegistry";

/**
 * Tabbed web panel dock state.
 *
 * A tab is a panel INSTANCE (`{panelId}-{seq}`) — multiple instances of the
 * same panel type are allowed. Only the active instance's webview/iframe is
 * visible; the others stay alive so switching tabs is instant and
 * state-preserving. Live instances are capped at MAX_PANEL_INSTANCES
 * because each native tab is a full WKWebView session.
 *
 * The dock coexists with the terminal panel exactly as v1 did: both are
 * independent bottom docks that stack (terminal above web panels); the
 * native child webview tracks its own placeholder rect, which excludes the
 * terminal dock's area by construction.
 *
 * SESSION RESTORE: the open tabs, their order, the active tab, per-tab dock
 * heights, and the dock mode persist to localStorage (debounced) and are
 * recreated on boot. This is worth doing because login sessions survive
 * restarts in the shared WKWebsiteDataStore cookie jar — a restored panel
 * comes back already authed.
 */

export type WebPanelMode = "closed" | "docked" | "maximized";

/** Cap on live panel instances (each native tab is a WKWebView session). */
export const MAX_PANEL_INSTANCES = 6;

export const DOCK_HEIGHT_MIN = 180;
export const DOCK_HEIGHT_DEFAULT = 320;
export const DOCK_HEIGHT_MAX_RATIO = 0.7;

const SESSION_STORAGE_KEY = "buzz-webpanel-session";
const SESSION_PERSIST_DEBOUNCE_MS = 300;

export type WebPanelInstance = {
  instanceId: string;
  panelId: string;
  /** This tab's dock height in logical px; null until first resized. */
  height: number | null;
};

type Snapshot = {
  mode: WebPanelMode;
  instances: readonly WebPanelInstance[];
  activeInstanceId: string | null;
};

export type OpenPanelResult =
  | { ok: true; instanceId: string }
  | { ok: false; reason: "cap" | "unknown-panel" };

const CLOSED_SNAPSHOT: Snapshot = {
  mode: "closed",
  instances: [],
  activeInstanceId: null,
};

let snapshot: Snapshot = CLOSED_SNAPSHOT;
let nextSeq = 1;
let restored = false;
let restoreDeferred = false;
let pagehideRegistered = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
  schedulePersist();
}

function isFiniteHeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function clampHeight(height: number): number {
  const limit =
    typeof window === "undefined"
      ? DOCK_HEIGHT_DEFAULT / DOCK_HEIGHT_MAX_RATIO
      : window.innerHeight * DOCK_HEIGHT_MAX_RATIO;
  return Math.max(DOCK_HEIGHT_MIN, Math.min(limit, height));
}

// ── Session persistence ────────────────────────────────────────────────

type PersistedInstance = {
  instanceId: string;
  panelId: string;
  height: number | null;
};

type PersistedSession = {
  version: 1;
  mode: "docked" | "maximized";
  instances: PersistedInstance[];
  activeInstanceId: string | null;
};

export function serializeWebPanelSession(
  state: Snapshot,
): PersistedSession | null {
  if (state.mode === "closed" || state.instances.length === 0) return null;
  return {
    version: 1,
    mode: state.mode === "maximized" ? "maximized" : "docked",
    instances: state.instances.map(({ instanceId, panelId, height }) => ({
      instanceId,
      panelId,
      height: isFiniteHeight(height) ? Math.round(height) : null,
    })),
    activeInstanceId: state.activeInstanceId,
  };
}

/**
 * Best-effort restore: never throws, drops anything invalid (corrupt JSON,
 * unknown panel types, over-cap overflow, dangling active id) rather than
 * blocking boot. Returns null when nothing usable remains.
 */
export function parseWebPanelSession(raw: string | null): Snapshot | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<PersistedSession>;
  if (candidate.version !== 1 || !Array.isArray(candidate.instances)) {
    return null;
  }
  const valid: WebPanelInstance[] = [];
  const seenIds = new Set<string>();
  for (const entry of candidate.instances) {
    if (typeof entry !== "object" || entry === null) continue;
    const { instanceId, panelId, height } = entry as Partial<PersistedInstance>;
    if (typeof instanceId !== "string" || instanceId.length === 0) continue;
    if (seenIds.has(instanceId)) continue;
    if (typeof panelId !== "string" || !getWebPanel(panelId)) continue;
    seenIds.add(instanceId);
    valid.push({
      instanceId,
      panelId,
      height: isFiniteHeight(height) ? Math.round(height) : null,
    });
    if (valid.length === MAX_PANEL_INSTANCES) break;
  }
  if (valid.length === 0) return null;
  const activeInstanceId = valid.some(
    (instance) => instance.instanceId === candidate.activeInstanceId,
  )
    ? (candidate.activeInstanceId as string)
    : // Dangling active id: fall back to the newest surviving tab, the
      // closest proxy for what was active when the session was dropped.
      valid[valid.length - 1].instanceId;
  return {
    mode: candidate.mode === "maximized" ? "maximized" : "docked",
    instances: valid,
    activeInstanceId,
  };
}

/** The sequence allocator must never reuse an id a restored session owns. */
export function nextSequenceAfter(
  instances: readonly WebPanelInstance[],
): number {
  let max = 0;
  for (const instance of instances) {
    const seq = Number.parseInt(instance.instanceId.split("-").pop() ?? "", 10);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max + 1;
}

function writeSession() {
  if (typeof window === "undefined") return;
  try {
    const payload = serializeWebPanelSession(snapshot);
    if (payload) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
    } else {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch {
    // Storage full or unavailable — the dock works without persistence.
  }
}

function schedulePersist() {
  if (typeof window === "undefined") return;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    writeSession();
  }, SESSION_PERSIST_DEBOUNCE_MS);
}

function readStoredSession(): string | null {
  try {
    return typeof window === "undefined"
      ? null
      : (window.localStorage.getItem(SESSION_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

/**
 * Boot-order gate: while deferred, store READS do not restore the persisted
 * session. WebPanelBootstrap defers restore until the custom panel registry
 * has resolved (or timed out), so a restored session can name owner-added
 * sites — otherwise their tabs would be dropped as unknown panel ids.
 */
export function deferWebPanelRestore(): void {
  if (!restored) {
    restoreDeferred = true;
  }
}

/** Release the gate and restore now (registry settled or timed out). */
export function triggerWebPanelRestore(): void {
  if (restored) return;
  restoreDeferred = false;
  ensureRestored();
}

function performRestore() {
  const restoredSnapshot = parseWebPanelSession(readStoredSession());
  if (restoredSnapshot) {
    snapshot = restoredSnapshot;
    nextSeq = nextSequenceAfter(restoredSnapshot.instances);
    for (const listener of listeners) listener();
  }
  if (typeof window !== "undefined" && !pagehideRegistered) {
    pagehideRegistered = true;
    // Flush a pending debounced write if the window is going away.
    window.addEventListener("pagehide", () => {
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      writeSession();
    });
  }
}

/** One-shot, lazy: the first store access restores the persisted session —
 *  unless the boot gate is holding it for the registry. */
function ensureRestored() {
  if (restored || restoreDeferred) return;
  restored = true;
  performRestore();
}

/**
 * User actions force the restore: proceeding against a CLOSED snapshot
 * while the gate holds would let the later gated restore clobber what the
 * user just opened. The window is milliseconds at boot; if an action does
 * land there, custom ids may not be loaded yet and their tabs drop.
 */
function ensureRestoredForAction() {
  restoreDeferred = false;
  ensureRestored();
}

// ── Actions ────────────────────────────────────────────────────────────

export function openWebPanelInstance(panelId: string): OpenPanelResult {
  ensureRestoredForAction();
  if (!getWebPanel(panelId)) return { ok: false, reason: "unknown-panel" };
  if (snapshot.instances.length >= MAX_PANEL_INSTANCES) {
    return { ok: false, reason: "cap" };
  }
  const instance: WebPanelInstance = {
    instanceId: `${panelId}-${nextSeq}`,
    panelId,
    height: null,
  };
  nextSeq += 1;
  publish({
    mode: snapshot.mode === "closed" ? "docked" : snapshot.mode,
    instances: [...snapshot.instances, instance],
    activeInstanceId: instance.instanceId,
  });
  return { ok: true, instanceId: instance.instanceId };
}

/** Close one tab; active falls to the neighbor, and the dock closes with
 *  its last tab. */
export function closeWebPanelInstance(instanceId: string): void {
  ensureRestoredForAction();
  const index = snapshot.instances.findIndex(
    (instance) => instance.instanceId === instanceId,
  );
  if (index === -1) return;
  const instances = snapshot.instances.filter(
    (instance) => instance.instanceId !== instanceId,
  );
  const activeInstanceId =
    snapshot.activeInstanceId === instanceId
      ? ((instances[index - 1] ?? instances[index] ?? null)?.instanceId ?? null)
      : snapshot.activeInstanceId;
  publish({
    mode: instances.length === 0 ? "closed" : snapshot.mode,
    instances,
    activeInstanceId: instances.length === 0 ? null : activeInstanceId,
  });
}

export function setActiveWebPanelInstance(instanceId: string): void {
  ensureRestoredForAction();
  if (snapshot.activeInstanceId === instanceId) return;
  if (!snapshot.instances.some((i) => i.instanceId === instanceId)) return;
  publish({ ...snapshot, activeInstanceId: instanceId });
}

export function setWebPanelInstanceHeight(
  instanceId: string,
  height: number,
): void {
  ensureRestoredForAction();
  if (!isFiniteHeight(height)) return;
  const index = snapshot.instances.findIndex(
    (instance) => instance.instanceId === instanceId,
  );
  if (index === -1) return;
  const rounded = Math.round(clampHeight(height));
  if (snapshot.instances[index].height === rounded) return;
  const instances = snapshot.instances.slice();
  instances[index] = { ...snapshot.instances[index], height: rounded };
  publish({ ...snapshot, instances });
}

/** Dock mode. Going to "closed" clears the tabs — the bootstrap destroys
 *  their webviews, keeping live WKWebView sessions bounded by the cap. */
export function setWebPanelMode(mode: WebPanelMode): void {
  ensureRestoredForAction();
  if (snapshot.mode === mode) return;
  if (mode === "closed") {
    publish(CLOSED_SNAPSHOT);
    return;
  }
  publish({ ...snapshot, mode });
}

/**
 * Header button semantics for a panel TYPE: toggle the active tab of that
 * type closed, activate an existing tab of that type, or open a new one.
 */
export function toggleWebPanel(panelId: string): OpenPanelResult | null {
  ensureRestoredForAction();
  const mine = snapshot.instances.filter((i) => i.panelId === panelId);
  const active = snapshot.instances.find(
    (instance) => instance.instanceId === snapshot.activeInstanceId,
  );
  if (mine.length > 0 && active?.panelId === panelId) {
    closeWebPanelInstance(active.instanceId);
    return null;
  }
  if (mine.length > 0) {
    setActiveWebPanelInstance(mine[mine.length - 1].instanceId);
    return null;
  }
  return openWebPanelInstance(panelId);
}

export function getActiveWebPanelInstance(): WebPanelInstance | null {
  ensureRestored();
  return (
    snapshot.instances.find(
      (instance) => instance.instanceId === snapshot.activeInstanceId,
    ) ?? null
  );
}

export function useWebPanel(): Snapshot {
  ensureRestored();
  return React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

export function resetWebPanelForTests(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  snapshot = CLOSED_SNAPSHOT;
  // Tests get the same fresh-run state production starts from; a restore
  // (or further opens) re-advances it from whatever the seeded session owns.
  nextSeq = 1;
  restored = false;
  restoreDeferred = false;
}

export function getWebPanelSnapshotForTests(): Snapshot {
  ensureRestored();
  return snapshot;
}

/** Test seam: force a restore pass against the current localStorage. */
export function restoreWebPanelSessionForTests(): void {
  restored = false;
  restoreDeferred = false;
  ensureRestored();
}

export function clampDockHeightForTests(height: number): number {
  return clampHeight(height);
}

export const WEBPANEL_SESSION_STORAGE_KEY = SESSION_STORAGE_KEY;
