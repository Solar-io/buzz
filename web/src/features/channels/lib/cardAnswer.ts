import type { RelaySession } from "@/shared/api/relay-session";
import { sendChannelMessage, type SendResult } from "../hooks.ts";
import {
  buildCardAnswerTag,
  type CardAnswer,
  type CardAnswerDraft,
} from "./cardAnswerTag.ts";
import type { DecisionCard } from "./decisionCard.ts";

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

/** A card event with its parsed payload. `AskItem` satisfies it; so does a
 *  `TimelineMessage` once its `card` has been narrowed to non-null. */
export interface CardInterviewTarget extends CardAnswerTarget {
  card: DecisionCard;
}

/** What the caller gets back: the relay verdict, plus what was published. */
export interface CardInterviewSendResult extends SendResult {
  /**
   * The answer as it went on the wire — `done` is DERIVED by the builder,
   * so this is the only place a caller learns whether the submission closed
   * the interview. Absent when the send never reached the relay.
   */
  answer?: CardAnswer;
}

/**
 * Answer a decision card STRUCTURALLY: one ordinary kind 9 reply carrying
 * both halves of the answer contract —
 *
 * - `content`: the deterministic per-question text every plain client and
 *   every asking agent reads (`cardAnswerFallbackText`);
 * - `["card-answer", …]`: the option ids, the note and the `done` flag
 *   (`buildCardAnswerTag`), which is what lets the client repaint "you
 *   answered X" after a reload without string-matching labels.
 *
 * Everything else is `sendCardAnswer`'s rules, unchanged and shared: the
 * reply marker e-tags the CARD (which is what answer detection reads), a
 * card that is itself a reply keeps ITS thread root (the relay rejects a
 * self-rooted reply), and the card's author is p-tagged so the asker is
 * notified once — one event per submission, never one per question.
 *
 * THROWS on a draft it will not publish (an unknown option id, an empty
 * selection, a card whose ids are ambiguous). That is the authoring-side
 * discipline the card builder already uses; callers surface the message.
 * `publish()` resolving `{ok:false}` remains a RESOLUTION, not a throw —
 * check `result.ok` as well.
 */
export async function sendCardInterviewAnswer(
  session: RelaySession,
  target: CardInterviewTarget,
  draft: CardAnswerDraft,
): Promise<CardInterviewSendResult> {
  const { tag, fallbackContent, answer } = buildCardAnswerTag(
    target.card,
    target.id,
    draft,
  );
  const result = await sendChannelMessage(session, {
    channelId: target.channelId,
    content: fallbackContent,
    mentionPubkeys: [target.authorPubkey],
    threadRef: {
      rootId: target.rootId ?? target.replyToId ?? target.id,
      replyToId: target.id,
    },
    extraTags: tag,
  });
  return { ...result, answer };
}
