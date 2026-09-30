import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ReadState } from "@/features/channels/lib/readState.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { InboxReadState } from "@/features/home/lib/inboxReadState.ts";
import { useInboxReadState } from "@/features/home/hooks.ts";
import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { getUnlockedSecretKey } from "@/shared/lib/key-store";
import {
  nip44DecryptFrom,
  type SignedNostrEvent,
} from "@/shared/lib/nostr-signer";
import { isNativeIOS } from "@/shared/platform/native";
import {
  type ApprovalEvent,
  type PendingApproval,
  pendingApprovals,
} from "./lib/approvalEvents.ts";
import { QUEUED_TTL_S, type ReactionEvent } from "./lib/queuedReactions.ts";
import {
  localMidnight,
  type MetricEntry,
  parseTurnMetric,
} from "./lib/turnMetrics.ts";
import type { ReactionTarget, WorkInputs } from "./lib/workFeed.ts";
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
 *   targets    the events those reactions point at (for their channel)
 *
 * Asks, mentions, reminders and observer frames already have owners
 * (AsksProvider, the reminders query, ObserverProvider); `useWorkFeed` reads
 * them directly rather than subscribing twice.
 */

const RESUBSCRIBE_DEBOUNCE_MS = 2_000;
/** No EOSE for metrics by then: the REQ is not being served — "unavailable". */
const METRICS_EOSE_TIMEOUT_MS = 15_000;

type MetricsState = WorkInputs["metrics"];

interface WorkContextValue {
  channels: ChannelSummary[];
  selfPubkey: string | null;
  agentPubkeys: ReadonlySet<string>;
  readState: ReadState;
  inboxRead: InboxReadState;
  markInboxRead: (messages: readonly TimelineMessage[]) => void;
  approvals: PendingApproval[];
  reactions: ReactionEvent[];
  targets: ReadonlyMap<string, ReactionTarget>;
  metrics: MetricsState;
  dismissedTurns: ReadonlySet<string>;
  dismissTurn: (turnId: string) => void;
  /** Visible Work surfaces (the rail at lg, the Work page) report in here. */
  reportVisible: (visible: boolean) => () => void;
  workVisible: () => boolean;
}

const WorkContext = createContext<WorkContextValue | null>(null);

export function useWorkContext(): WorkContextValue | null {
  return useContext(WorkContext);
}

/** Debounce a string key so a burst of changes re-subscribes once. */
function useSettledKey(key: string): string {
  const [settled, setSettled] = useState(key);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(key), RESUBSCRIBE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return settled;
}

function mergeById<T extends { id: string }>(previous: T[], event: T): T[] {
  return previous.some((existing) => existing.id === event.id)
    ? previous
    : [...previous, event];
}

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
        onEvent: (event) =>
          setReactions((previous) => mergeById(previous, event)),
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

  // ---- targets: which channel each reacted-to event lives in --------------
  const missingTargets = useMemo(() => {
    const ids = new Set<string>();
    for (const event of reactions) {
      if (event.kind !== 7) {
        continue;
      }
      const target = event.tags.find((tag) => tag[0] === "e")?.[1];
      if (target && !targets.has(target)) {
        ids.add(target);
      }
    }
    return [...ids].sort().slice(0, 200).join(",");
  }, [reactions, targets]);
  const settledMissing = useSettledKey(missingTargets);
  useEffect(() => {
    if (!live || settledMissing === "") {
      return;
    }
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    const close = () => {
      if (!closed) {
        closed = true;
        unsubscribe?.();
      }
    };
    unsubscribe = session.subscribe(targetsFilter(settledMissing.split(",")), {
      onEvent: (event) => {
        const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
        if (channelId) {
          setTargets((previous) =>
            previous.has(event.id)
              ? previous
              : new Map(previous).set(event.id, { channelId }),
          );
        }
      },
      onEose: close,
    });
    if (closed) {
      unsubscribe();
    }
    return close;
  }, [session, live, settledMissing]);

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
      metrics,
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
      metrics,
      dismissedTurns,
      dismissTurn,
      reportVisible,
      workVisible,
    ],
  );
  return <WorkContext.Provider value={value}>{children}</WorkContext.Provider>;
}
