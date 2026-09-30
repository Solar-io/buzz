import { useEffect, useMemo, useState } from "react";

import { useObserverStore } from "@/features/agents/ObserverProvider";
import { useAsks } from "@/features/home/AsksProvider";
import { buildInboxItems } from "@/features/home/lib/inboxItem.ts";
import { inboxReadPredicate } from "@/features/home/lib/inboxReadState.ts";
import { useRemindersQuery } from "@/features/reminders/hooks";
import { useWorkContext } from "./WorkProvider";
import { buildWorkFeed } from "./lib/workFeed.ts";
import type { WorkFeed, WorkScope } from "./lib/workTypes.ts";

const EMPTY_FRAMES = new Map();
const NO_REACTIONS: never[] = [];
const NO_TARGETS = new Map();

/** Unix seconds, re-read every `intervalMs` while `active`. */
export function useNowSeconds(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      intervalMs,
    );
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}

/**
 * The Work tab's one read: every input `buildWorkFeed` joins, gathered from
 * the owners that already hold it — asks and the mention feed
 * (AsksProvider), reminders (the shared query), observer frames
 * (ObserverProvider) and the Work subscriptions (WorkProvider).
 */
export function useWorkFeed(options: {
  scope: WorkScope;
  /** The open conversation; null on view pages. */
  channelId: string | null;
  nowS: number;
}): WorkFeed {
  const context = useWorkContext();
  const { interviews, feed } = useAsks();
  const observer = useObserverStore();
  const reminders = useRemindersQuery(context?.selfPubkey ?? null).data;

  const channels = context?.channels;
  const selfPubkey = context?.selfPubkey ?? null;
  const readState = context?.readState;
  const inboxRead = context?.inboxRead;
  const inboxItems = useMemo(() => {
    if (!channels || !readState || !inboxRead) {
      return [];
    }
    return buildInboxItems({
      messages: feed,
      channels,
      selfPubkey,
      isRead: inboxReadPredicate(readState, inboxRead),
    });
  }, [feed, channels, selfPubkey, readState, inboxRead]);

  const approvals = context?.approvals;
  const reactions = context?.reactions ?? NO_REACTIONS;
  const targets = context?.targets ?? NO_TARGETS;
  const metrics = context?.metrics;
  const dismissedTurns = context?.dismissedTurns;
  const byAgent = observer?.byAgent ?? EMPTY_FRAMES;
  const { scope, channelId, nowS } = options;
  return useMemo(
    () =>
      buildWorkFeed(
        {
          needs: {
            interviews,
            inboxItems,
            approvals: approvals ?? [],
            reminders: reminders ?? [],
          },
          observer: byAgent,
          dismissedTurns: dismissedTurns ?? new Set(),
          reactions,
          targets,
          metrics: metrics ?? { state: "loading" },
        },
        nowS,
        scope,
        channelId,
      ),
    [
      interviews,
      inboxItems,
      approvals,
      reminders,
      byAgent,
      dismissedTurns,
      reactions,
      targets,
      metrics,
      nowS,
      scope,
      channelId,
    ],
  );
}
