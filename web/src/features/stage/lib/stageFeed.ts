/**
 * Feeds the reduced session's showings into the pacer, deciding which are
 * HISTORY (seeded) and which are LIVE (arrived).
 *
 * The pacer is seeded once, when the §4.4 history query settles. Before
 * that, `showings` can already grow: the live channel buffer delivers a
 * showing the agent posts while history is still loading. Those must be
 * treated as live — queued and spoken — not folded into the seed, where a
 * `late` join would mark them already-shown and silently skip them.
 *
 * What counts as a pre-history live arrival: a showing first seen AFTER the
 * feed's first look (the baseline) and posted no earlier than `liveSlackSec`
 * before the feed was created. The time bound keeps a cold buffer that
 * back-fills older rows after entry from being mistaken for live posts.
 */

import type { PacerShowing, StagePacer } from "./stagePacing.ts";

export const STAGE_LIVE_SLACK_SEC = 60;

export interface StageFeed<T extends PacerShowing> {
  update(showings: readonly T[], historyLoaded: boolean): void;
}

export function createStageFeed<T extends PacerShowing>(
  pacer: Pick<StagePacer<T>, "seed" | "arrive">,
  options: {
    mode: "replay" | "late";
    /** Unix seconds when Stage started. */
    nowSec: number;
    liveSlackSec?: number;
  },
): StageFeed<T> {
  const liveSince =
    options.nowSec - (options.liveSlackSec ?? STAGE_LIVE_SLACK_SEC);
  let seeded = false;
  let baseline: Set<string> | null = null;
  /** Pre-history live arrivals, in arrival order. */
  const early = new Map<string, T>();

  return {
    update(showings, historyLoaded) {
      if (seeded) {
        for (const showing of showings) pacer.arrive(showing);
        return;
      }
      if (baseline === null) {
        baseline = new Set(showings.map((s) => s.eventId));
      } else if (!historyLoaded) {
        for (const showing of showings) {
          if (
            !baseline.has(showing.eventId) &&
            !early.has(showing.eventId) &&
            showing.createdAt >= liveSince
          ) {
            early.set(showing.eventId, showing);
          }
        }
      }
      if (!historyLoaded) return;
      seeded = true;
      pacer.seed(
        showings.filter((s) => !early.has(s.eventId)),
        options.mode,
      );
      // Latest edit wins: take the current object for each early id.
      const current = new Map(showings.map((s) => [s.eventId, s]));
      for (const id of early.keys()) {
        const showing = current.get(id);
        if (showing) pacer.arrive(showing);
      }
    },
  };
}
