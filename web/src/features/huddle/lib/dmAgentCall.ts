/**
 * Select the one agent a DM call may target.
 *
 * The DM participant list is authoritative for who is in the conversation;
 * the agent set is authoritative for whether that one counterparty is an
 * agent. Keeping both checks together prevents a group DM or human DM from
 * accidentally growing a voice room.
 */
export function eligibleDmAgentPubkey(input: {
  channelType: "stream" | "forum" | "dm";
  participantPubkeys: readonly string[];
  selfPubkey: string | null;
  knownAgentPubkeys: ReadonlySet<string>;
}): string | null {
  if (input.channelType !== "dm") {
    return null;
  }
  const others = input.participantPubkeys.filter(
    (pubkey) => pubkey.toLowerCase() !== input.selfPubkey?.toLowerCase(),
  );
  if (others.length !== 1) {
    return null;
  }
  const candidate = others[0];
  return input.knownAgentPubkeys.has(candidate.toLowerCase())
    ? candidate
    : null;
}
