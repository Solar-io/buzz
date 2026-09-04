/**
 * Where channel templates live in a browser.
 *
 * The desktop keeps them in a JSON file under its app-data directory. A tab
 * has no such directory, so the same records go into IndexedDB via
 * `idb-keyval` — the store the identity key already uses, so a template
 * survives a reload and a browser restart exactly like a signed-in session
 * does, and clearing site data clears both together.
 *
 * The module holds an in-memory mirror plus a listener set so React can read
 * synchronously through `useSyncExternalStore` without every card racing its
 * own IndexedDB read.
 */

import { get, set } from "idb-keyval";

import {
  type ChannelTemplate,
  parseTemplatesFile,
  sortTemplates,
  templateFromWire,
  templateToWire,
} from "./lib/templateModel.ts";

const STORE_KEY = "buzz.channel-templates.v1";

let templates: ChannelTemplate[] = [];
let loaded = false;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeTemplates(listener: () => void): () => void {
  listeners.add(listener);
  void ensureLoaded();
  return () => {
    listeners.delete(listener);
  };
}

/** Synchronous snapshot — a stable array reference between writes. */
export function templatesSnapshot(): ChannelTemplate[] {
  return templates;
}

export function templatesLoaded(): boolean {
  return loaded;
}

/**
 * Read once per page. Storage failures (private mode, blocked site data) leave
 * the list empty rather than throwing: templates are a convenience, and losing
 * them must never stop the settings page rendering.
 */
export function ensureLoaded(): Promise<void> {
  loadPromise ??= (async () => {
    try {
      const stored = await get(STORE_KEY);
      if (Array.isArray(stored)) {
        const parsed: ChannelTemplate[] = [];
        for (const row of stored) {
          const template = templateFromWire(row);
          if (template) parsed.push(template);
        }
        templates = sortTemplates(parsed);
      }
    } catch {
      // Storage unavailable — start empty.
    }
    loaded = true;
    emit();
  })();
  return loadPromise;
}

/**
 * Replace the whole set. Stored in the desktop's wire shape so a future
 * import/export (and any hand-inspection of IndexedDB) reads the same JSON the
 * desktop writes, rather than a second private encoding.
 */
export async function writeTemplates(next: ChannelTemplate[]): Promise<void> {
  templates = sortTemplates(next);
  emit();
  try {
    await set(STORE_KEY, templates.map(templateToWire));
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Could not save templates: ${error.message}`
        : "Could not save templates.",
    );
  }
}

/** Parse an uploaded file's text into records. Re-exported for the card. */
export { parseTemplatesFile };
