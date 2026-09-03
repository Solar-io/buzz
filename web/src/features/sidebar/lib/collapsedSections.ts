/**
 * Which sidebar sections the viewer has collapsed.
 *
 * Client-local and per-device, like the channel prefs next to it — collapsing
 * "Channels" on a laptop should not fold it on a phone, where the tradeoff
 * between reach and overview is completely different.
 *
 * Stored as a list of collapsed ids rather than a map of booleans, so a
 * section that has never been touched is simply absent and defaults to open.
 * A new section therefore appears expanded for existing users instead of
 * inheriting whatever a stale key happened to hold.
 */

const STORAGE_KEY = "buzz.collapsed-sections.v1";

export type CollapsedSections = readonly string[];

export function loadCollapsedSections(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): CollapsedSections {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    // Unavailable or corrupt storage behaves like "nothing collapsed", which
    // is the state that shows the most and hides nothing.
    return [];
  }
}

export function saveCollapsedSections(
  ids: CollapsedSections,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Preference is session-local when storage is unavailable.
  }
}

export function isCollapsed(
  collapsed: CollapsedSections,
  sectionId: string,
): boolean {
  return collapsed.includes(sectionId);
}

/** Toggle one section, returning a new list. */
export function toggleSection(
  collapsed: CollapsedSections,
  sectionId: string,
): CollapsedSections {
  return collapsed.includes(sectionId)
    ? collapsed.filter((id) => id !== sectionId)
    : [...collapsed, sectionId];
}
