import type { DecisionCard } from "@/features/channels/lib/decisionCard.ts";
import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import type { InboxChannelType } from "./inboxItem.ts";

/**
 * D-035 follow-on: the Asks inbox. A card (kind 9 + `["card", …]` tag) is an
 * ASK when it is addressed to the viewer; the viewer's own answer clears it.
 * Everything here is pure so the inbox rule can be tested without a relay —
 * the provider (`AsksProvider.tsx`) only feeds these helpers.
 *
 * Wire facts this module relies on (verified against the relay and the CLI):
 * - Addressing is an ordinary p-tag produced by the existing mention
 *   machinery (`buzz messages send --card … --mention <askee>` already emits
 *   the ask correctly), so an ask needs no new event kind and no new tag.
 * - The relay cannot filter on the multi-char `card` tag (NIP-01 generic
 *   filters are single-letter only), so discovery is client-side over the
 *   inbox's mention+DM feed — the feed already carries exactly these events.
 * - Answers are ordinary kind 9 replies whose reply-marker e-tag names the
 *   card (`DecisionCard.tsx` threadRef), so `replyToId === cardId` is the
 *   whole answered test.
 */

/** The bits of a channel the ask rule needs; `ChannelSummary` satisfies it. */
export interface AskChannelInfo {
  id: string;
  type: InboxChannelType;
  /** Participant count — the 2-party-DM leniency reads only this. */
  participantCount: number;
}

/** One unanswered card addressed to the viewer, newest sorted by the caller. */
export interface AskItem {
  /** The card event's id — the permalink target and the answered-map key. */
  id: string;
  channelId: string;
  channelType: InboxChannelType;
  authorPubkey: string;
  createdAt: number;
  card: DecisionCard;
  /**
   * The card event's NIP-10 placement — an inline answer needs the card's
   * thread root to satisfy the relay's ancestry check (`cardAnswer.ts`).
   * Together with id/channelId/authorPubkey these make AskItem a
   * `CardAnswerTarget`.
   */
  rootId: string | null;
  replyToId: string | null;
}

/**
 * Is this card an ASK FOR ME?
 *
 *     card parses ∧ not mine ∧ (p-tags me ∨ (2-party DM))
 *
 * The DM leniency exists because an agent asking inside a 1:1 DM usually
 * omits `--mention` (the askee is unambiguous), and DM cards are an
 * explicitly shipped half of D-035. In group DMs and channels the p-tag is
 * required — group cards without my p-tag are cards for someone else or
 * broadcast, and inventing a backfill heuristic for them would manufacture
 * asks the sender never addressed.
 */
export function askForMe(
  message: Pick<TimelineMessage, "card" | "authorPubkey" | "mentionPubkeys">,
  selfPubkey: string,
  channelType: InboxChannelType,
  participantCount: number,
): boolean {
  if (!message.card) {
    return false;
  }
  if (message.authorPubkey === selfPubkey) {
    return false;
  }
  if (message.mentionPubkeys.includes(selfPubkey)) {
    return true;
  }
  return channelType === "dm" && participantCount === 2;
}

/**
 * The answered rule lives in `features/channels/lib/cardAnswered.ts` and is
 * re-exported here, not reimplemented.
 *
 * It moved there when the timeline started needing it too: an answered card
 * must render terminal in the CHANNEL as well as clear the inbox badge, and
 * the version of this that held "answered" in component state let a card come
 * back answerable on a remount (measured 2026-09-20 — scrolling it out of the
 * virtualizer and back was enough). Two copies of the rule would let the badge
 * and the card disagree about the same event, which has no correct reading, so
 * there is one copy and the dependency points channels-ward like every other
 * import in this feature.
 */
export {
  answeredByMe,
  myReplyToCard,
} from "@/features/channels/lib/cardAnswered.ts";

/** Channel info for a lookup that missed — never DM-lenient by accident. */
function unknownChannel(channelId: string): AskChannelInfo {
  return { id: channelId, type: "stream", participantCount: 0 };
}

/**
 * Every ask in a discovery feed, newest first.
 *
 * The feed is the inbox's mention+DM result set (`inboxRequests`), which is
 * exactly the population asks derive from: a channel card outside it did not
 * p-tag the viewer and is not an ask by definition. An unknown channel id
 * resolves to the strict form (p-tag required) rather than guessing.
 */
export function extractAsks(
  messages: readonly TimelineMessage[],
  selfPubkey: string | null,
  channels: readonly AskChannelInfo[],
): AskItem[] {
  if (!selfPubkey) {
    return [];
  }
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const asks: AskItem[] = [];
  for (const message of messages) {
    if (message.deleted || !message.card) {
      // Same no-card refusal askForMe applies — spelled out here so TS can
      // narrow `message.card` for the AskItem below.
      continue;
    }
    const channel =
      channelById.get(message.channelId) ?? unknownChannel(message.channelId);
    if (
      !askForMe(message, selfPubkey, channel.type, channel.participantCount)
    ) {
      continue;
    }
    asks.push({
      id: message.id,
      channelId: message.channelId,
      channelType: channel.type,
      authorPubkey: message.authorPubkey,
      createdAt: message.createdAt,
      card: message.card,
      rootId: message.rootId,
      replyToId: message.replyToId,
    });
  }
  return asks.sort(
    (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
}

/**
 * The asks still waiting on the viewer — the Asks section and the badge both
 * render from this, keyed by the persisted `answered` map (cardId → answerId).
 */
export function unansweredAsks(
  asks: readonly AskItem[],
  answered: Readonly<Record<string, string>>,
): AskItem[] {
  return asks.filter((ask) => answered[ask.id] === undefined);
}

/** The sidebar badge: unanswered asks only. */
export function asksBadgeCount(
  asks: readonly AskItem[],
  answered: Readonly<Record<string, string>>,
): number {
  return unansweredAsks(asks, answered).length;
}
