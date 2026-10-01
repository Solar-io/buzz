import { useMemo } from "react";

import {
  useChannelMembers,
  type ChannelMember,
} from "@/features/channels/hooks";
import { truncatePubkey } from "@/shared/lib/pubkey";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { shortKey } from "@/features/dms/lib/dmNaming.ts";

import { useHuddleMemberSnapshot } from "./useHuddleMemberSnapshot.ts";

export interface HuddleMentionCallRoster {
  channelId: string | null;
  memberPubkeys: readonly string[];
  memberRosterKnown: boolean;
}

/**
 * Turn the complete snapshot into the member shape shared by Composer. With
 * `roles` (the snapshot's pubkey → role), each member carries its role — how
 * a scratch channel knows whether the viewer owns it.
 */
export function huddleMentionMembers(
  memberPubkeys: readonly string[],
  roles?: ReadonlyMap<string, string>,
): ChannelMember[] {
  const seen = new Set<string>();
  const members: ChannelMember[] = [];
  for (const rawPubkey of memberPubkeys) {
    const pubkey = rawPubkey.toLowerCase();
    if (pubkey.length === 0 || seen.has(pubkey)) {
      continue;
    }
    seen.add(pubkey);
    const role = roles?.get(pubkey);
    members.push(
      role === undefined
        ? { pubkey, name: truncatePubkey(pubkey) }
        : { pubkey, name: truncatePubkey(pubkey), role },
    );
  }
  return members;
}

/**
 * Select the mention roster for the open route. Permanent channels retain the
 * ordinary member subscription. Temporary huddle rooms poll their own signed
 * snapshot until the active call has a known snapshot for this exact room;
 * after that edge, the call's poller is the sole source of truth.
 */
export function useHuddleMentionMembers(options: {
  channelId: string | null;
  ephemeral: boolean;
  call: HuddleMentionCallRoster;
}): ChannelMember[] {
  const { channelId, ephemeral, call } = options;
  const permanentMembers = useChannelMembers(ephemeral ? null : channelId);
  const callMatches =
    ephemeral && call.channelId === channelId && call.memberRosterKnown;
  const fallbackSnapshot = useHuddleMemberSnapshot(
    ephemeral && !callMatches ? channelId : null,
  );

  return useMemo(() => {
    if (!ephemeral) {
      return permanentMembers;
    }
    if (callMatches) {
      return huddleMentionMembers(call.memberPubkeys);
    }
    return huddleMentionMembers(
      [...fallbackSnapshot.members.keys()],
      fallbackSnapshot.members,
    );
  }, [
    call.memberPubkeys,
    callMatches,
    ephemeral,
    fallbackSnapshot.members,
    permanentMembers,
  ]);
}

/** Route adapter that keeps DM metadata fallback beside the huddle selector. */
export function useRouteMentionMembers(
  current: ChannelSummary | null,
  selfPubkey: string | null,
  call: HuddleMentionCallRoster,
): { members: ChannelMember[]; strictMentions: boolean } {
  const ephemeral = current?.ttlSeconds != null;
  const routeRoster = useHuddleMentionMembers({
    channelId: current?.id ?? null,
    ephemeral,
    call: {
      channelId: call.channelId,
      memberPubkeys: call.memberPubkeys,
      memberRosterKnown: call.memberRosterKnown,
    },
  });
  const members = useMemo(
    () =>
      current?.type === "dm" && selfPubkey
        ? current.participantPubkeys
            .filter((pk) => pk !== selfPubkey)
            .map((pk) => ({ pubkey: pk, name: shortKey(pk) }))
        : routeRoster,
    [current, routeRoster, selfPubkey],
  );
  return { members, strictMentions: ephemeral };
}
