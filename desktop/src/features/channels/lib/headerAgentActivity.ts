export type HeaderAgentActivityState = {
  /**
   * Agent whose session pane the header activity button opens, or null when
   * no target can resolve. Channels without any agent keep the button (click
   * surfaces a "nothing here yet" notice) so it doesn't flicker with the
   * working signal; agent-less DMs hide it entirely.
   */
  targetPubkey: string | null;
  showButton: boolean;
};

export type HeaderAgentActivityInput = {
  channelType: string | undefined;
  /** Single-participant DM pubkey, already normalized. */
  dmParticipantPubkey: string | null;
  /** Whether relay metadata identifies that participant as an agent. */
  dmParticipantIsAgent: boolean;
  /** Group DMs have no single agent target; the button stays hidden. */
  dmParticipantCount: number;
  /** Agents with a live working signal in this channel (click-time fresh). */
  workingAgentPubkeys: readonly string[];
  /** Agents with sessions in this channel (managed/relay agent list). */
  channelAgentPubkeys: readonly string[];
};

/**
 * Resolve the header activity button's target for the active channel.
 *
 * DMs open the agent participant directly. Channels prefer an agent with a
 * live working signal, then fall back to the first channel session agent —
 * the panel reads the local archive either way, so the fallback still shows
 * history. On hosts that manage no agents (e.g. a second desktop on the same
 * relay), the working signal is the only populated source, which is why it
 * takes precedence over the managed-agent list.
 */
export function resolveHeaderAgentActivity({
  channelType,
  dmParticipantPubkey,
  dmParticipantIsAgent,
  dmParticipantCount,
  workingAgentPubkeys,
  channelAgentPubkeys,
}: HeaderAgentActivityInput): HeaderAgentActivityState {
  if (channelType === "dm") {
    if (
      dmParticipantCount !== 1 ||
      !dmParticipantIsAgent ||
      !dmParticipantPubkey
    ) {
      return { targetPubkey: null, showButton: false };
    }
    return { targetPubkey: dmParticipantPubkey, showButton: true };
  }
  const targetPubkey = workingAgentPubkeys[0] ?? channelAgentPubkeys[0] ?? null;
  return { targetPubkey, showButton: true };
}
