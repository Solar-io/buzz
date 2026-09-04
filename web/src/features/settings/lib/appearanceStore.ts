/**
 * Appearance preferences — the live half.
 *
 * One store factory over the specs in `appearancePrefs.ts`, plus a hook per
 * preference. The desktop client writes this out four times; the only thing
 * that differs between its copies is the value type, so here it is written
 * once and instantiated four times.
 *
 * Every store does the same four things:
 *
 *  - reads the persisted value (defensively — `localStorage` throws outright
 *    in a private window, and a preference is never worth an error boundary);
 *  - mirrors it onto a `<html>` attribute, which is what the CSS in
 *    `shared/styles/globals.css` actually selects on;
 *  - notifies React via `useSyncExternalStore`, so a control anywhere in the
 *    tree updates every consumer without a provider;
 *  - follows the `storage` event, so a second tab on the same origin does not
 *    keep rendering the old preference.
 *
 * There is deliberately no `preview` here, unlike the desktop's stores. See
 * `ui/SegmentedControl.tsx` for why a hover preview is the wrong shape in a
 * browser: it reflows the page under the pointer.
 */

import { useSyncExternalStore } from "react";

import {
  APPEARANCE_PREFERENCES,
  CONVERSATION_DENSITY_PREFERENCE,
  FONT_SIZE_PREFERENCE,
  LINK_PREVIEW_STYLE_PREFERENCE,
  PROMINENT_ACTIVE_TAB_PREFERENCE,
  THREAD_LAYOUT_PREFERENCE,
  parsePreference,
  type ConversationDensity,
  type FontSize,
  type LinkPreviewStyle,
  type PreferenceSpec,
  type ProminentActiveTab,
  type ThreadLayout,
} from "./appearancePrefs.ts";

export interface PreferenceStore<Value extends string> {
  get(): Value;
  set(value: Value): void;
  subscribe(listener: () => void): () => void;
  /** Apply the persisted value to the DOM and start following other tabs. */
  initialize(): void;
}

function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Persistence is best-effort; the live preference still applies.
  }
}

function createPreferenceStore<Value extends string>(
  spec: PreferenceSpec<Value>,
): PreferenceStore<Value> {
  const listeners = new Set<() => void>();
  let current: Value = spec.defaultValue;
  let following = false;

  const apply = (value: Value): void => {
    globalThis.document?.documentElement?.setAttribute(spec.attribute, value);
  };

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const adopt = (): void => {
    const next = parsePreference(spec, readStored(spec.storageKey));
    const changed = next !== current;
    current = next;
    apply(next);
    if (changed) notify();
  };

  return {
    get: () => current,
    set: (value) => {
      current = value;
      apply(value);
      writeStored(spec.storageKey, value);
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    initialize: () => {
      adopt();
      if (following || !globalThis.window?.addEventListener) return;
      // `key === null` is a `localStorage.clear()` from another tab.
      globalThis.window.addEventListener("storage", (event) => {
        if (event.key === spec.storageKey || event.key === null) adopt();
      });
      following = true;
    },
  };
}

export const fontSizeStore = createPreferenceStore(FONT_SIZE_PREFERENCE);
export const conversationDensityStore = createPreferenceStore(
  CONVERSATION_DENSITY_PREFERENCE,
);
export const linkPreviewStyleStore = createPreferenceStore(
  LINK_PREVIEW_STYLE_PREFERENCE,
);
export const threadLayoutStore = createPreferenceStore(
  THREAD_LAYOUT_PREFERENCE,
);
export const prominentActiveTabStore = createPreferenceStore(
  PROMINENT_ACTIVE_TAB_PREFERENCE,
);

const STORES = {
  "data-font-size": fontSizeStore,
  "data-conversation-density": conversationDensityStore,
  "data-link-preview-style": linkPreviewStyleStore,
  "data-thread-layout": threadLayoutStore,
  "data-prominent-active-tab": prominentActiveTabStore,
} as const;

/**
 * Apply every persisted appearance preference before React renders.
 *
 * Called from `main.tsx`. Without it the app paints one frame at the default
 * type scale and spacing and then snaps — the same first-paint problem the
 * theme cache solves for colours.
 *
 * The loop is driven by `APPEARANCE_PREFERENCES` rather than by a hand-written
 * list of four calls, so a fifth preference cannot be added and silently left
 * uninitialized.
 */
export function initializeAppearancePreferences(): void {
  for (const spec of APPEARANCE_PREFERENCES) {
    STORES[spec.attribute as keyof typeof STORES].initialize();
  }
}

function usePreference<Value extends string>(
  store: PreferenceStore<Value>,
  fallback: Value,
): Value {
  return useSyncExternalStore(store.subscribe, store.get, () => fallback);
}

export function useFontSize(): FontSize {
  return usePreference(fontSizeStore, FONT_SIZE_PREFERENCE.defaultValue);
}

export function useConversationDensity(): ConversationDensity {
  return usePreference(
    conversationDensityStore,
    CONVERSATION_DENSITY_PREFERENCE.defaultValue,
  );
}

export function useLinkPreviewStyle(): LinkPreviewStyle {
  return usePreference(
    linkPreviewStyleStore,
    LINK_PREVIEW_STYLE_PREFERENCE.defaultValue,
  );
}

export function useThreadLayout(): ThreadLayout {
  return usePreference(
    threadLayoutStore,
    THREAD_LAYOUT_PREFERENCE.defaultValue,
  );
}

/**
 * The prominent-active-tab preference as the boolean a `Switch` wants.
 *
 * The store stays string-valued (that is what reaches the DOM attribute the
 * stylesheet matches on); only this seam translates, and it translates in one
 * place so "true" can never be compared against `true` somewhere else.
 */
export function useProminentActiveTab(): boolean {
  return (
    usePreference(
      prominentActiveTabStore,
      PROMINENT_ACTIVE_TAB_PREFERENCE.defaultValue,
    ) === "true"
  );
}

/** Set the prominent-active-tab preference from a boolean control. */
export function setProminentActiveTab(enabled: boolean): void {
  prominentActiveTabStore.set(
    (enabled ? "true" : "false") satisfies ProminentActiveTab,
  );
}
