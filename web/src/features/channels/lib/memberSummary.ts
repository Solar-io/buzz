/**
 * The channel header's roster line: who to show in the facepile, how many
 * members, how many of them are agents (Main and PhoneChannel artboards —
 * "4 members · 3 agents").
 *
 * People lead the facepile and agents follow, each group in roster order:
 * a channel of one person and six agents should still show the person.
 * "Agent" means a pubkey the shell knows as one (the registry plus anything
 * that has emitted observer frames); an unknown member counts as a person,
 * which is the honest default — it never inflates the agent count.
 *
 * Pure and import-free so `node --test` loads it directly.
 */

/** Faces in the pile before the count takes over. */
export const FACEPILE_MAX = 4;

export interface MemberSummary {
  /** Up to {@link FACEPILE_MAX} pubkeys: people first, then agents. */
  faces: string[];
  members: number;
  agents: number;
}

function isAgent(
  pubkey: string,
  agentPubkeys: ReadonlySet<string> | undefined,
): boolean {
  return (
    agentPubkeys !== undefined &&
    (agentPubkeys.has(pubkey) || agentPubkeys.has(pubkey.toLowerCase()))
  );
}

export function memberSummary(
  memberPubkeys: readonly string[],
  agentPubkeys?: ReadonlySet<string>,
): MemberSummary {
  const unique = [...new Set(memberPubkeys)];
  const people = unique.filter((pubkey) => !isAgent(pubkey, agentPubkeys));
  const agents = unique.filter((pubkey) => isAgent(pubkey, agentPubkeys));
  return {
    faces: [...people, ...agents].slice(0, FACEPILE_MAX),
    members: unique.length,
    agents: agents.length,
  };
}

/** "4 members · 3 agents" / "1 member" — the phone header's subtitle. */
export function memberSubtitle(summary: MemberSummary): string {
  const members = `${summary.members} ${summary.members === 1 ? "member" : "members"}`;
  if (summary.agents === 0) {
    return members;
  }
  return `${members} · ${summary.agents} ${summary.agents === 1 ? "agent" : "agents"}`;
}
