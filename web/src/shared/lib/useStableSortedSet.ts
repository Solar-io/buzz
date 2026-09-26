import { useMemo } from "react";

/** Sorted, de-duplicated, non-empty values joined — the identity of a set. */
export function sortedSetKey(values: readonly string[]): string {
  return Array.from(new Set(values.filter((value) => value.length > 0)))
    .sort()
    .join("\n");
}

/**
 * A sorted, unique copy of `values` whose IDENTITY changes only when the set
 * does. Callers pass a fresh array every render (`.map(...)`), so memoising
 * on the array reopened relay subscriptions each render — 13–19 identical
 * kind-0 REQs per load (QA 2026-09-26). Keying on the joined set fixes that.
 */
export function useStableSortedSet(values: readonly string[]): string[] {
  const key = sortedSetKey(values);
  return useMemo(() => (key ? key.split("\n") : []), [key]);
}
