/**
 * How often the viewer opens each sidebar item — the "frequently used" half
 * of the Favorites / Channels ordering (Sam, 2026-09-29).
 *
 * Each item keeps an exponentially DECAYED visit score: every open adds 1,
 * and the whole score halves every {@link VISIT_HALF_LIFE_MS}. A channel
 * visited daily therefore outranks one visited heavily a month ago, and the
 * order adapts as habits change without a hard window edge where a visit
 * suddenly stops counting.
 *
 * Per-device localStorage, like the channel prefs and collapsed sections next
 * to it: it is a local habit signal, not something another browser needs.
 * Keys are sidebar keys — a channel/DM/forum id, or `link:<shortcut id>`.
 */

const STORAGE_KEY = "buzz.sidebar-visits.v1";

/** A visit's weight halves after this long (7 days). */
export const VISIT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Most entries kept; the lowest current scores are dropped past this. */
export const MAX_VISIT_ENTRIES = 400;

/** One item's score as of `at` (epoch ms). */
export interface VisitEntry {
  score: number;
  at: number;
}

export type VisitScores = Readonly<Record<string, VisitEntry>>;

/** `entry`'s score decayed to `now`. Clock skew backwards never inflates it. */
function decayed(entry: VisitEntry, now: number): number {
  const elapsed = Math.max(0, now - entry.at);
  return entry.score * 2 ** (-elapsed / VISIT_HALF_LIFE_MS);
}

/** The item's decayed score at `now`; 0 for an item never visited. */
export function visitScore(
  scores: VisitScores,
  key: string,
  now: number,
): number {
  const entry = scores[key];
  return entry ? decayed(entry, now) : 0;
}

/**
 * Record one open of `key` at `now`. Returns a new object (the input is
 * React state). Past {@link MAX_VISIT_ENTRIES} the weakest entries go.
 */
export function recordVisit(
  scores: VisitScores,
  key: string,
  now: number,
): VisitScores {
  const next: Record<string, VisitEntry> = {
    ...scores,
    [key]: { score: visitScore(scores, key, now) + 1, at: now },
  };
  const keys = Object.keys(next);
  if (keys.length <= MAX_VISIT_ENTRIES) {
    return next;
  }
  const weakestFirst = keys.sort(
    (a, b) => visitScore(next, a, now) - visitScore(next, b, now),
  );
  for (const drop of weakestFirst.slice(0, keys.length - MAX_VISIT_ENTRIES)) {
    delete next[drop];
  }
  return next;
}

function isEntry(value: unknown): value is VisitEntry {
  if (typeof value !== "object" || value === null) return false;
  const { score, at } = value as Record<string, unknown>;
  return (
    typeof score === "number" &&
    Number.isFinite(score) &&
    score >= 0 &&
    typeof at === "number" &&
    Number.isFinite(at)
  );
}

export function loadVisitScores(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): VisitScores {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, VisitEntry> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isEntry(value)) out[key] = { score: value.score, at: value.at };
    }
    return out;
  } catch {
    // Corrupt or unavailable storage: no history, so ordering falls back to
    // the deterministic tie-breaks.
    return {};
  }
}

export function saveVisitScores(
  scores: VisitScores,
  storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(scores));
  } catch {
    // Session-local when storage is unavailable.
  }
}
