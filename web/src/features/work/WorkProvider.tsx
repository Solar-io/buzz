import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ReadState } from "@/features/channels/lib/readState.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { useObserverStore } from "@/features/agents/ObserverProvider";
import { useInboxReadState } from "@/features/home/hooks.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { getUnlockedSecretKey } from "@/shared/lib/key-store";
import {
  nip44DecryptFrom,
  type SignedNostrEvent,
} from "@/shared/lib/nostr-signer";
import { isNativeIOS } from "@/shared/platform/native";
import { type ApprovalEvent, pendingApprovals } from "./lib/approvalEvents.ts";
import {
  QUEUED_TTL_S,
  REACTION_SEEN,
  REACTION_WORKING,
  type ReactionEvent,
} from "./lib/queuedReactions.ts";
import { observedTriggers } from "./lib/activeTurns.ts";
import { statusTriggers } from "./lib/taskStatus.ts";
import { mergeById, useSettledKey } from "./lib/useSettledKey.ts";
import { useTaskStatus } from "./useTaskStatus.ts";
import { WorkCountsProvider } from "./useWorkCounts.ts";
import {
  useWorkContext,
  WorkContext,
  type WorkContextValue,
} from "./workContext.ts";
import {
  localMidnight,
  type MetricEntry,
  parseTurnMetric,
} from "./lib/turnMetrics.ts";
import {
  buildWorkFeed,
  type ReactionTarget,
  type WorkInputs,
} from "./lib/workFeed.ts";
import {
  activityQueries,
  type ActivityQuery,
  type AgentActivity,
  activitySlot,
  LIVE_HELD_PER_SLOT,
  type LiveSlot,
  liveSlots,
  mergeActivityMessages,
} from "./lib/workActivity.ts";
import {
  cleanWorkText,
  isShortTrigger,
  replyParentId,
} from "./lib/workText.ts";
import { useNowSeconds } from "./useWorkFeed.ts";
import {
  approvalHistoryFilter,
  approvalLiveFilters,
  metricsFilter,
  reactionFilters,
  targetsFilter,
} from "./lib/workQueries.ts";

/**
 * The Work tab's own relay subscriptions (phase-1 §2.7), mounted ONCE at the
 * shell beside AsksProvider — the same discipline: every re-subscribe is
 * keyed on a sorted id set and debounced, never per render.
 *
 *   approvals  46010–46012 addressed to me (history via #p, live via #h)
 *   reactions  the known agents' 👀/💬 and their kind-5 removals (#h chunks)
 *   metrics    44200 turn metrics since local midnight, decrypted here
 *   status     30624 task status heads in my channels (#h chunks, Phase 8)
 *   targets    the events those reactions point at (for their channel)
 *
 * Asks, mentions, reminders and observer frames already have owners
 * (AsksProvider, the reminders query, ObserverProvider); `useWorkFeed` reads
 * them directly rather than subscribing twice.
 */

/** No EOSE for metrics by then: the REQ is not being served — "unavailable". */
const METRICS_EOSE_TIMEOUT_MS = 15_000;

type MetricsState = WorkInputs["metrics"];

export { useWorkContext };

function canDecrypt(): boolean {
  return isNativeIOS() || getUnlockedSecretKey() !== null;
}

export function WorkProvider({
  channels,
  selfPubkey,
  agentPubkeys,
  readState,
  children,
}: {
  channels: ChannelSummary[];
  selfPubkey: string | null;
  /** Every pubkey the shell knows as an agent (registry + observer store). */
  agentPubkeys: ReadonlySet<string>;
  /** The shell's live channel read markers (repos.tsx owns them). */
  readState: ReadState;
  children: ReactNode;
}) {
  const { session, status } = useRelaySession();
  const { inboxRead, markRead } = useInboxReadState();
  const [approvalEvents, setApprovalEvents] = useState<ApprovalEvent[]>([]);
  const [reactions, setReactions] = useState<ReactionEvent[]>([]);
  const [targets, setTargets] = useState<Map<string, ReactionTarget>>(
    () => new Map(),
  );
  const [agentActivity, setAgentActivity] = useState<AgentActivity>(
    () => new Map(),
  );
  const [metricEntries, setMetricEntries] = useState<MetricEntry[]>([]);
  const [metricsPhase, setMetricsPhase] = useState<
    "loading" | "ready" | "locked" | "unavailable"
  >("loading");
  const [metricsSince, setMetricsSince] = useState(() =>
    localMidnight(Date.now()),
  );
  const [dismissedTurns, setDismissedTurns] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const channelKey = useSettledKey(
    channels
      .filter((channel) => !channel.archived)
      .map((channel) => channel.id)
      .sort()
      .join(","),
  );
  const agentKey = useSettledKey([...agentPubkeys].sort().join(","));
  const live = status !== "idle" && selfPubkey !== null;

  // ---- approvals: history (global #p) + live (#h chunks) -----------------
  const onApproval = useCallback((event: SignedNostrEvent) => {
    setApprovalEvents((previous) => mergeById(previous, event));
  }, []);
  useEffect(() => {
    if (!live || !selfPubkey) {
      return;
    }
    return session.subscribe(
      approvalHistoryFilter(selfPubkey, Math.floor(Date.now() / 1000)),
      { onEvent: onApproval },
    );
  }, [session, live, selfPubkey, onApproval]);
  useEffect(() => {
    if (!live || !selfPubkey || channelKey === "") {
      return;
    }
    const unsubscribes = approvalLiveFilters(
      selfPubkey,
      channelKey.split(","),
      Math.floor(Date.now() / 1000),
    ).map((filter) => session.subscribe(filter, { onEvent: onApproval }));
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [session, live, selfPubkey, channelKey, onApproval]);

  // ---- reactions: 👀 / 💬 and their deletions -----------------------------
  useEffect(() => {
    if (!live || channelKey === "" || agentKey === "") {
      return;
    }
    const nowS = Math.floor(Date.now() / 1000);
    const unsubscribes = reactionFilters(
      agentKey.split(","),
      channelKey.split(","),
      nowS,
    ).map((filter) =>
      session.subscribe(filter, {
        // Only the harness's two markers and their removals: the same REQ
        // also returns every 👍 an agent left in the last two hours.
        onEvent: (event) => {
          if (
            event.kind === 5 ||
            event.content === REACTION_SEEN ||
            event.content === REACTION_WORKING
          ) {
            setReactions((previous) => mergeById(previous, event));
          }
        },
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [session, live, channelKey, agentKey]);
  // Age out reactions past the queued TTL so the list cannot grow all day.
  useEffect(() => {
    const timer = setInterval(() => {
      const floor = Math.floor(Date.now() / 1000) - QUEUED_TTL_S;
      setReactions((previous) => {
        const next = previous.filter((event) => event.created_at >= floor);
        return next.length === previous.length ? previous : next;
      });
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  // ---- metrics: 44200 since local midnight, decrypted --------------------
  useEffect(() => {
    const rollover = setInterval(() => {
      const midnight = localMidnight(Date.now());
      setMetricsSince((previous) =>
        previous === midnight ? previous : midnight,
      );
    }, 60_000);
    return () => clearInterval(rollover);
  }, []);
  useEffect(() => {
    if (!live || !selfPubkey) {
      return;
    }
    if (!canDecrypt()) {
      setMetricsPhase("locked");
      return;
    }
    setMetricsPhase("loading");
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        setMetricsPhase("unavailable");
      }
    }, METRICS_EOSE_TIMEOUT_MS);
    const unsubscribe = session.subscribe(
      metricsFilter(selfPubkey, metricsSince),
      {
        onEvent: (event) => {
          void nip44DecryptFrom(event.content, event.pubkey)
            .then(({ plaintext }) => parseTurnMetric(plaintext))
            .catch(() => null)
            .then((parsed) => {
              const entry: MetricEntry = parsed
                ? {
                    locked: false,
                    eventId: event.id,
                    agentPubkey: event.pubkey,
                    createdAt: event.created_at,
                    channelId: parsed.channelId,
                    turnId: parsed.turnId,
                    at: parsed.at ?? event.created_at,
                    stopReason: parsed.stopReason,
                  }
                : {
                    locked: true,
                    eventId: event.id,
                    createdAt: event.created_at,
                  };
              setMetricEntries((previous) =>
                previous.some((existing) => existing.eventId === event.id)
                  ? previous
                  : [...previous, entry],
              );
            });
        },
        onEose: () => {
          settled = true;
          setMetricsPhase("ready");
        },
      },
    );
    return () => {
      clearTimeout(timeout);
      unsubscribe();
    };
  }, [session, live, selfPubkey, metricsSince]);

  // ---- task status: 30624 heads in every channel I am in -------------------
  const taskStatus = useTaskStatus({
    session,
    live,
    channelKey,
    sinceS: metricsSince,
  });

  const metrics: MetricsState = useMemo(() => {
    const ready = {
      state: "ready" as const,
      entries: metricEntries,
      sinceS: metricsSince,
    };
    if (metricsPhase === "ready") {
      return ready;
    }
    // Events arrived but EOSE never did: what we have is still true.
    if (metricsPhase === "unavailable" && metricEntries.length > 0) {
      return ready;
    }
    return { state: metricsPhase };
  }, [metricsPhase, metricEntries, metricsSince]);

  // ---- targets: reacted-to and triggering events (channel + the ask) -------
  // A reaction's target places a Queued row; a 30624 head's trigger is the
  // message behind a Running or Done row. Each id is asked for once: one the
  // relay does not return (deleted, or not readable here) is not re-asked.
  const [triedTargets, setTriedTargets] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Owner-observed turns name their trigger only in observer frames. Frames
  // arrive several a second, so reduce them to a stable id key first.
  const observerFrames = useObserverStore()?.byAgent;
  const observedKey = useMemo(() => {
    if (!observerFrames) {
      return "";
    }
    const ids = new Set<string>();
    for (const set of observedTriggers(observerFrames).values()) {
      for (const id of set) {
        ids.add(id);
      }
    }
    return [...ids].sort().join(",");
  }, [observerFrames]);
  const missingTargets = useMemo(() => {
    const ids = new Set<string>();
    const want = (id: string | undefined | null) => {
      if (id && !targets.has(id) && !triedTargets.has(id)) {
        ids.add(id);
      }
    };
    const wantTrigger = (id: string | undefined | null) => {
      want(id);
      const target = id ? targets.get(id) : undefined;
      if (target?.preview && isShortTrigger(target.preview)) {
        want(target.replyParentId);
      }
    };
    for (const event of reactions) {
      if (event.kind === 7) {
        wantTrigger(event.tags.find((tag) => tag[0] === "e")?.[1]);
      }
    }
    for (const set of statusTriggers(taskStatus.store).values()) {
      for (const id of set) {
        wantTrigger(id);
      }
    }
    for (const id of observedKey === "" ? [] : observedKey.split(",")) {
      wantTrigger(id);
    }
    return [...ids].sort().slice(0, 200).join(",");
  }, [reactions, targets, triedTargets, taskStatus.store, observedKey]);
  const settledMissing = useSettledKey(missingTargets);
  useEffect(() => {
    if (!live || settledMissing === "") {
      return;
    }
    const batch = settledMissing.split(",");
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    const close = () => {
      if (!closed) {
        closed = true;
        unsubscribe?.();
      }
    };
    unsubscribe = session.subscribe(targetsFilter(batch), {
      onEvent: (event) => {
        const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
        if (channelId) {
          setTargets((previous) =>
            previous.has(event.id)
              ? previous
              : new Map(previous).set(event.id, {
                  channelId,
                  authorPubkey: event.pubkey,
                  preview: cleanWorkText(event.content),
                  replyParentId: replyParentId(event.tags),
                }),
          );
        }
      },
      onEose: () => {
        setTriedTargets((previous) => {
          const next = new Set(previous);
          for (const id of batch) {
            next.add(id);
          }
          return next;
        });
        close();
      },
    });
    if (closed) {
      unsubscribe();
    }
    return close;
  }, [session, live, settledMissing]);

  // ---- own messages: bounded history, settled keys, close on EOSE ---------
  const nowS = useNowSeconds(60_000, live);
  const activityFeed = useMemo(
    () =>
      buildWorkFeed(
        {
          needs: {
            interviews: [],
            inboxItems: [],
            approvals: [],
            reminders: [],
          },
          observer: observerFrames ?? new Map(),
          dismissedTurns,
          reactions,
          targets,
          metrics,
          status: taskStatus,
        },
        nowS,
        "everywhere",
        null,
      ),
    [
      observerFrames,
      dismissedTurns,
      reactions,
      targets,
      metrics,
      taskStatus,
      nowS,
    ],
  );
  const activityKey = useMemo(
    () => JSON.stringify(activityQueries(activityFeed, nowS)),
    [activityFeed, nowS],
  );
  const settledActivity = useSettledKey(activityKey);
  const triedActivity = useRef(new Map<string, string>());
  useEffect(() => {
    if (!live) {
      return;
    }
    const queries = JSON.parse(settledActivity) as ActivityQuery[];
    const closes = queries
      .filter((query) => triedActivity.current.get(query.slot) !== query.key)
      .map((query) => {
        let closed = false;
        let unsubscribe: (() => void) | null = null;
        const received: SignedNostrEvent[] = [];
        const close = () => {
          if (!closed) {
            closed = true;
            clearTimeout(timeout);
            unsubscribe?.();
          }
        };
        const settle = () => {
          if (closed) {
            return;
          }
          triedActivity.current.set(query.slot, query.key);
          setAgentActivity((previous) =>
            new Map(previous).set(
              query.slot,
              mergeActivityMessages(
                previous.get(query.slot) ?? [],
                received,
                query.filters,
              ),
            ),
          );
          close();
        };
        const timeout = setTimeout(settle, METRICS_EOSE_TIMEOUT_MS);
        unsubscribe = session.subscribe(query.filters, {
          onEvent: (event) => received.push(event),
          onEose: settle,
        });
        if (closed) {
          unsubscribe();
        }
        return close;
      });
    return () => {
      for (const close of closes) {
        close();
      }
    };
  }, [session, live, settledActivity]);

  // ---- own messages, live: running turns and the Done grace window --------
  // History closes at EOSE; an agent's next line (or its final reply, which
  // can land after the turn's 30624 says done) arrives here instead.
  const liveKey = useMemo(
    () => JSON.stringify(liveSlots(activityFeed, nowS)),
    [activityFeed, nowS],
  );
  const settledLive = useSettledKey(liveKey);
  useEffect(() => {
    if (!live) {
      return;
    }
    const slots = JSON.parse(settledLive) as LiveSlot[];
    if (slots.length === 0) {
      return;
    }
    const filters = slots.map((slot) => ({
      kinds: [9],
      authors: [slot.agentPubkey],
      "#h": [slot.channelId],
      // No `limit`: this one stays open (bounded by `since`), and history
      // REQs are told apart from it by their `limit`.
      since: slot.since,
    }));
    const unsubscribe = session.subscribe(filters, {
      onEvent: (event) => {
        const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
        if (event.kind !== 9 || !channelId) {
          return;
        }
        const slot = activitySlot(event.pubkey, channelId);
        if (!slots.some((live) => live.slot === slot)) {
          return;
        }
        // Add, never prune by this filter: the slot also holds older Done
        // windows' history. Bounded per slot all the same.
        setAgentActivity((previous) => {
          const held = previous.get(slot) ?? [];
          if (held.some((known) => known.id === event.id)) {
            return previous;
          }
          return new Map(previous).set(
            slot,
            [...held, event]
              .sort((a, b) => b.created_at - a.created_at)
              .slice(0, LIVE_HELD_PER_SLOT),
          );
        });
      },
    });
    return unsubscribe;
  }, [session, live, settledLive]);

  // ---- local UI state ------------------------------------------------------
  const dismissTurn = useCallback((turnId: string) => {
    setDismissedTurns((previous) => new Set(previous).add(turnId));
  }, []);
  const visibleCount = useRef(0);
  const reportVisible = useCallback((visible: boolean) => {
    if (!visible) {
      return () => {};
    }
    visibleCount.current += 1;
    return () => {
      visibleCount.current -= 1;
    };
  }, []);
  const workVisible = useCallback(() => visibleCount.current > 0, []);

  const approvals = useMemo(
    () => pendingApprovals(approvalEvents),
    [approvalEvents],
  );

  const value = useMemo<WorkContextValue>(
    () => ({
      channels,
      selfPubkey,
      agentPubkeys,
      readState,
      inboxRead,
      markInboxRead: markRead,
      approvals,
      reactions,
      targets,
      agentActivity,
      metrics,
      status: taskStatus,
      dismissedTurns,
      dismissTurn,
      reportVisible,
      workVisible,
    }),
    [
      channels,
      selfPubkey,
      agentPubkeys,
      readState,
      inboxRead,
      markRead,
      approvals,
      reactions,
      targets,
      agentActivity,
      metrics,
      taskStatus,
      dismissedTurns,
      dismissTurn,
      reportVisible,
      workVisible,
    ],
  );
  return (
    <WorkContext.Provider value={value}>
      <WorkCountsProvider>{children}</WorkCountsProvider>
    </WorkContext.Provider>
  );
}
