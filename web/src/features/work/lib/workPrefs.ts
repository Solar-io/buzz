/**
 * Per-device Work preferences (phase-1 §2.3, §3). Every read and write is
 * wrapped: storage can be absent (private mode) or throw (blocked site data),
 * and the rail must render correctly with nothing stored.
 */

import type { WorkScope } from "./workTypes.ts";

const SCOPE_KEY = "buzz.work.scope.v1";
const COLLAPSED_KEY = "buzz.work.collapsed.v1";
const WIDTH_KEY = "buzz.work-width.v1";
const RAIL_COLLAPSED_KEY = "buzz.work.rail-collapsed.v1";

/** Work rail width (decision D1: its own width, separate from the thread's). */
export const WORK_WIDTH_DEFAULT = 380;
export const WORK_WIDTH_MIN = 320;
export const WORK_WIDTH_MAX = 520;
/** The collapsed strip. */
export const WORK_RAIL_COLLAPSED_WIDTH = 44;

export type WorkSection = "needs" | "running" | "queued" | "done";

/** Queued and Done start folded, as on the Main artboard. */
const DEFAULT_COLLAPSED: Readonly<Record<WorkSection, boolean>> = {
  needs: false,
  running: false,
  queued: true,
  done: true,
};

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Best-effort: the in-memory state still applies for this session.
  }
}

export function loadWorkScope(): WorkScope {
  return read(SCOPE_KEY) === "channel" ? "channel" : "everywhere";
}

export function saveWorkScope(scope: WorkScope): void {
  write(SCOPE_KEY, scope);
}

export function loadCollapsedSections(): Record<WorkSection, boolean> {
  const out = { ...DEFAULT_COLLAPSED };
  try {
    const parsed = JSON.parse(read(COLLAPSED_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(out) as WorkSection[]) {
      if (typeof parsed[key] === "boolean") {
        out[key] = parsed[key] as boolean;
      }
    }
  } catch {
    // Corrupt entry: defaults.
  }
  return out;
}

export function saveCollapsedSections(
  sections: Record<WorkSection, boolean>,
): void {
  write(COLLAPSED_KEY, JSON.stringify(sections));
}

export function clampWorkWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return WORK_WIDTH_DEFAULT;
  }
  return Math.min(WORK_WIDTH_MAX, Math.max(WORK_WIDTH_MIN, Math.round(width)));
}

export function loadWorkWidth(): number {
  const stored = Number.parseFloat(read(WIDTH_KEY) ?? "");
  return Number.isFinite(stored) ? clampWorkWidth(stored) : WORK_WIDTH_DEFAULT;
}

export function saveWorkWidth(width: number): void {
  write(WIDTH_KEY, String(clampWorkWidth(width)));
}

export function loadRailCollapsed(): boolean {
  return read(RAIL_COLLAPSED_KEY) === "1";
}

export function saveRailCollapsed(collapsed: boolean): void {
  write(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
}

const RIGHT_TAB_KEY = "buzz.work.right-tab.v1";
type StoredTab = "work" | "thread" | "activity";

/** The right pane's last chosen tab (a missing tab resolves to Work). */
export function loadRightTab(): StoredTab {
  const value = read(RIGHT_TAB_KEY);
  return value === "thread" || value === "activity" ? value : "work";
}

export function saveRightTab(tab: StoredTab): void {
  write(RIGHT_TAB_KEY, tab);
}
