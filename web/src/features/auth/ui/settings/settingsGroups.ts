/** Settings navigation shared by the rail, phone root, search and routes. */
export const SETTINGS_GROUP_IDS = [
  "agents",
  "accounts",
  "library",
  "account",
  "voice",
  "notifications",
  "appearance",
  "keyboard",
  "community",
  "channels",
  "data",
  "security",
  "advanced",
] as const;
export type SettingsGroupId = (typeof SETTINGS_GROUP_IDS)[number];
export interface SettingsGroupMeta {
  id: SettingsGroupId;
  navLabel: string;
  name: string;
  description: string;
  hiddenOnPhone?: boolean;
}
export interface SettingsAgent {
  pubkey: string;
  name: string;
}
export const SETTINGS_GROUPS: readonly SettingsGroupMeta[] = [
  {
    id: "agents",
    navLabel: "Agents",
    name: "Agents",
    description: "Create agents and manage their settings.",
  },
  {
    id: "accounts",
    navLabel: "Agents",
    name: "Claude accounts",
    description: "Accounts and assignments on Buzz Desktop.",
  },
  {
    id: "library",
    navLabel: "Agents",
    name: "Library",
    description: "Definitions, teams, catalog, and snapshots.",
  },
  {
    id: "account",
    navLabel: "You",
    name: "Account",
    description: "Your profile and presence.",
  },
  {
    id: "voice",
    navLabel: "You",
    name: "Voice & audio",
    description: "Your voice, agent voices, and playback.",
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
    name: "Keyboard",
    description: "All keyboard shortcuts in one place.",
    hiddenOnPhone: true,
  },
  {
    id: "community",
    navLabel: "Community",
    name: "Members & invites",
    description: "Community members, invites, and custom emoji.",
  },
  {
    id: "channels",
    navLabel: "Community",
    name: "Channels & templates",
    description: "Templates for new channels.",
  },
  {
    id: "data",
    navLabel: "Data & security",
    name: "Data",
    description: "Exports, file manager, and local archives.",
  },
  {
    id: "security",
    navLabel: "Data & security",
    name: "Security & devices",
    description: "Your key backup, this device, pairing, and identity archive.",
  },
  {
    id: "advanced",
    navLabel: "Data & security",
    name: "Advanced",
    description: "Experiments and feature flags.",
  },
];
export const DEFAULT_SETTINGS_GROUP: SettingsGroupId = "account";
export function parseSettingsGroup(raw: unknown): SettingsGroupId | undefined {
  return typeof raw === "string" &&
    (SETTINGS_GROUP_IDS as readonly string[]).includes(raw)
    ? (raw as SettingsGroupId)
    : undefined;
}
/** Explicit links win; owners enter Agents, other viewers enter Account. */
export function resolveSettingsGroup(
  raw: unknown,
  { ownsAgents = false } = {},
): SettingsGroupId {
  return (
    parseSettingsGroup(raw) ?? (ownsAgents ? "agents" : DEFAULT_SETTINGS_GROUP)
  );
}
export function filterSettingsAgents(
  query: string,
  agents: readonly SettingsAgent[],
): SettingsAgent[] {
  const needle = query.trim().toLowerCase();
  return needle
    ? agents.filter((agent) => agent.name.toLowerCase().includes(needle))
    : [];
}
export function filterSettingsGroups(
  query: string,
  groups: readonly SettingsGroupMeta[] = SETTINGS_GROUPS,
  agents: readonly SettingsAgent[] = [],
): SettingsGroupMeta[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...groups];
  const agentMatch = filterSettingsAgents(query, agents).length > 0;
  return groups.filter(
    (group) =>
      group.name.toLowerCase().includes(needle) ||
      group.navLabel.toLowerCase().includes(needle) ||
      group.description.toLowerCase().includes(needle) ||
      (group.id === "agents" && agentMatch),
  );
}
export function visibleSettingsGroups(phone: boolean): SettingsGroupMeta[] {
  return SETTINGS_GROUPS.filter((group) => !phone || !group.hiddenOnPhone);
}
/** Preserve known settings selectors. Agent targets are canonical lowercase hex. */
export function parseSettingsSearch(search: Record<string, unknown>): {
  group?: SettingsGroupId;
  agent?: string;
  tab?: string;
  definition?: string;
} {
  const group = parseSettingsGroup(search.group);
  const agent =
    typeof search.agent === "string" && /^[0-9a-f]{64}$/i.test(search.agent)
      ? search.agent.toLowerCase()
      : undefined;
  const tab =
    typeof search.tab === "string" &&
    [
      "settings",
      "channels",
      "logs",
      "memory",
      "activity",
      "definitions",
      "teams",
      "catalog",
      "snapshots",
    ].includes(search.tab)
      ? search.tab
      : undefined;
  return {
    ...(group ? { group } : {}),
    ...(agent ? { agent } : {}),
    ...(tab ? { tab } : {}),
    ...(typeof search.definition === "string" && search.definition.length > 0
      ? { definition: search.definition }
      : {}),
  };
}
