import { useMemo, useState } from "react";

import { useChannelMembers } from "@/features/channels/hooks";
import { type AgentTarget, agentTarget } from "./lib/agentTarget.ts";

/**
 * The agent box's target (lib/agentTarget.ts) for one share: the channel's
 * agent members from the live roster, the last agent that replied in the
 * file's thread, and the person's own pick.
 */
export function useAgentTargets(input: {
  channelId: string;
  authorPubkey: string;
  selfPubkey: string | null;
  isAgent: (pubkey: string) => boolean;
  comments: readonly { authorPubkey: string }[];
}): { target: AgentTarget; pick: (pubkey: string) => void } {
  const members = useChannelMembers(input.channelId);
  const [picked, setPicked] = useState<string | null>(null);
  const { authorPubkey, selfPubkey, isAgent, comments } = input;
  const memberPubkeys = useMemo(
    () => (members ?? []).map((member) => member.pubkey),
    [members],
  );
  const target = useMemo(
    () =>
      agentTarget({
        authorPubkey,
        selfPubkey,
        memberPubkeys,
        isAgent,
        comments,
        picked,
      }),
    [authorPubkey, selfPubkey, memberPubkeys, isAgent, comments, picked],
  );
  return { target, pick: setPicked };
}
