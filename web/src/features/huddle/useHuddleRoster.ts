import { useEffect, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  applyHuddleLifecycle,
  huddleLifecycleFromEvent,
  HUDDLE_LIFECYCLE_KINDS,
  liveHuddlesFor,
  type HuddleRoom,
  type HuddleRoomMap,
} from "./lib/huddleParticipants.ts";

/**
 * Who is in this channel's huddles, live, WITHOUT joining the audio room.
 *
 * The relay persists every admission and departure on the parent channel
 * (48101/48102/48103), precisely so a client can reconstruct the state —
 * see `emit_participant_event` in `crates/buzz-relay/src/audio/handler.rs`.
 * So this is one channel-scoped REQ, and it answers "is anything happening
 * in here" before anyone opens a microphone.
 *
 * The filter carries `#h`. That is not stylistic: the relay scopes fan-out
 * PER-REQ, and one filter without `#h` registers the whole subscription as
 * global, after which no channel-scoped event is delivered to any of its
 * filters (`extract_channel_ids_from_filters`, `handlers/req.rs`).
 */
export function useHuddleRoster(channelId: string | null): {
  /** Rooms with somebody in them, oldest activity first. */
  live: HuddleRoom[];
  /** Every room seen, including ended ones. */
  rooms: HuddleRoomMap;
} {
  const { session } = useRelaySession();
  const [rooms, setRooms] = useState<HuddleRoomMap>(() => new Map());

  useEffect(() => {
    setRooms(new Map());
    if (!channelId) {
      return;
    }
    return session.subscribe(
      {
        kinds: [...HUDDLE_LIFECYCLE_KINDS],
        "#h": [channelId],
        limit: 200,
      },
      {
        onEvent: (event: SignedNostrEvent) => {
          const lifecycle = huddleLifecycleFromEvent(event);
          if (!lifecycle) {
            return;
          }
          setRooms((previous) => applyHuddleLifecycle(previous, lifecycle));
        },
      },
    );
  }, [session, channelId]);

  return {
    live: channelId ? liveHuddlesFor(rooms, channelId) : [],
    rooms,
  };
}
