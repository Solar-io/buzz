// Relative, not `@/`: the unit suite runs under `node --test`, which resolves
// no bundler alias, and these are value imports rather than erasable types.
import {
  DELETE_KIND,
  EDIT_KIND,
  MESSAGE_SEARCH_KINDS,
} from "../../channels/lib/messageBuffer.ts";
import { SYSTEM_MESSAGE_KIND } from "../../channels/lib/systemEvent.ts";

/**
 * What an export may include, as named groups.
 *
 * Every kind is derived from the constant the timeline already uses rather
 * than re-typed as a literal, so a kind added to the timeline cannot quietly
 * fall out of the archive. This mirrors the desktop archive card's
 * `localArchiveKinds.ts`, minus the groups a browser has no path to.
 */

/** NIP-25 reaction. The timeline pulls it in as a bare literal too. */
export const REACTION_KIND = 7;

export interface KindGroup {
  id: string;
  label: string;
  description: string;
  kinds: number[];
  /** Selected when the card first mounts. */
  defaultOn: boolean;
}

export const KIND_GROUPS: readonly KindGroup[] = [
  {
    id: "messages",
    label: "Messages and posts",
    description: "The conversation itself, including forum posts and comments.",
    kinds: [...MESSAGE_SEARCH_KINDS],
    defaultOn: true,
  },
  {
    id: "overlays",
    label: "Edits and deletions",
    description:
      "Keeps the archive honest — without these an edited message exports as its first draft.",
    kinds: [EDIT_KIND, DELETE_KIND],
    defaultOn: true,
  },
  {
    id: "reactions",
    label: "Reactions",
    description: "One event per emoji. Often the bulk of a busy channel.",
    kinds: [REACTION_KIND],
    defaultOn: false,
  },
  {
    id: "system",
    label: "System messages",
    description: "Joins, leaves and moderation tombstones.",
    kinds: [SYSTEM_MESSAGE_KIND],
    defaultOn: false,
  },
] as const;

/** Group ids selected on a fresh card. */
export function defaultGroupIds(): Set<string> {
  return new Set(
    KIND_GROUPS.filter((group) => group.defaultOn).map((group) => group.id),
  );
}

/** Add or remove one group id, returning a new set. */
export function toggleGroupId(
  groupId: string,
  selected: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  if (!next.delete(groupId)) {
    next.add(groupId);
  }
  return next;
}

/**
 * The sorted, deduped kind list a selection resolves to.
 *
 * Unknown group ids are ignored rather than throwing: a stale persisted
 * selection must not break the card.
 */
export function kindsForGroups(selected: ReadonlySet<string>): number[] {
  const kinds = new Set<number>();
  for (const group of KIND_GROUPS) {
    if (!selected.has(group.id)) {
      continue;
    }
    for (const kind of group.kinds) {
      kinds.add(kind);
    }
  }
  return [...kinds].sort((a, b) => a - b);
}
