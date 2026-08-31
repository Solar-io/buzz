import { useEffect, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  HUDDLE_ENDED_KIND,
  HUDDLE_STARTED_KIND,
  huddleEndedTarget,
  huddleLinkFromEvent,
  type HuddleLink,
} from "./lib/huddleRegistry.ts";

/** Live map of ephemeral channel id → link, from 48100/48102 events. */
export function useHuddleLinks(): Map<string, HuddleLink> {
  const { session } = useRelaySession();
  const [links, setLinks] = useState<Map<string, HuddleLink>>(new Map());

  useEffect(() => {
    return session.subscribe(
      { kinds: [HUDDLE_STARTED_KIND, HUDDLE_ENDED_KIND], limit: 200 },
      {
        onEvent: (event: SignedNostrEvent) => {
          const link = huddleLinkFromEvent(event);
          if (link) {
            setLinks((previous) => {
              const next = new Map(previous);
              next.set(link.ephemeralId, link);
              return next;
            });
            return;
          }
          const ended = huddleEndedTarget(event);
          if (ended) {
            setLinks((previous) => {
              if (!previous.has(ended)) {
                return previous;
              }
              const next = new Map(previous);
              next.delete(ended);
              return next;
            });
          }
        },
      },
    );
  }, [session]);

  return links;
}
