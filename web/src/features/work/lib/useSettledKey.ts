import { useEffect, useState } from "react";

/** Burst coalescing, as in AsksProvider: a changing id set re-subscribes once. */
export const RESUBSCRIBE_DEBOUNCE_MS = 2_000;

/** Debounce a string key so a burst of changes re-subscribes once. */
export function useSettledKey(key: string): string {
  const [settled, setSettled] = useState(key);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(key), RESUBSCRIBE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return settled;
}

/** Append `event` unless its id is already in the list. */
export function mergeById<T extends { id: string }>(
  previous: T[],
  event: T,
): T[] {
  return previous.some((existing) => existing.id === event.id)
    ? previous
    : [...previous, event];
}
