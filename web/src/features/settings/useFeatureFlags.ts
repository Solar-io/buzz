/**
 * Preview-gate state, persisted in localStorage and shared across components.
 *
 * A module-level store rather than context because gates are read from
 * scattered places (a settings card, a sidebar entry, a dialog) and threading
 * a provider through all of them buys nothing — the value is a small record
 * that changes only when someone flips a switch.
 */

import { useCallback, useSyncExternalStore } from "react";

import {
  parseFeatureState,
  resolveEnabled,
  withFeature,
  type FeatureState,
} from "./lib/featureFlags.ts";

const STORAGE_KEY = "buzz.feature-flags.v1";

function read(): FeatureState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? parseFeatureState(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

let state: FeatureState = read();
const listeners = new Set<() => void>();

function snapshot(): FeatureState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setFeature(id: string, enabled: boolean): void {
  state = withFeature(state, id, enabled);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Session-only is an acceptable degradation.
  }
  for (const listener of listeners) listener();
}

export function useFeatureState(): FeatureState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Whether one gate is on. Unknown ids fail open — see `featureFlags.ts`. */
export function useFeatureEnabled(id: string): boolean {
  const current = useFeatureState();
  return resolveEnabled(id, current);
}

/** `[enabled, toggle]`, matching the desktop's `useFeatureToggle`. */
export function useFeatureToggle(
  id: string,
): [boolean, (next: boolean) => void] {
  const enabled = useFeatureEnabled(id);
  const toggle = useCallback((next: boolean) => setFeature(id, next), [id]);
  return [enabled, toggle];
}
