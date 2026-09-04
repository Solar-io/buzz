/**
 * The two things the emoji picker remembers between openings: the chosen skin
 * tone, and what was picked recently.
 *
 * Parsing and updating are pure; only {@link loadPickerPrefs} and
 * {@link savePickerPrefs} touch storage, and both swallow failures — a picker
 * must open in a browser with storage disabled.
 */

export const PICKER_PREFS_KEY = "buzz:emoji-picker:v1";

/** How many recent picks the picker keeps. Two rows of nine. */
export const MAX_RECENT = 18;

export interface PickerPrefs {
  /** 0 = default (no modifier), 1–5 = light through dark. */
  tone: number;
  /**
   * Recently picked values, most recent first. Each entry is what gets
   * inserted — a unicode glyph, or `:shortcode:` for a custom emoji — so a
   * recent pick replays exactly, including its skin tone.
   */
  recent: string[];
}

export const DEFAULT_PREFS: PickerPrefs = { tone: 0, recent: [] };

/** Coerce anything read out of storage into valid prefs. */
export function parsePickerPrefs(raw: string | null): PickerPrefs {
  if (!raw) {
    return DEFAULT_PREFS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFS;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return DEFAULT_PREFS;
  }
  const value = parsed as { tone?: unknown; recent?: unknown };
  const tone =
    typeof value.tone === "number" && Number.isInteger(value.tone)
      ? Math.min(5, Math.max(0, value.tone))
      : 0;
  const recent = Array.isArray(value.recent)
    ? value.recent
        .filter((entry): entry is string => typeof entry === "string")
        .filter((entry) => entry.length > 0)
        .slice(0, MAX_RECENT)
    : [];
  return { tone, recent };
}

/**
 * Move `value` to the front of the recents, deduped and capped.
 * Returns the SAME array reference when nothing would change, so a caller can
 * skip a write and a re-render.
 */
export function pushRecent(
  recent: ReadonlyArray<string>,
  value: string,
  max = MAX_RECENT,
): string[] | readonly string[] {
  if (value === "") {
    return recent;
  }
  if (recent[0] === value) {
    return recent;
  }
  return [value, ...recent.filter((entry) => entry !== value)].slice(0, max);
}

/** Read prefs from storage; defaults when unavailable or corrupt. */
export function loadPickerPrefs(): PickerPrefs {
  try {
    return parsePickerPrefs(window.localStorage.getItem(PICKER_PREFS_KEY));
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Best-effort persist. A full or disabled store is not an error worth showing. */
export function savePickerPrefs(prefs: PickerPrefs): void {
  try {
    window.localStorage.setItem(PICKER_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Ignored — a remembered skin tone is not worth a toast.
  }
}
