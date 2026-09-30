import type { RelayEvent } from "@/shared/api/types";
import {
  getThreadReference,
  isBroadcastReply,
} from "@/features/messages/lib/threading";
import { KIND_STREAM_MESSAGE } from "@/shared/constants/kinds";
import { WAKE_SERVICE_PUBKEYS } from "@/shared/constants/wakeService";

export function hasMentionForEvent(
  event: RelayEvent,
  currentPubkey: string,
): boolean {
  return (
    currentPubkey.length > 0 &&
    event.tags.some(
      (tag) => tag[0] === "p" && tag[1]?.toLowerCase() === currentPubkey,
    )
  );
}

/**
 * True when an event is a scheduled wake addressed to someone OTHER than the
 * current user: a kind-9 from the services identity carrying at least one `p`
 * tag, none of which is the viewer. Such a wake is agent machinery the viewer
 * is a bystander to and must make no noise. A wake that mentions the viewer,
 * a services post with no `p` tag (alerts, digests), and any other kind stay
 * loud. An unknown viewer (empty pubkey) yields false.
 *
 * Duplicated in Rust as `is_wake_for_others` (`unread_catch_up.rs`) and on
 * web as `isWakeForOthers` (`wakeMessage.ts`).
 */
export function isWakeForOthers(
  event: Pick<RelayEvent, "kind" | "pubkey" | "tags">,
  currentPubkey: string,
): boolean {
  if (currentPubkey.length === 0) return false;
  if (event.kind !== KIND_STREAM_MESSAGE) return false;
  if (!WAKE_SERVICE_PUBKEYS.includes(event.pubkey.toLowerCase())) return false;
  const self = currentPubkey.toLowerCase();
  let tagged = 0;
  for (const tag of event.tags) {
    if (tag[0] !== "p" || typeof tag[1] !== "string") continue;
    if (tag[1].toLowerCase() === self) return false;
    tagged += 1;
  }
  return tagged > 0;
}

export type NotifyOptions = {
  participatedRootIds: ReadonlySet<string>;
  followedRootIds: ReadonlySet<string>;
  authoredRootIds: ReadonlySet<string>;
  mutedRootIds?: ReadonlySet<string>;
  mutedChannelIds?: ReadonlySet<string>;
  channelId?: string | null;
};

export function shouldNotifyForEvent(
  event: RelayEvent,
  currentPubkey: string,
  options: NotifyOptions,
): boolean {
  const {
    participatedRootIds,
    followedRootIds,
    authoredRootIds,
    mutedRootIds = new Set(),
    mutedChannelIds = new Set(),
    channelId = null,
  } = options;
  // Ahead of every other rule, broadcast included: a wake for another member
  // never notifies the bystander.
  if (isWakeForOthers(event, currentPubkey)) {
    return false;
  }

  const { parentId, rootId } = getThreadReference(event.tags);

  if (isBroadcastReply(event.tags)) {
    return true;
  }

  if (hasMentionForEvent(event, currentPubkey)) {
    return true;
  }

  if (channelId !== null && mutedChannelIds.has(channelId)) {
    return false;
  }

  if (parentId === null) {
    return true;
  }

  if (rootId !== null && mutedRootIds.has(rootId)) {
    return false;
  }

  if (rootId !== null && participatedRootIds.has(rootId)) {
    return true;
  }

  if (rootId !== null && followedRootIds.has(rootId)) {
    return true;
  }

  if (rootId !== null && authoredRootIds.has(rootId)) {
    return true;
  }

  return false;
}

export function isHighPriorityEventForUser(
  event: RelayEvent,
  currentPubkey: string,
): boolean {
  if (
    currentPubkey.length > 0 &&
    event.tags.some(
      (tag) => tag[0] === "p" && tag[1]?.toLowerCase() === currentPubkey,
    )
  ) {
    return true;
  }
  if (isBroadcastReply(event.tags)) {
    return true;
  }
  return false;
}
