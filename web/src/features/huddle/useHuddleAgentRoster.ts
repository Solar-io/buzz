import { useCallback, useMemo } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import { botPubkeys } from "./lib/huddleMembers.ts";
import {
  huddleAgentAddMessage,
  huddleAgentAddPlan,
} from "./lib/huddleAgents.ts";
import type { HuddleMemberSnapshot } from "./useHuddleMemberSnapshot";

/**
 * The huddle's agent roster, and the ability to add to it.
 *
 * The whole thing rides Nostr, which is the finding that made this
 * implementable at all: the desktop's `add_agent_to_huddle` is two kind-9000
 * add-member events and nothing else — "ACP spawning is NOT needed here"
 * (desktop/src-tauri/src/huddle/agents.rs:8). See `lib/huddleAgents.ts` for
 * the full evidence and for what a browser still cannot do.
 *
 * Two member snapshots are read, not one. The ephemeral channel's gives the
 * agents already in the call; the PARENT channel's is what lets the parent
 * add be skipped for an agent who is already a member there — which the
 * desktop does deliberately, because rewriting an existing member's role as
 * `bot` is forbidden for non-admins and would fail the add for no reason.
 *
 * Both snapshots are PASSED IN rather than opened here. They poll (see
 * `useHuddleMemberSnapshot` for the measured reason a live subscription cannot
 * do this job), and the speech hook needs the ephemeral one too — so owning
 * them here would put two independent pollers on the same channel. That is not
 * merely wasteful: the relay's default write quota is 10 WS events per second
 * per human (`default_human_ws`, crates/buzz-auth/src/rate_limit.rs:126), and
 * a REQ/CLOSE burst on the same tick as a publish is enough to trip it.
 */

export interface HuddleAgentRoster {
  /** Bot members of the ephemeral huddle channel, lowercase. */
  agentPubkeys: string[];
  /** Every member of the parent channel, lowercase, any role. */
  parentMemberPubkeys: string[];
  /**
   * Add one agent. Resolves with a user-facing message; `ok` is false only
   * when the REQUIRED ephemeral add failed — a failed parent add is reported
   * in the message and still counts as added, matching the desktop.
   */
  addAgent: (input: {
    agentPubkey: string;
    agentName: string;
  }) => Promise<{ ok: boolean; message: string }>;
}

export function useHuddleAgentRoster(options: {
  /** The ephemeral huddle channel; null disables the hook. */
  ephemeralChannelId: string | null;
  parentChannelId: string | null;
  /** Polled roster of the ephemeral channel. */
  ephemeral: HuddleMemberSnapshot;
  /** Polled roster of the parent channel. */
  parent: HuddleMemberSnapshot;
}): HuddleAgentRoster {
  const { session } = useRelaySession();
  const { ephemeralChannelId, parentChannelId, ephemeral, parent } = options;

  const agentPubkeys = useMemo(
    () => [...botPubkeys(ephemeral.members)],
    [ephemeral.members],
  );
  const parentMemberPubkeys = useMemo(
    () => [...parent.members.keys()],
    [parent.members],
  );
  const mergeEphemeral = ephemeral.merge;

  const addAgent = useCallback(
    async ({
      agentPubkey,
      agentName,
    }: {
      agentPubkey: string;
      agentName: string;
    }) => {
      if (!ephemeralChannelId) {
        return { ok: false, message: "This huddle is no longer active." };
      }
      const planned = huddleAgentAddPlan({
        ephemeralChannelId,
        parentChannelId,
        agentPubkey,
        currentAgentPubkeys: agentPubkeys,
        parentMemberPubkeys,
      });
      if ("error" in planned) {
        return { ok: false, message: planned.error };
      }

      // Ephemeral first, and fail hard on it: an agent added only to the
      // parent channel is not in the huddle at all.
      const signedEphemeral = await signNostrEvent(planned.plan.ephemeral);
      const ephemeralResult = await session.publish(signedEphemeral);
      if (!ephemeralResult.ok) {
        return {
          ok: false,
          message:
            ephemeralResult.message || "The relay refused the huddle add.",
        };
      }
      // The relay's re-signed snapshot only reaches a FRESH request, so the
      // roster would otherwise still be missing this agent until the next
      // poll — long enough for a user to add the same agent twice.
      mergeEphemeral(agentPubkey, "bot");

      if (planned.plan.parent === null) {
        return {
          ok: true,
          message: huddleAgentAddMessage({
            agentName,
            parentAttempted: false,
            parentOk: false,
          }),
        };
      }
      // Best effort, exactly as the desktop treats it.
      const signedParent = await signNostrEvent(planned.plan.parent);
      const parentResult = await session.publish(signedParent);
      return {
        ok: true,
        message: huddleAgentAddMessage({
          agentName,
          parentAttempted: true,
          parentOk: parentResult.ok,
          parentMessage: parentResult.message,
        }),
      };
    },
    [
      session,
      ephemeralChannelId,
      parentChannelId,
      agentPubkeys,
      parentMemberPubkeys,
      mergeEphemeral,
    ],
  );

  return { agentPubkeys, parentMemberPubkeys, addAgent };
}
