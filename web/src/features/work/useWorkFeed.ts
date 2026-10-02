import { useEffect, useMemo, useRef, useState } from "react";

import { useObserverStore } from "@/features/agents/ObserverProvider";
import { useAsks } from "@/features/home/AsksProvider";
import { buildInboxItems } from "@/features/home/lib/inboxItem.ts";
import { inboxReadPredicate } from "@/features/home/lib/inboxReadState.ts";
import { useRemindersQuery } from "@/features/reminders/hooks";
import { useWorkContext } from "./workContext.ts";
import { EMPTY_STATUS_STORE } from "./lib/taskStatus.ts";
import { buildWorkFeed, type StatusInput } from "./lib/workFeed.ts";
import type { WorkFeed, WorkScope } from "./lib/workTypes.ts";

const EMPTY_FRAMES = new Map();
const NO_REACTIONS: never[] = [];
const NO_TARGETS = new Map();
const NO_STATUS: StatusInput = {
  state: "loading",
  store: EMPTY_STATUS_STORE,
  sinceS: 0,
};

/**
 * A value that changes at most every `ms`. Observer frames arrive several a
 * second from a busy agent; the feed needs them within a second, not within
 * a frame — this keeps the join from re-running at the frame rate.
 */
function useThrottledValue<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const lastAt = useRef(0);
  useEffect(() => {
    const wait = lastAt.current + ms - Date.now();
    if (wait <= 0) {
      lastAt.current = Date.now();
      setShown(value);
      return;
    }
    const timer = setTimeout(() => {
      lastAt.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return shown;
}

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
  const agentActivity = context?.agentActivity;
  const metrics = context?.metrics;
  const status = context?.status ?? NO_STATUS;
  const dismissedTurns = context?.dismissedTurns;
  const byAgent = useThrottledValue(observer?.byAgent ?? EMPTY_FRAMES, 500);
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
          agentActivity,
          metrics: metrics ?? { state: "loading" },
          status,
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
      agentActivity,
      metrics,
      status,
      nowS,
      scope,
      channelId,
    ],
  );
}
