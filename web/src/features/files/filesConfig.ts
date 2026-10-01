/**
 * File-manager URL resolution: a per-browser override (localStorage) wins
 * over the build-time default (VITE_FILES_PANEL_URL). The unconfigured Files
 * panel prompts for the URL inline — no rebuild needed.
 *
 * The override lives under a versioned key. The first key (`buzz:files-url`)
 * was written by the inline first-run prompt back when there was no build
 * default, so every browser that ever opened Files holds one — and because an
 * override wins, a value saved for a file manager that has since moved kept
 * shadowing the baked default forever. That is how the deployed Files panel
 * kept loading the retired :6201 file manager (a 502) in Sam's browser after
 * the build had moved on to stash. So a legacy value is honoured only while
 * there is no build default to replace it; once one exists, the legacy value
 * is dropped. Overrides saved from Settings now go to the v2 key and keep
 * winning, as before.
 */

import { FILES_PANEL_URL } from "./webPanels";

/** Current override key. Exported for tests. */
export const FILES_URL_STORAGE_KEY = "buzz:files-url.v2";
/** Pre-default-era key; see the module comment. Exported for tests. */
export const LEGACY_FILES_URL_STORAGE_KEY = "buzz:files-url";

/** The slice of `Storage` this module needs. */
export interface FilesUrlStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): FilesUrlStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Private mode etc. — fall through to the build default.
    return null;
  }
}

/**
 * Pure resolution against an injected storage, so `node --test` can drive it.
 * May migrate storage: a legacy value moves to the v2 key when there is no
 * build default, and is removed when there is one.
 */
export function resolveFilesUrl(
  storage: FilesUrlStorage | null,
  buildDefault: string,
): string {
  const fallback = buildDefault.trim();
  if (!storage) {
    return fallback;
  }
  try {
    const stored = storage.getItem(FILES_URL_STORAGE_KEY);
    if (stored !== null) {
      return stored.trim();
    }
    const legacy = storage.getItem(LEGACY_FILES_URL_STORAGE_KEY);
    if (legacy === null) {
      return fallback;
    }
    storage.removeItem(LEGACY_FILES_URL_STORAGE_KEY);
    if (fallback) {
      return fallback;
    }
    const kept = legacy.trim();
    if (kept) {
      storage.setItem(FILES_URL_STORAGE_KEY, kept);
    }
    return kept;
  } catch {
    return fallback;
  }
}

/** Pure write against an injected storage; null or blank clears the override. */
export function writeFilesUrl(
  storage: FilesUrlStorage | null,
  url: string | null,
): void {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(LEGACY_FILES_URL_STORAGE_KEY);
    if (url === null || url.trim() === "") {
      storage.removeItem(FILES_URL_STORAGE_KEY);
    } else {
      storage.setItem(FILES_URL_STORAGE_KEY, url.trim());
    }
  } catch {
    // Best-effort; the build default still applies.
  }
}

export function getConfiguredFilesUrl(): string {
  return resolveFilesUrl(browserStorage(), FILES_PANEL_URL);
}

export function setConfiguredFilesUrl(url: string | null): void {
  writeFilesUrl(browserStorage(), url);
}
