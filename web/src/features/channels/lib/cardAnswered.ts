/**
 * Has this decision card already been answered — and by what?
 *
 * The one rule, and the one index built from it. Both halves live here rather
 * than in a component because a card's answered-ness is a property of the
 * EVENTS, not of a React mount: the answer is an ordinary kind 9 reply sitting
 * in the same timeline buffer as the card, so any renderer can read it and two
 * renderers cannot disagree.
 *
 * ## Why this module exists (the defect it closes, measured 2026-09-20)
 *
 * The v1 card was terminal once sent, and the stepper rewrite dropped that
 * property by holding "sent" in component state. State dies with the mount,
 * and the timeline is a `virtua` virtualizer that unmounts rows the moment
 * they leave the window — so an answered card came back ANSWERABLE after a
 * reload *and* after merely scrolling it out of view and back, with its own
 * answer visible one row below. A second `done:true` answer to a card the
 * agent already acted on is the failure that makes that worth fixing here
 * instead of patching the reload path.
 *
 * So terminal state is DERIVED, never stored: `DecisionCard.tsx` reads the
 * answer off the timeline every render, and a remount recomputes it. There is
 * nothing left for a remount to lose.
 *
 * ## One rule for v1 and v2
 *
 * {@link answeredByMe} is the whole test and it is the same one the Asks badge
 * uses — `askDetection.ts` re-exports it rather than keeping a second copy,
 * because a card that the inbox calls answered while the timeline calls it
 * open is a bug with no correct reading.
 */

import type { DecisionCard } from "./decisionCard.ts";
import { answerSummary } from "./cardInterview.ts";
import type { TimelineMessage } from "./messageBuffer.ts";

/**
 * Is this event MY reply to this card at all — answered or not?
 *
 * Strict on purpose: only MY reply concerns MY ask, and it must reply TO the
 * card (`replyToId === cardId`) — a reply to a sibling elsewhere in the
 * card's thread does not.
 *
 * Split out from {@link answeredByMe} because a PARTIAL answer is my reply
 * to the card without being an answer to it: the provider records its
 * progress (`N of M` for the inbox chip) while deliberately not clearing the
 * badge. One predicate could not say both things.
 */
export function myReplyToCard(
  reply: Pick<
    TimelineMessage,
    "kind" | "authorPubkey" | "rootId" | "replyToId"
  >,
  cardId: string,
  selfPubkey: string,
): boolean {
  return (
    reply.kind === 9 &&
    reply.authorPubkey === selfPubkey &&
    reply.replyToId === cardId
  );
}

/**
 * Did MY answer clear this card?
 *
 *     my reply to the card ∧ ( no card-answer tag ∨ cardAnswer.done )
 *
 * The first arm is v1, bit-identical: a reply with no `card-answer` tag is
 * content-agnostic and COMPLETE — a plain "yes", an AskRow chip, and the
 * dismiss-and-type-freely path all clear the badge exactly as they did
 * before v2 existed. That arm is not a compatibility shim to be tidied away
 * later; it is the whole reason typing freely still works.
 *
 * The second arm is v2. A `done:false` partial leaves the ask LIT, because
 * the failure being guarded is an agent acting on 2 of 4 answers as though
 * the interview concluded: a lit badge and a stalled agent is recoverable,
 * a confidently-wrong agent is not. A tag that is present but UNREADABLE
 * parses to `done:false` for the same reason (`cardAnswerTag.ts`) — a
 * payload we could not read is never evidence of completeness.
 */
export function answeredByMe(
  reply: Pick<
    TimelineMessage,
    "kind" | "authorPubkey" | "rootId" | "replyToId" | "cardAnswer"
  >,
  cardId: string,
  selfPubkey: string,
): boolean {
  if (!myReplyToCard(reply, cardId, selfPubkey)) {
    return false;
  }
  // Falsy, not `=== null`: a caller that hands over a record without the
  // field (a hand-built event, an older cached shape) means "no tag", and a
  // thrown TypeError inside the badge predicate would take the sidebar down.
  return !reply.cardAnswer || reply.cardAnswer.done === true;
}

/**
 * cardEventId → MY answer that closed it, for every card in this buffer.
 *
 * Keyed on the CARD so a renderer can ask "is the row I am about to draw
 * already answered?" in O(1), and restricted to cards actually present so the
 * map can never be polluted by ordinary replies to ordinary messages.
 *
 * The buffer is contiguous and ends at now, so a card in it implies its answer
 * is in it too: an answer is always NEWER than the card it answers, and the
 * rolling cap (`upsertMessage`) drops the OLDEST first. There is no window in
 * which the card survives and its answer has been trimmed away.
 *
 * Newest wins, which matters after a partial: completing an interview
 * publishes a SECOND reply with `done:true`, and the later one is the answer
 * to show. Deleted replies are not answers.
 */
export function answeredCardReplies(
  messages: readonly TimelineMessage[],
  selfPubkey: string | null | undefined,
): ReadonlyMap<string, TimelineMessage> {
  const answers = new Map<string, TimelineMessage>();
  if (!selfPubkey) {
    return answers;
  }
  const cardIds = new Set<string>();
  for (const message of messages) {
    if (message.card && !message.deleted) {
      cardIds.add(message.id);
    }
  }
  if (cardIds.size === 0) {
    return answers;
  }
  for (const message of messages) {
    if (message.deleted || !message.replyToId) {
      continue;
    }
    const cardId = message.replyToId;
    if (!cardIds.has(cardId)) {
      continue;
    }
    if (!answeredByMe(message, cardId, selfPubkey)) {
      continue;
    }
    const held = answers.get(cardId);
    if (!held || message.createdAt >= held.createdAt) {
      answers.set(cardId, message);
    }
  }
  return answers;
}

/**
 * The "You replied: …" line for an answer read back off the wire.
 *
 * Built from the TAG when there is one, because the tag carries option IDS and
 * the card carries the labels — which is the whole reason v2 transmits ids at
 * all. The generated `content` is deliberately NOT used for this: it is
 * multi-line markdown addressed to the agent, and pasting it into a one-line
 * confirmation would render `**Which surfaces?**` as literal asterisks.
 *
 * Falls back to the reply's own content for the two cases where there is no
 * tag to read — a v1 answer (content IS the chosen label, verbatim) and a
 * freely-typed reply — and for the pathological case where a tag names only
 * questions this card does not have.
 */
export function cardReplySummary(
  card: DecisionCard,
  reply: Pick<TimelineMessage, "content" | "cardAnswer">,
): string {
  const answer = reply.cardAnswer;
  if (!answer || answer.cardId === null) {
    return reply.content.trim();
  }
  const lines: string[] = [];
  for (const question of card.questions) {
    const selection = answer.answers.find(
      (entry) => entry.questionId === question.id,
    );
    if (!selection) {
      continue;
    }
    const line = answerSummary(question, {
      optionIds: selection.optionIds,
      ...(selection.text === undefined ? {} : { text: selection.text }),
    });
    if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines.length > 0 ? lines.join(" · ") : reply.content.trim();
}
