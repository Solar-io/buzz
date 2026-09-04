import { useEffect, useMemo, useState } from "react";

import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { useChannels } from "@/features/channels/useChannels";
import {
  mergeWorkflow,
  workflowFromEvent,
  WORKFLOW_DEFINITION_KIND,
  type WorkflowSummary,
} from "./lib/workflowDefinition.ts";

/**
 * The community's workflow definitions, live from the relay.
 *
 * kind:30620 is scoped by its `h` tag, and the relay authorizes reads against
 * the channel that tag names. Both the CLI (`cmd_list_workflows`) and Buzz
 * Desktop (`get_channel_workflows`) therefore query `#h` per channel; this does
 * the same, one filter per channel the viewer can see, sent as a single REQ.
 *
 * The per-channel shape is deliberate rather than one multi-value `#h`: the
 * desktop's `get_channels_workflows` records that older relays narrowed a
 * multi-value `#h` filter to its first value, silently returning one channel's
 * workflows. One filter per channel cannot be narrowed that way.
 */
export function useWorkflows(): {
  workflows: WorkflowSummary[];
  /** Channels the viewer can see, so the caller can label a workflow's scope. */
  channelNames: Map<string, string>;
  connected: boolean;
  /** True until the relay has answered the first REQ. */
  loading: boolean;
} {
  const { session, status } = useRelaySession();
  const { channels } = useChannels();
  const [byId, setById] = useState<Map<string, WorkflowSummary>>(
    () => new Map(),
  );
  const [loaded, setLoaded] = useState(false);

  const channelIds = useMemo(
    () =>
      channels
        .map((channel) => channel.id)
        .sort()
        .join(","),
    [channels],
  );

  useEffect(() => {
    if (status !== "open" || channelIds === "") return;
    const ids = channelIds.split(",");
    const filters = ids.map((id) => ({
      kinds: [WORKFLOW_DEFINITION_KIND],
      "#h": [id],
      limit: 200,
    }));
    return session.subscribe(filters, {
      onEvent: (event) => {
        const workflow = workflowFromEvent(event);
        if (workflow === null) return;
        setById((previous) => mergeWorkflow(previous, workflow));
      },
      onEose: () => setLoaded(true),
    });
  }, [session, status, channelIds]);

  const channelNames = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel.name])),
    [channels],
  );

  const workflows = useMemo(
    () =>
      Array.from(byId.values()).sort(
        (a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name),
      ),
    [byId],
  );

  return {
    workflows,
    channelNames,
    connected: status === "open",
    // With no channels there is nothing to ask for, so the list is settled.
    loading: !loaded && channelIds !== "",
  };
}
