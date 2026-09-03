/**
 * localStorage seed helpers for small, slowly-changing reference data
 * (profiles, channel list). A reload paints from the seed before the relay
 * answers, so sidebars render names on first frame instead of hex keys.
 *
 * Merge-on-write semantics: several hook instances (each with a different
 * author set) write the same key; writes union their entries into whatever
 * is already stored, so nobody clobbers anybody. Corrupt storage reads as an
 * empty seed — seeding is an optimization, never load-bearing for
 * correctness.
 */

const SEED_CAP = 400;

function readSeed(key: string): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Load a seed previously merged under `key`. */
export function loadSeed(key: string): Record<string, unknown> {
  return readSeed(key);
}

/** Union `entries` into the seed under `key`, capped at the newest 400. */
export function mergeSeed(
  key: string,
  entries: Record<string, unknown>,
): void {
  if (Object.keys(entries).length === 0) {
    return;
  }
  try {
    const existing = readSeed(key);
    const merged = { ...existing, ...entries };
    const keys = Object.keys(merged);
    const capped: Record<string, unknown> = {};
    const start = Math.max(0, keys.length - SEED_CAP);
    for (let i = start; i < keys.length; i++) {
      capped[keys[i]] = merged[keys[i]];
    }
    window.localStorage.setItem(key, JSON.stringify(capped));
  } catch {
    // Quota exceeded or storage blocked: the seed is best-effort.
  }
}
