import { useEffect, useMemo, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { useChannels } from "@/features/channels/useChannels";
import { useProfiles } from "@/features/channels/hooks";

/** Candidate names from visible channel rosters, including existing selections. */
export function useInstructionPeople(
  selected: readonly string[],
  agentPubkeys: readonly string[],
) {
  const { session, status } = useRelaySession();
  const { channels } = useChannels();
  const [members, setMembers] = useState<ReadonlyMap<string, string[]>>(
    new Map(),
  );
  const ids = channels
    .map((channel) => channel.id)
    .sort()
    .join(",");
  useEffect(() => {
    setMembers(new Map());
    if (status !== "open" || !ids) return;
    return session.subscribe(
      { kinds: [39002], "#d": ids.split(","), limit: 500 },
      {
        onEvent: (event) => {
          const id = event.tags.find((tag) => tag[0] === "d")?.[1];
          if (id)
            setMembers((previous) =>
              new Map(previous).set(
                id,
                event.tags
                  .filter(
                    (tag) => tag[0] === "p" && /^[0-9a-f]{64}$/.test(tag[1]),
                  )
                  .map((tag) => tag[1]),
              ),
            );
        },
      },
    );
  }, [session, status, ids]);
  const keys = useMemo(
    () =>
      [...new Set([...selected, ...[...members.values()].flat()])].filter(
        (key) => selected.includes(key) || !agentPubkeys.includes(key),
      ),
    [selected, members, agentPubkeys],
  );
  const profiles = useProfiles(keys);
  return keys
    .map((pubkey) => ({
      pubkey,
      name:
        profiles.get(pubkey)?.displayName ||
        profiles.get(pubkey)?.name ||
        "Person without a profile",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
