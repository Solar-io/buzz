import { useMemo } from "react";
import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import { useAgentFrames, useAgentObserverHistory } from "./ObserverProvider";
import { agentWorkingState } from "./lib/observerEvents";
import { useTick } from "./ui/WorkingBadge";

/**
 * The open agent DM's observer frames and "received and working" state, for
 * the thinking pane and the timeline's working row. Lifted out of
 * `routes/repos.tsx` unchanged (web redesign Phase 0, file-size budget).
 */
export function useDmAgentActivity(
  dmAgentPubkey: string | null,
  channelId: string | undefined,
  messages: readonly TimelineMessage[],
) {
  const agentFrames = useAgentFrames(dmAgentPubkey);
  // The live REQ only carries the last few minutes (see ObserverProvider), so
  // an agent's earlier turns come from its own retained history. Scoped to the
  // open DM's agent: the sidebar rows deliberately do NOT fetch, or every row
  // would pull a page of its own.
  useAgentObserverHistory(dmAgentPubkey);
  const frames = useMemo(
    () =>
      agentFrames.filter(
        (frame) => frame.channelId === null || frame.channelId === channelId,
      ),
    [agentFrames, channelId],
  );
  // "Received and working": sticky turn start; the agent's kind-9 reply
  // landing in the channel ends the turn.
  const working = useMemo(
    () =>
      agentWorkingState(
        frames,
        messages
          .filter((m) => m.authorPubkey === dmAgentPubkey)
          .reduce((max, m) => Math.max(max, m.createdAt), 0),
        Math.floor(Date.now() / 1000),
      ),
    [frames, messages, dmAgentPubkey],
  );
  useTick(working.working);
  return { frames, working };
}
