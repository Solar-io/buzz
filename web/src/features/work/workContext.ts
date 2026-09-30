import { createContext, useContext } from "react";

import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import type { ReadState } from "@/features/channels/lib/readState.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { InboxReadState } from "@/features/home/lib/inboxReadState.ts";
import type { PendingApproval } from "./lib/approvalEvents.ts";
import type { ReactionEvent } from "./lib/queuedReactions.ts";
import type { ReactionTarget, WorkInputs } from "./lib/workFeed.ts";

/** What WorkProvider holds for `useWorkFeed` and the Work UI. */
export interface WorkContextValue {
  channels: ChannelSummary[];
  selfPubkey: string | null;
  agentPubkeys: ReadonlySet<string>;
  readState: ReadState;
  inboxRead: InboxReadState;
  markInboxRead: (messages: readonly TimelineMessage[]) => void;
  approvals: PendingApproval[];
  reactions: ReactionEvent[];
  targets: ReadonlyMap<string, ReactionTarget>;
  metrics: WorkInputs["metrics"];
  dismissedTurns: ReadonlySet<string>;
  dismissTurn: (turnId: string) => void;
  /** Visible Work surfaces (the rail at lg, the Work page) report in here. */
  reportVisible: (visible: boolean) => () => void;
  workVisible: () => boolean;
}

export const WorkContext = createContext<WorkContextValue | null>(null);

/** Null outside WorkProvider (e.g. a component test that mounts a row alone). */
export function useWorkContext(): WorkContextValue | null {
  return useContext(WorkContext);
}
