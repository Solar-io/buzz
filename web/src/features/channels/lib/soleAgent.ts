/**
 * Who a main-composer post notifies without a typed @ — the one agent in the
 * conversation, or null (Sam 2026-09-29: "if I'm only talking to one agent in
 * a channel, dm, or thread it always tags them automatically").
 *
 * A mention is the only wake path for a mentions-subscribed agent, so without
 * this a post in a channel shared with a single agent reaches nobody. Threads
 * have their own rule (lib/threadPartner.ts); this one covers the channel and
 * DM composer, where the audience is the member roster.
 *
 * Exactly one agent among the members other than the sender → that agent.
 * Zero or 2+ agents → null: with several agents in the room a default would
 * be a guess. Humans in the room don't change the answer.
 */
export function soleAgent(
  memberPubkeys: readonly string[],
  selfPubkey: string | null,
  agentPubkeys: ReadonlySet<string>,
): string | null {
  const self = selfPubkey?.toLowerCase();
  const agents = new Map<string, string>();
  for (const pubkey of memberPubkeys) {
    const key = pubkey.toLowerCase();
    if (key !== self && agentPubkeys.has(key)) {
      agents.set(key, pubkey);
    }
  }
  return agents.size === 1 ? [...agents.values()][0] : null;
}
