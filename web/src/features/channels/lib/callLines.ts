import type { TimelineMessage } from "./messageBuffer.ts";

/**
 * Voice-call lines in the main chat.
 *
 * During a huddle / DM voice call the relay mirrors every utterance (the
 * person's transcribed speech and the agent's spoken reply) into the call's
 * parent channel as it lands: a RELAY-signed kind:9 tagged
 * `["buzz-system","call-line"]` and attributed to its speaker by
 * `["actor", <pubkey>]` (buzz-relay `audio/transcript.rs`). The relay can only
 * write the pubkey that signed the call-room message, so the attribution is
 * as trustworthy as the relay's signature — which is why it is honoured ONLY
 * when the author IS the relay's NIP-11 `self` key. A client can put any tags
 * on its own events; it cannot sign as the relay.
 */
export const CALL_LINE = "call-line";

/** Whether any row could be a call line (decides whether to read NIP-11). */
export function hasCallLines(messages: readonly TimelineMessage[]): boolean {
  return messages.some((message) => message.buzzSystem === CALL_LINE);
}

/**
 * Attribute verified call lines to their speaker: `authorPubkey` becomes the
 * `actor`, so the row renders, groups, and resolves its profile exactly like
 * a message that speaker typed — with no call marker (Sam, 2026-10-01: a
 * spoken line looks like any other message from that speaker). Rows that are
 * not relay-signed call lines are returned untouched, and so is the array
 * itself when nothing changed (memo stability).
 */
export function attributeCallLines<T extends TimelineMessage>(
  messages: T[],
  relaySelf: string | null,
): T[] {
  if (relaySelf === null) {
    return messages;
  }
  const relay = relaySelf.toLowerCase();
  let out: T[] | null = null;
  messages.forEach((message, index) => {
    if (
      message.buzzSystem !== CALL_LINE ||
      !message.actorPubkey ||
      message.authorPubkey.toLowerCase() !== relay
    ) {
      return;
    }
    out ??= messages.slice();
    out[index] = { ...message, authorPubkey: message.actorPubkey };
  });
  return out ?? messages;
}
