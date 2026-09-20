/**
 * The settings information architecture: the nine groups, their nav labels,
 * and the pure helpers the two-pane page derives from them.
 *
 * The IA is the approved settings redesign (Sam, 2026-09-20): two panes — a
 * fixed nav and one content pane — with nine groups under four uppercase
 * section labels (You / Community / Data / Security). Group data lives here,
 * import-free, so `node --test` can load it and the page stays a composition
 * root.
 *
 * Nothing here knows about the cards themselves; `SettingsPage` decides which
 * sections render inside which group so every card keeps its own file, logic,
 * and feature ownership.
 */

export const SETTINGS_GROUP_IDS = [
  "account",
  "notifications",
  "appearance",
  "keyboard",
  "community",
  "agents",
  "data",
  "security",
  "advanced",
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUP_IDS)[number];

export interface SettingsGroupMeta {
  id: SettingsGroupId;
  /**
   * The small uppercase label the nav shows above a run of items. Rendered
   * only when it differs from the previous item's label.
   */
  navLabel: string;
  /** Nav item text and the pane heading. */
  name: string;
  /** The one-line description under the pane heading. */
  description: string;
  /**
   * Native iOS hides surface gaps: the agents roster lives in Buzz Desktop
   * and has no native equivalent yet, so its nav item does not render there.
   */
  hiddenOnIOS?: boolean;
}

/** The nine groups, in nav order. The order is the IA — do not reshuffle. */
export const SETTINGS_GROUPS: readonly SettingsGroupMeta[] = [
  {
    id: "account",
    navLabel: "You",
    name: "Account",
    description: "Profile, presence, and how you sound.",
  },
  {
    id: "notifications",
    navLabel: "You",
    name: "Notifications",
    description: "What alerts you when Buzz is in a background tab.",
  },
  {
    id: "appearance",
    navLabel: "You",
    name: "Appearance",
    description: "Themes, colour mode, and accents.",
  },
  {
    id: "keyboard",
    navLabel: "You",
    name: "Keyboard shortcuts",
    description: "Every shortcut in one place.",
  },
  {
    id: "community",
    navLabel: "Community",
    name: "Community",
    description: "Members, emoji, invites, and channel templates.",
  },
  {
    id: "agents",
    navLabel: "Community",
    name: "Agents",
    description:
      "Create agents and change their settings — drafts are reviewed in Buzz Desktop.",
    hiddenOnIOS: true,
  },
  {
    id: "data",
    navLabel: "Data",
    name: "Data",
    description: "Exports, file manager, and local archives.",
  },
  {
    id: "security",
    navLabel: "Security",
    name: "Security & devices",
    description: "Your key, this device, pairing, and identity archive.",
  },
  {
    id: "advanced",
    navLabel: "Security",
    name: "Advanced",
    description:
      "Experiments and feature flags. Things here can change or vanish.",
  },
];

/** The group a bare `/repos/settings` lands on. */
export const DEFAULT_SETTINGS_GROUP: SettingsGroupId = "account";

/**
 * Parse the `group` search param the way `repos.tsx` parses `view`: a string
 * that names a known group survives, everything else — including a wrong
 * case — falls back to the route's default.
 */
export function parseSettingsGroup(raw: unknown): SettingsGroupId | undefined {
  return typeof raw === "string" &&
    (SETTINGS_GROUP_IDS as readonly string[]).includes(raw)
    ? (raw as SettingsGroupId)
    : undefined;
}

/**
 * Narrow a possibly-undefined param to a concrete group. Kept next to the
 * parser so the "default to account" rule has exactly one home.
 */
export function resolveSettingsGroup(raw: unknown): SettingsGroupId {
  return parseSettingsGroup(raw) ?? DEFAULT_SETTINGS_GROUP;
}

/**
 * Case-insensitive client-side filter for the nav's search input: an item
 * matches when the query is a substring of its name, its section label, or
 * its pane description — "backup" finds Security & devices through the
 * description, which is the point of searching settings at all.
 */
export function filterSettingsGroups(
  query: string,
  groups: readonly SettingsGroupMeta[] = SETTINGS_GROUPS,
): SettingsGroupMeta[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...groups];
  return groups.filter(
    (group) =>
      group.name.toLowerCase().includes(needle) ||
      group.navLabel.toLowerCase().includes(needle) ||
      group.description.toLowerCase().includes(needle),
  );
}

/**
 * Groups visible on this device, in nav order. iOS drops the agents group
 * (see `hiddenOnIOS`); everything else renders everywhere.
 */
export function visibleSettingsGroups(nativeIOS: boolean): SettingsGroupMeta[] {
  return SETTINGS_GROUPS.filter((group) => !nativeIOS || !group.hiddenOnIOS);
}
