/**
 * File-manager URL resolution: a per-browser override (localStorage) wins
 * over the build-time default (VITE_FILES_PANEL_URL). The unconfigured Files
 * panel prompts for the URL inline — no rebuild needed.
 */

import { FILES_PANEL_URL } from "./webPanels";

const STORAGE_KEY = "buzz:files-url";

export function getConfiguredFilesUrl(): string {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (stored !== null) {
      return stored.trim();
    }
  } catch {
    // Private mode etc. — fall through to the build default.
  }
  return FILES_PANEL_URL;
}

export function setConfiguredFilesUrl(url: string | null): void {
  try {
    if (url === null || url.trim() === "") {
      globalThis.localStorage?.removeItem(STORAGE_KEY);
    } else {
      globalThis.localStorage?.setItem(STORAGE_KEY, url.trim());
    }
  } catch {
    // Best-effort; the build default still applies.
  }
}
