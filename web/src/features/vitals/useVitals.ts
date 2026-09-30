import { useSyncExternalStore } from "react";

import {
  fetchPace,
  type Pace,
  USAGE_HUB_URL,
} from "@/features/usage/lib/usageHub.ts";
import { parseRunway, type Runway } from "./lib/vitalsMath.ts";

const REFRESH_MS = 5 * 60_000;
const TIMEOUT_MS = 8_000;
export const RUNWAY_URL = `${USAGE_HUB_URL}/v1/runway`;

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(TIMEOUT_MS)
    : undefined;
}

/** Plain simple GET, like fetchPace: no headers, never preflights, never throws. */
async function fetchRunway(signal?: AbortSignal): Promise<Runway | null> {
  try {
    const response = await fetch(RUNWAY_URL, { signal });
    return response.ok ? parseRunway(await response.json()) : null;
  } catch {
    return null;
  }
}

export interface VitalsSnapshot {
  /** Null until the first success, and whenever the hub is unreachable. */
  pace: Pace | null;
  runway: Runway | null;
  /** The first fetch has settled (success or not). */
  settled: boolean;
}

/*
 * One poller shared by every mounted consumer (the sidebar block, the phone
 * strip, the popover): the first subscriber starts it, the last stops it.
 * A failed refresh shows "usage unavailable" — yesterday's percentage on
 * screen as if it were now is the one thing this must never do.
 */
let snapshot: VitalsSnapshot = { pace: null, runway: null, settled: false };
const listeners = new Set<() => void>();
let timer: number | null = null;
let generation = 0;

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function refreshVitals(): void {
  const mine = ++generation;
  void Promise.all([
    fetchPace(timeoutSignal()),
    fetchRunway(timeoutSignal()),
  ]).then(([pace, runway]) => {
    if (mine !== generation) {
      return;
    }
    snapshot = { pace, runway, settled: true };
    emit();
  });
}

function onVisible() {
  if (document.visibilityState === "visible") {
    refreshVitals();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    refreshVitals();
    timer = window.setInterval(refreshVitals, REFRESH_MS);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

const getSnapshot = () => snapshot;

export function useVitals(): VitalsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
