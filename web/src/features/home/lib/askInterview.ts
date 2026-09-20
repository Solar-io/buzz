import type { AskProgress } from "./askCache.ts";
import type { AskItem } from "./askDetection.ts";

/**
 * Asks, grouped into INTERVIEWS.
 *
 * An agent refines by sending a SECOND card in the same thread
 * (`--reply-to <answer event id>`), which is the whole round-2 idiom: the
 * NIP-10 thread root already encodes "these cards are one conversation", the
 * relay already enforces its integrity, and no new field, tag or filter is
 * needed to read it back. Two cards in one thread are therefore ONE thing
 * waiting on the user, and the inbox must show one row for them — two rows
 * would present a superseded question as though it were still live, which is
 * exactly the confusion the refinement loop is meant to remove.
 *
 * ## What this module is, precisely
 *
 * A fold from `AskItem[]` (every card addressed to me that I know about,
 * answered or not) to one row per interview. It is pure: no React, no cache
 * reads, no relay. The provider owns the inputs; this owns the rule.
 *
 * ## The representative card
 *
 * The row shows the NEWEST UNANSWERED card in the interview. Newest because a
 * later round supersedes an earlier one; unanswered because the row exists to
 * be answered. An interview whose cards are all answered produces NO row —
 * it is not waiting on anybody.
 *
 * ## Why the ANSWERED cards are still an input
 *
 * The `Round N` chip counts the card's position among the interview's cards,
 * and by the time round 2 arrives round 1 is answered. Folding only the
 * unanswered set would make every round-2 card read "Round 1" — a chip that
 * is wrong exactly when it matters.
 */

/** One inbox row: an interview, and the one card it is waiting on. */
export interface AskInterview {
  /**
   * The thread root — the interview's identity and the row key. Derived with
   * the same chain the answer path uses (`cardAnswer.ts`):
   * `rootId ?? replyToId ?? id`. A round-1 card is top-level so it IS its own
   * root; a round-2 card replies to round 1's answer and carries round 1's
   * root, so both land on the same key.
   */
  id: string;
  /** The newest unanswered card in the interview — what the row renders. */
  ask: AskItem;
  /**
   * 1-based position of {@link ask} among the interview's known cards, oldest
   * first. The chip renders only above 1.
   *
   * KNOWN is the honest word: the ask set is capped and the feed is a window,
   * so an interview whose earliest rounds have aged out under-counts. That is
   * a chip that says "Round 2" for a third round, never one that invents a
   * round that did not happen.
   */
  round: number;
  /** How many cards this interview holds that I know about. */
  rounds: number;
  /**
   * Unanswered cards in this interview OLDER than {@link ask} — the
   * "+N earlier" affordance. Normally 0: an agent that asks again before the
   * last question is answered is the case this counts.
   */
  earlier: number;
  /**
   * How far my newest answer to {@link ask} got — the `N/M` chip.
   * `answered` comes from a published PARTIAL (nothing else can be known from
   * outside the answering client); `total` is the card's question count,
   * which only the card can supply, because a partial answer carries just the
   * questions it answered.
   */
  progress: { answered: number; total: number };
}

/** The interview a card belongs to. */
export function interviewIdOf(
  ask: Pick<AskItem, "id" | "rootId" | "replyToId">,
): string {
  return ask.rootId ?? ask.replyToId ?? ask.id;
}

/** Oldest first, with a stable id tiebreak for same-second cards. */
function byOldest(a: AskItem, b: AskItem): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/**
 * Fold every known ask into one row per interview, newest interview first.
 *
 * @param asks every card addressed to me, answered or not, in any order
 * @param answered cardId → my completing answer's id (`askCache.answered`)
 * @param progress cardId → my newest partial (`askCache.progress`)
 */
export function groupAskInterviews(
  asks: readonly AskItem[],
  answered: Readonly<Record<string, string>>,
  progress: Readonly<Record<string, AskProgress>> = {},
): AskInterview[] {
  const byInterview = new Map<string, AskItem[]>();
  for (const ask of asks) {
    const id = interviewIdOf(ask);
    const held = byInterview.get(id);
    if (held) {
      held.push(ask);
    } else {
      byInterview.set(id, [ask]);
    }
  }

  const interviews: AskInterview[] = [];
  for (const [id, cards] of byInterview) {
    cards.sort(byOldest);
    const open = cards.filter((card) => answered[card.id] === undefined);
    const ask = open[open.length - 1];
    if (!ask) {
      // Every round answered: nothing is waiting on the viewer.
      continue;
    }
    const recorded = progress[ask.id];
    interviews.push({
      id,
      ask,
      round: cards.indexOf(ask) + 1,
      rounds: cards.length,
      earlier: open.length - 1,
      progress: {
        // A recorded partial for a DIFFERENT question count is a card that
        // changed identity, which cannot happen (the card id is content-
        // derived) — so the card's count wins and the partial only supplies N.
        answered: Math.min(recorded?.answered ?? 0, ask.card.questions.length),
        total: ask.card.questions.length,
      },
    });
  }

  // Newest first, matching the inbox's own ordering (`compareInboxRows`).
  return interviews.sort(
    (a, b) =>
      b.ask.createdAt - a.ask.createdAt || a.ask.id.localeCompare(b.ask.id),
  );
}

/** The sidebar badge and the inbox agree: one waiting interview, one count. */
export function askInterviewBadgeCount(
  interviews: readonly AskInterview[],
): number {
  return interviews.length;
}
