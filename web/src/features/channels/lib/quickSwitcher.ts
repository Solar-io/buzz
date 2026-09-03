/**
 * Quick-switcher ranking for the ⌘K palette.
 *
 * ⌘K was message full-text search only: there was no way to jump to a channel,
 * open a DM, or reach an action from the keyboard. This ranks the things you
 * can jump *to*, which resolve synchronously from state the shell already
 * holds — so they appear instantly, while message search stays debounced
 * behind a relay round-trip.
 *
 * Deliberately substring-and-prefix, not fuzzy. A channel list is small and
 * its names are short; fuzzy matching on short strings produces confident
 * nonsense ("dsg" matching "#design" and "#dogs" equally), and there is no
 * good way to explain the ordering to someone who disagrees with it.
 */

export type QuickTargetKind = "channel" | "dm" | "action";

export interface QuickTarget {
  /** Channel id, or a stable action id. */
  id: string;
  kind: QuickTargetKind;
  label: string;
  /** Secondary line — a channel topic, "Direct message", etc. */
  hint?: string;
  /** Higher sorts first. Only meaningful within one ranking call. */
  score: number;
}

/** A candidate before scoring. `keywords` widen matching beyond the label. */
export interface QuickCandidate {
  id: string;
  kind: QuickTargetKind;
  label: string;
  hint?: string;
  keywords?: string[];
  /**
   * Tie-break for equally-good text matches — recency for conversations, a
   * fixed order for actions. Higher wins.
   */
  weight?: number;
  /**
   * What to run when this candidate is chosen. Actions carry one; channels
   * and DMs are navigated by id instead, so they leave it unset.
   */
  onSelect?: () => void;
}

/** Match strength, highest first. Scores are ordinal, not distances. */
const EXACT = 1000;
const PREFIX = 100;
const WORD_PREFIX = 50;
const SUBSTRING = 10;

/**
 * Score one candidate against a lowercased query.
 * Returns 0 when nothing matches, which the caller filters out.
 */
function scoreOne(query: string, candidate: QuickCandidate): number {
  const haystacks = [candidate.label, ...(candidate.keywords ?? [])];
  let best = 0;
  for (const raw of haystacks) {
    const text = raw.toLowerCase();
    if (text === query) {
      best = Math.max(best, EXACT);
      continue;
    }
    if (text.startsWith(query)) {
      best = Math.max(best, PREFIX);
      continue;
    }
    // Match at a word boundary — "des" should find "buzz design" as a
    // stronger hit than a mid-word coincidence.
    if (text.split(/[\s\-_/]+/).some((word) => word.startsWith(query))) {
      best = Math.max(best, WORD_PREFIX);
      continue;
    }
    if (text.includes(query)) {
      best = Math.max(best, SUBSTRING);
    }
  }
  return best;
}

/**
 * Rank candidates for a query.
 *
 * An empty query returns the candidates in weight order — that is the
 * "recent activity" list the palette shows before you type, so opening ⌘K and
 * pressing Enter goes somewhere useful rather than nowhere.
 */
export function rankQuickTargets(
  query: string,
  candidates: readonly QuickCandidate[],
  limit = 8,
): QuickTarget[] {
  const trimmed = query.trim().toLowerCase();

  if (trimmed === "") {
    return candidates
      .slice()
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, limit)
      .map((candidate) => ({
        id: candidate.id,
        kind: candidate.kind,
        label: candidate.label,
        hint: candidate.hint,
        score: 0,
      }));
  }

  const scored: QuickTarget[] = [];
  for (const candidate of candidates) {
    const score = scoreOne(trimmed, candidate);
    if (score === 0) continue;
    scored.push({
      id: candidate.id,
      kind: candidate.kind,
      label: candidate.label,
      hint: candidate.hint,
      score: score + Math.min(candidate.weight ?? 0, 9),
    });
  }

  // Weight is clamped into the tie-break range above, so it can order equal
  // matches without ever promoting a substring hit over a prefix hit.
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Strip a leading sigil so "#design" and "design" behave identically, and
 * "@alice" finds a DM. Channel names are stored without the "#".
 */
export function normalizeQuickQuery(query: string): string {
  return query.replace(/^[#@]/, "");
}
