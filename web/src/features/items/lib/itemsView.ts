/**
 * What the Items page shows (Items artboard): the tab, the three facet
 * filters, the text box, the order, and the counts beside each tab and on the
 * sidebar row. Pure over folded heads — fold first, filter second (D5.6: a
 * pre-filter on a mutable field would show a stale owner or status).
 *
 * Import-free (type imports only), so `node --test` loads it.
 */

import type { ItemHead, ItemStatus, ItemType } from "./itemEvent.ts";

export type ItemsTab = "all" | ItemType;

/** "Not done" is the default: open, in progress and needs-you. */
export type StatusFilter = "active" | ItemStatus | "all";

/** Any owner, mine, nobody's, or one pubkey. */
export type OwnerFilter = "any" | "me" | "none" | { pubkey: string };

/** Every project, items with none, or one project label. */
export type ProjectFilter = "all" | "none" | { name: string };

export interface ItemFilters {
  tab: ItemsTab;
  status: StatusFilter;
  owner: OwnerFilter;
  project: ProjectFilter;
  /** The text box: words, `#channel` and `@person` tokens. */
  text: string;
}

export const DEFAULT_FILTERS: ItemFilters = {
  tab: "all",
  status: "active",
  owner: "any",
  project: "all",
  text: "",
};

/** Names the text box can match against, resolved by the page. */
export interface ItemNames {
  selfPubkey: string | null;
  /** "flight-path", "Gilfoyle" (a DM's other side) — no leading `#`. */
  channelName: (channelId: string | null) => string;
  personName: (pubkey: string) => string;
}

/** The text box, split: `#design` → channel, `@nikon` → person, rest words. */
export interface TextQuery {
  words: string[];
  channels: string[];
  people: string[];
}

export function parseTextQuery(text: string): TextQuery {
  const query: TextQuery = { words: [], channels: [], people: [] };
  for (const raw of text.toLowerCase().split(/\s+/)) {
    if (raw === "") {
      continue;
    }
    if (raw.startsWith("#") && raw.length > 1) {
      query.channels.push(raw.slice(1));
    } else if (raw.startsWith("@") && raw.length > 1) {
      query.people.push(raw.slice(1));
    } else {
      query.words.push(raw);
    }
  }
  return query;
}

/** A project's label as the table shows it; null when the item has none. */
export function projectLabel(
  item: Pick<ItemHead, "projectName" | "projectCoordinate">,
): string | null {
  const name = item.projectName?.trim();
  if (name) {
    return name;
  }
  if (item.projectCoordinate) {
    // A coordinate with no label: its `d` is the best name there is.
    return item.projectCoordinate.split(":").slice(2).join(":") || null;
  }
  return null;
}

export function statusMatches(
  status: ItemStatus,
  filter: StatusFilter,
): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "active") {
    return status !== "done";
  }
  return status === filter;
}

function ownerMatches(
  owner: string | null,
  filter: OwnerFilter,
  selfPubkey: string | null,
): boolean {
  if (filter === "any") {
    return true;
  }
  if (filter === "none") {
    return owner === null;
  }
  if (filter === "me") {
    return selfPubkey !== null && owner === selfPubkey;
  }
  return owner === filter.pubkey;
}

function projectMatches(item: ItemHead, filter: ProjectFilter): boolean {
  if (filter === "all") {
    return true;
  }
  const label = projectLabel(item);
  if (filter === "none") {
    return label === null;
  }
  return label !== null && label.toLowerCase() === filter.name.toLowerCase();
}

/**
 * The haystack a word is looked for in. Built once per item per names
 * change — the page memoizes it — so a keystroke is a substring scan, not a
 * name resolution.
 */
export function itemHaystack(item: ItemHead, names: ItemNames): string {
  return [
    item.id,
    item.title,
    item.summary ?? "",
    projectLabel(item) ?? "",
    names.channelName(item.channelId),
    names.personName(item.reporter),
    item.owner ? names.personName(item.owner) : "",
  ]
    .join("\n")
    .toLowerCase();
}

function textMatches(
  item: ItemHead,
  query: TextQuery,
  names: ItemNames,
  haystack: string,
): boolean {
  if (!query.words.every((word) => haystack.includes(word))) {
    return false;
  }
  if (query.channels.length > 0) {
    const channel = names.channelName(item.channelId).toLowerCase();
    if (!query.channels.every((wanted) => channel.includes(wanted))) {
      return false;
    }
  }
  if (query.people.length > 0) {
    const people = [item.reporter, item.owner]
      .filter((pubkey): pubkey is string => pubkey !== null)
      .map((pubkey) => names.personName(pubkey).toLowerCase());
    if (
      !query.people.every((wanted) =>
        people.some((person) => person.includes(wanted)),
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Newest filed first; then newest change; then id — a total order. */
export function compareItems(a: ItemHead, b: ItemHead): number {
  return (
    b.created - a.created ||
    b.updatedAt - a.updatedAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function sortItems(items: readonly ItemHead[]): ItemHead[] {
  return [...items].sort(compareItems);
}

/** Every filter EXCEPT the tab — what the tab counts are counted over. */
function passesFacets(
  item: ItemHead,
  filters: ItemFilters,
  names: ItemNames,
  query: TextQuery,
  haystack: string,
): boolean {
  return (
    statusMatches(item.status, filters.status) &&
    ownerMatches(item.owner, filters.owner, names.selfPubkey) &&
    projectMatches(item, filters.project) &&
    textMatches(item, query, names, haystack)
  );
}

export interface FilteredItems {
  /** What the table shows, in display order. */
  rows: ItemHead[];
  /** Per tab, under every other filter — "All 42 · Bugs 11 · Backlog 31". */
  tabCounts: Record<ItemsTab, number>;
}

/**
 * Apply the page's filters. `items` must already be SORTED (the page sorts
 * once per fold, not once per keystroke); `haystacks` is keyed like the fold.
 */
export function filterItems(
  items: readonly ItemHead[],
  filters: ItemFilters,
  names: ItemNames,
  haystackOf: (item: ItemHead) => string = (item) => itemHaystack(item, names),
): FilteredItems {
  const query = parseTextQuery(filters.text);
  const rows: ItemHead[] = [];
  const tabCounts: Record<ItemsTab, number> = { all: 0, bug: 0, backlog: 0 };
  for (const item of items) {
    if (!passesFacets(item, filters, names, query, haystackOf(item))) {
      continue;
    }
    tabCounts.all += 1;
    tabCounts[item.type] += 1;
    if (filters.tab === "all" || filters.tab === item.type) {
      rows.push(item);
    }
  }
  return { rows, tabCounts };
}

/** The sidebar row's "11 · 31": bugs and backlog that are not done. */
export function openCounts(items: readonly ItemHead[]): {
  bugs: number;
  backlog: number;
} {
  let bugs = 0;
  let backlog = 0;
  for (const item of items) {
    if (item.status === "done") {
      continue;
    }
    if (item.type === "bug") {
      bugs += 1;
    } else {
      backlog += 1;
    }
  }
  return { bugs, backlog };
}

/** The Project menu: every label in use, A→Z, and whether any item has none. */
export function projectOptions(items: readonly ItemHead[]): {
  names: string[];
  hasNone: boolean;
} {
  const byLower = new Map<string, string>();
  let hasNone = false;
  for (const item of items) {
    const label = projectLabel(item);
    if (label === null) {
      hasNone = true;
    } else if (!byLower.has(label.toLowerCase())) {
      byLower.set(label.toLowerCase(), label);
    }
  }
  return {
    names: [...byLower.values()].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    ),
    hasNone,
  };
}

/** The Owner menu: every owner in use, most items first. */
export function ownerOptions(items: readonly ItemHead[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.owner !== null) {
      counts.set(item.owner, (counts.get(item.owner) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([pubkey]) => pubkey);
}

export const STATUS_LABEL: Record<ItemStatus, string> = {
  open: "Open",
  progress: "In progress",
  "needs-you": "Needs you",
  done: "Done",
};

export const STATUS_FILTER_LABEL: Record<
  Exclude<StatusFilter, ItemStatus>,
  string
> = {
  active: "Not done",
  all: "Any",
};

/** "Status: Not done" / "Owner: Me" / "Project: Buzz web" — the menu buttons. */
export function statusFilterLabel(filter: StatusFilter): string {
  return filter === "active" || filter === "all"
    ? STATUS_FILTER_LABEL[filter]
    : STATUS_LABEL[filter];
}

/**
 * The project a `/bug` in this channel is filed under: the newest item from
 * the same channel (or, for a scratch channel, its parent) that names one.
 * Channels do not carry a project themselves, and the items filed from a
 * channel are the one signal that says which project it works on. Null when
 * nothing filed there names a project — the item is then filed without one
 * rather than under a guess.
 */
export function inferProject(
  items: readonly ItemHead[],
  channelIds: readonly string[],
): { name: string | null; coordinate: string | null; label: string } | null {
  let best: ItemHead | null = null;
  for (const item of items) {
    if (item.channelId === null || !channelIds.includes(item.channelId)) {
      continue;
    }
    if (item.projectName === null && item.projectCoordinate === null) {
      continue;
    }
    if (best === null || item.created > best.created) {
      best = item;
    }
  }
  const label = best ? projectLabel(best) : null;
  return best && label
    ? { name: best.projectName, coordinate: best.projectCoordinate, label }
    : null;
}
