import { useMemo } from "react";

import { useProfiles } from "@/features/channels/hooks";
import { Composer } from "@/features/channels/ui/Composer";
import { truncatePubkey } from "@/shared/lib/pubkey";

import { useHuddleSession } from "../HuddleSessionProvider.tsx";

/**
 * The floating huddle's composer: type into the call's own room.
 *
 * There is deliberately NO transcript here (Sam, 2026-10-01). Every kind:9
 * of the call — spoken and typed — is mirrored live into the call's parent
 * channel / DM by the relay (`buzz-relay` `audio/transcript.rs`), so a call
 * panel timeline only showed each line a second time beside the main chat.
 */
export function HuddleComposer() {
  const { call } = useHuddleSession();
  const channelId = call.channelId;
  const members = useMemo(
    () =>
      call.memberPubkeys.map((pubkey) => ({
        pubkey,
        name: truncatePubkey(pubkey),
      })),
    [call.memberPubkeys],
  );
  // The roster, including members who have not spoken yet, so every one of
  // them is mentionable by name.
  const profiles = useProfiles(call.memberPubkeys);

  if (channelId === null) {
    return null;
  }

  return (
    <div className="mt-auto" data-testid="huddle-composer">
      <Composer
        draftKey={channelId}
        members={members}
        onClearThread={() => {}}
        profiles={profiles}
        send={call.send}
        strictMentions
        threadRef={null}
      />
    </div>
  );
}
