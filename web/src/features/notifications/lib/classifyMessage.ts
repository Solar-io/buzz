/**
 * Turn a relay kind:9 event into the booleans {@link decideNotification}
 * consumes.
 *
 * Mentions are not re-derived from the message text here, and deliberately
 * so: the composer already resolves `@Name` tokens to pubkeys and emits them
 * as `p` tags (`useMessageActions` → `sendChannelMessage`), and a DM send
 * adds a `p` tag for every peer on top. So "this message is addressed to me"
 * is exactly "its p tags contain my pubkey" — the same fact the relay's own
 * p-gate and the agent harness key on. Re-parsing the text would be a second,
 * divergent implementation of mention resolution.
 */

import type { IncomingMessage } from "./notifyDecision.ts";

/** The subset of a signed Nostr event this module reads. */
export interface NotifiableEvent {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
}

/** NIP-29 channel scoping lives in the `h` tag, never in `e` tags. */
export function channelIdOf(event: NotifiableEvent): string | null {
  for (const tag of event.tags) {
    if (Array.isArray(tag) && tag[0] === "h" && typeof tag[1] === "string") {
      return tag[1];
    }
  }
  return null;
}

/** Every pubkey the message is addressed to. */
export function taggedPubkeys(event: NotifiableEvent): string[] {
  const pubkeys: string[] = [];
  for (const tag of event.tags) {
    if (Array.isArray(tag) && tag[0] === "p" && typeof tag[1] === "string") {
      pubkeys.push(tag[1]);
    }
  }
  return pubkeys;
}

export interface ClassifyContext {
  selfPubkey: string | null;
  /** The channel currently open on screen (`?c=`), or null. */
  activeChannelId: string | null;
  /** Channel ids muted in the viewer's local channel prefs. */
  mutedChannelIds: readonly string[];
  /** Channel ids known to be DMs (relay `t` tag on the kind:39000). */
  dmChannelIds: readonly string[];
}

export interface ClassifiedMessage {
  /** The `h` tag, or null for an event that carries none (never notified). */
  channelId: string | null;
  message: IncomingMessage;
}

export function classifyMessage(
  event: NotifiableEvent,
  context: ClassifyContext,
): ClassifiedMessage {
  const channelId = channelIdOf(event);
  const self = context.selfPubkey;
  return {
    channelId,
    message: {
      fromSelf: self != null && event.pubkey === self,
      mentionsSelf: self != null && taggedPubkeys(event).includes(self),
      isDm: channelId != null && context.dmChannelIds.includes(channelId),
      // A message with no channel cannot be matched against the viewer's
      // prefs or the open channel; treat it as muted rather than notifying
      // about something the app cannot then navigate to.
      channelMuted:
        channelId == null || context.mutedChannelIds.includes(channelId),
      isActiveChannel:
        channelId != null && channelId === context.activeChannelId,
    },
  };
}
