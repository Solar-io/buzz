import type { RelaySession } from "@/shared/api/relay-session";
import { sendChannelMessage, type SendResult } from "../hooks.ts";

/**
 * The pieces of a card event the answer builder needs. `TimelineMessage`
 * satisfies it; the Asks inbox's `AskItem` carries the same fields so an ask
 * row can answer without the full timeline row.
 */
export interface CardAnswerTarget {
  id: string;
  channelId: string;
  authorPubkey: string;
  rootId: string | null;
  replyToId: string | null;
}

/**
 * Answer a D-035 decision card: one ordinary kind 9 reply whose content is
 * the chosen option's label (or typed text), mentioning the card's author so
 * the asker is notified.
 *
 * Extracted verbatim from `DecisionCard.reply` so the timeline card and the
 * Asks-inbox row answer IDENTICALLY — this is the one implementation of the
 * thread-ref rule the relay enforces (live-caught 9/16):
 *
 * - The reply marker e-tags the CARD (`replyToId: card.id`) — that marker is
 *   also how answer detection (`replyToId === cardId`) recognizes answers.
 * - A card that is itself a reply keeps ITS thread root; tagging the card as
 *   root made the relay reject the send ("root tag does not match thread
 *   ancestry"). A top-level card's parent IS its root, the ordinary case.
 *
 * `publish()` RESOLVES `{ok:false}` on a relay FAILED or ack timeout — it
 * does not throw. Callers MUST check `result.ok` and surface `result.message`
 * before rendering any sent state, and must NOT clear the ask badge
 * optimistically: the badge clears when the relay echo arrives through the
 * answer REQ and the self-authored event matches the answered predicate.
 */
export async function sendCardAnswer(
  session: RelaySession,
  card: CardAnswerTarget,
  answer: string,
): Promise<SendResult> {
  return sendChannelMessage(session, {
    channelId: card.channelId,
    content: answer.trim(),
    mentionPubkeys: [card.authorPubkey],
    threadRef: {
      rootId: card.rootId ?? card.replyToId ?? card.id,
      replyToId: card.id,
    },
  });
}
