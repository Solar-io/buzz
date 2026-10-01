/**
 * The crichton host-stats poller (phase-7.md §8 "Vitals rows", W-3): one
 * shared poll for every mounted consumer (sidebar block, phone strip,
 * popover). Every 10 s while subscribed and the tab is VISIBLE; a hidden tab
 * makes no requests at all, and becoming visible refreshes at once.
 *
 * Built over injected deps so the cadence and the pause are tested against
 * the shipping logic, not a copy of it.
 */

import type {
  HatchResult,
  HostStats,
} from "@/features/terminal/lib/hatchClient.ts";

export const HOST_STATS_INTERVAL_MS = 10_000;
/** Samples kept for the popover's sparklines (~2 min at 10 s). */
export const HISTORY_SIZE = 14;

export interface HostSample {
  cpu: number | null;
  gpu: number | null;
  mem: number | null;
}

export interface HostStatsSnapshot {
  status: "idle" | "ok" | "offline" | "signed-out" | "forbidden";
  /** The last good sample; null whenever the last poll failed. */
  stats: HostStats | null;
  history: HostSample[];
}

export interface PollerDeps {
  fetch(): Promise<HatchResult<HostStats>>;
  isHidden(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  intervalMs?: number;
}

export interface HostStatsPoller {
  subscribe(listener: () => void): () => void;
  getSnapshot(): HostStatsSnapshot;
  refresh(): void;
}

export const IDLE_SNAPSHOT: HostStatsSnapshot = {
  status: "idle",
  stats: null,
  history: [],
};

export function createHostStatsPoller(deps: PollerDeps): HostStatsPoller {
  const interval = deps.intervalMs ?? HOST_STATS_INTERVAL_MS;
  let snapshot = IDLE_SNAPSHOT;
  const listeners = new Set<() => void>();
  let timer: unknown = null;
  let stopVisibility: (() => void) | null = null;
  let generation = 0;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const refresh = () => {
    if (deps.isHidden()) return;
    const mine = ++generation;
    void deps.fetch().then((result) => {
      if (mine !== generation || listeners.size === 0) return;
      if (result.kind === "ok") {
        const sample: HostSample = {
          cpu: result.data.cpu,
          gpu: result.data.gpu.percent,
          mem: result.data.mem?.percent ?? null,
        };
        snapshot = {
          status: "ok",
          stats: result.data,
          history: [...snapshot.history, sample].slice(-HISTORY_SIZE),
        };
      } else {
        // Never leave the last numbers up as if they were current.
        snapshot = {
          status: result.kind === "unreachable" ? "offline" : result.kind,
          stats: null,
          history: snapshot.history,
        };
      }
      emit();
    });
  };

  const start = () => {
    if (timer === null) timer = deps.setInterval(refresh, interval);
  };
  const stop = () => {
    if (timer !== null) deps.clearInterval(timer);
    timer = null;
  };

  const onVisibility = () => {
    if (deps.isHidden()) {
      stop();
    } else {
      refresh();
      start();
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        stopVisibility = deps.onVisibilityChange(onVisibility);
        if (!deps.isHidden()) {
          refresh();
          start();
        }
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop();
          stopVisibility?.();
          stopVisibility = null;
          generation++;
        }
      };
    },
    getSnapshot: () => snapshot,
    refresh,
  };
}
