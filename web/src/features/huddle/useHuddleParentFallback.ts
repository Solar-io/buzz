import { useEffect, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { queryOnce } from "@/features/channels/lib/unreact.ts";
import {
  HUDDLE_GUIDELINES_KIND,
  parentChannelFromGuidelines,
} from "./lib/huddleGuidelines.ts";

/**
 * Targeted parent-linkage resolution for the huddle channel being viewed.
 *
 * The ambient registry feed (`useHuddleLinks`) is a live subscription over
 * every channel's `#h`, and on a cold load it is one more REQ in the
 * page-load burst — subject to open pacing and auth-race retries — so the
 * window where a joined huddle's link simply has not landed yet is real.
 * Treating that window as "no parent" is the client-side half of the V1b
 * lockout: the join gate disabled with a false reason while the room was
 * alive on the relay.
 *
 * So when a huddle is being viewed and no link is in hand, this hook asks
 * the RELAY directly, with a one-shot query for the linkage data that
 * lives on the huddle channel's OWN timeline: its kind-48106 guidelines
 * (`#h` = the ephemeral id — the same event the desktop's agent harness
 * fetches, `fetch_huddle_instructions` in buzz-acp/pool.rs), whose content
 * names the attached main channel. One small REQ, `limit: 1`, settled by
 * EOSE or the timeout — independent of the ambient subscription's health.
 *
 * `done` is the honest settlement signal: only after it is true does "no
 * parent found" mean the relay has no linkage, as opposed to "still
 * looking".
 */
export function useHuddleParentFallback(options: {
  /** The huddle backing channel being viewed. */
  channelId: string;
  /**
   * Run the query. False while the registry already holds a link or the
   * huddle is known ended — there is nothing to resolve.
   */
  enabled: boolean;
}): { parentId: string | null; done: boolean } {
  const { session } = useRelaySession();
  const { channelId, enabled } = options;
  const [result, setResult] = useState<{
    parentId: string | null;
    done: boolean;
  }>(() => ({ parentId: null, done: false }));

  useEffect(() => {
    setResult({ parentId: null, done: false });
    if (!enabled) {
      return;
    }
    let cancelled = false;
    void queryOnce(session, {
      kinds: [HUDDLE_GUIDELINES_KIND],
      "#h": [channelId],
      limit: 1,
    }).then((events) => {
      if (cancelled) {
        return;
      }
      // Newest first: the relay's replay orders created_at DESC, and there
      // is one guidelines event per huddle by construction.
      const parent =
        events.length > 0
          ? parentChannelFromGuidelines(events[0].content)
          : null;
      setResult({ parentId: parent, done: true });
    });
    return () => {
      cancelled = true;
    };
  }, [session, channelId, enabled]);

  return result;
}
