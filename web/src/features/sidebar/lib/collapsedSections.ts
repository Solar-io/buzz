/**
 * Which sidebar sections the viewer has collapsed.
 *
 * Client-local and per-device, like the channel prefs next to it — collapsing
 * "Channels" on a laptop should not fold it on a phone, where the tradeoff
 * between reach and overview is completely different.
 *
 * Stored as a list of collapsed ids rather than a map of booleans, so a
 * section that has never been touched is simply absent and takes its
 * default (open, unless listed in DEFAULT_COLLAPSED_SECTIONS below). A new
 * section therefore takes its default for existing users instead of
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

/**
 * The nav-row disclosures under Terminal (Sam, 2026-09-30): Forums and Links
 * stopped being list sections and became nav buttons that start folded.
 *
 * Fresh ids, not the old "forums" / "links" section ids: a device that had
 * opened either section stored an `open:` marker for it, and reusing the id
 * would have started that device expanded.
 */
export const NAV_FORUMS_ID = "nav:forums";
export const NAV_LINKS_ID = "nav:links";

/**
 * Sections that start COLLAPSED for a viewer who has never touched them —
 * the secondary Forums and Links disclosures. Everything else defaults open.
 *
 * The stored list keeps its shape: a default-open section is collapsed by
 * its bare id (as before), and a default-collapsed section is opened by an
 * `open:<id>` marker. A section added to this list later folds for existing
 * users only until they open it.
 */
export const DEFAULT_COLLAPSED_SECTIONS: readonly string[] = [
  NAV_FORUMS_ID,
  NAV_LINKS_ID,
];

const OPEN_PREFIX = "open:";

export function isCollapsed(
  collapsed: CollapsedSections,
  sectionId: string,
  defaults: readonly string[] = DEFAULT_COLLAPSED_SECTIONS,
): boolean {
  if (collapsed.includes(sectionId)) return true;
  return (
    defaults.includes(sectionId) &&
    !collapsed.includes(`${OPEN_PREFIX}${sectionId}`)
  );
}

/** Toggle one section, returning a new list. */
export function toggleSection(
  collapsed: CollapsedSections,
  sectionId: string,
  defaults: readonly string[] = DEFAULT_COLLAPSED_SECTIONS,
): CollapsedSections {
  const openMarker = `${OPEN_PREFIX}${sectionId}`;
  const rest = collapsed.filter((id) => id !== sectionId && id !== openMarker);
  if (isCollapsed(collapsed, sectionId, defaults)) {
    // Opening: a default-collapsed section needs the explicit marker.
    return defaults.includes(sectionId) ? [...rest, openMarker] : rest;
  }
  return [...rest, sectionId];
}
