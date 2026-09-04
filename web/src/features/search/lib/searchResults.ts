/**
 * The result list, as one flat ordered array.
 *
 * Flat is the point: the panel renders four *sections* (jump-to actions,
 * channels, people, messages) but the keyboard walks a single sequence, so the
 * ordering and the selection index have to be decided in one place. Building
 * the sections independently and then trying to move a cursor across them is
 * how a ↓ key lands on nothing.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

import type { SearchHit } from "./searchQuery.ts";

export interface SearchActionResult {
  kind: "action";
  id: string;
  label: string;
  hint?: string;
}

export interface SearchChannelResult {
  kind: "channel";
  id: string;
  label: string;
  hint?: string;
}

export interface SearchPersonResult {
  kind: "person";
  pubkey: string;
  label: string;
  hint?: string;
}

export interface SearchMessageResult {
  kind: "message";
  hit: SearchHit;
}

export type SearchResult =
  | SearchActionResult
  | SearchChannelResult
  | SearchPersonResult
  | SearchMessageResult;

/** Stable React key / test id for a result. */
export function searchResultKey(result: SearchResult): string {
  switch (result.kind) {
    case "action":
      return `action:${result.id}`;
    case "channel":
      return `channel:${result.id}`;
    case "person":
      return `person:${result.pubkey}`;
    default:
      return `message:${result.hit.id}`;
  }
}

/**
 * Order the sections.
 *
 * Jump targets first because they are free — they resolve from state the app
 * already holds and are on screen on the first keystroke, while message hits
 * are still behind a debounce and a relay round trip. Putting messages first
 * would make the top of the list shuffle under the user's fingers as results
 * land.
 */
export function assembleSearchResults(input: {
  actions?: readonly SearchActionResult[];
  channels?: readonly SearchChannelResult[];
  people?: readonly SearchPersonResult[];
  messages?: readonly SearchMessageResult[];
}): SearchResult[] {
  return [
    ...(input.actions ?? []),
    ...(input.channels ?? []),
    ...(input.people ?? []),
    ...(input.messages ?? []),
  ];
}

/**
 * Move the selection, wrapping at both ends.
 *
 * Wrapping rather than clamping because the list is short and the panel is
 * modal: pressing ↑ at the top to reach the last message is the behaviour
 * every command palette has, and clamping there feels broken.
 */
export function moveSelection(
  current: number,
  delta: number,
  count: number,
): number {
  if (count <= 0) {
    return 0;
  }
  return (((current + delta) % count) + count) % count;
}

/** Keep a selection valid when the list shrinks under it. */
export function clampSelection(current: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  return Math.min(Math.max(current, 0), count - 1);
}

/**
 * Rank channels for the jump list by how well the name matches.
 *
 * Exact name beats prefix beats substring beats a description hit; ties break
 * on the shorter name, so `#dev` outranks `#developers` for "dev". Returns
 * null when nothing matches, which is what keeps a non-matching channel out of
 * the list entirely rather than at rank ∞.
 */
export function scoreChannelMatch(
  channel: { name: string; about?: string | null },
  needle: string,
): number | null {
  const query = needle.trim().toLowerCase();
  if (query.length === 0) {
    return null;
  }
  const name = channel.name.toLowerCase();
  if (name === query) {
    return 0;
  }
  if (name.startsWith(query)) {
    return 1;
  }
  if (name.includes(query)) {
    return 2;
  }
  const about = channel.about?.toLowerCase() ?? "";
  return about.includes(query) ? 3 : null;
}

/** Rank people the same way, over display name and pubkey prefix. */
export function scorePersonMatch(
  person: { displayName?: string | null; pubkey: string },
  needle: string,
): number | null {
  const query = needle.trim().toLowerCase();
  if (query.length === 0) {
    return null;
  }
  const name = person.displayName?.trim().toLowerCase() ?? "";
  if (name.length > 0) {
    if (name === query) {
      return 0;
    }
    if (name.startsWith(query)) {
      return 1;
    }
    if (name.includes(query)) {
      return 2;
    }
  }
  return person.pubkey.toLowerCase().startsWith(query) ? 3 : null;
}
