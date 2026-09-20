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

import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import type { ChannelSummary } from "@/features/channels/useChannels";
import {
  timelineMessageFromEvent,
  type TimelineMessage,
} from "@/features/channels/lib/messageBuffer.ts";
import type { Unsubscribe } from "@/shared/api/relay-session";
import { useInboxMessages } from "./hooks.ts";
import {
  answeredByMe,
  asksBadgeCount,
  extractAsks,
  myReplyToCard,
  unansweredAsks,
  type AskChannelInfo,
  type AskItem,
} from "./lib/askDetection.ts";
import { answeredQuestionCount } from "@/features/channels/lib/cardAnswerTag.ts";
import {
  answerHistoryRequests,
  answerLiveRequests,
  targetedAnswerRequest,
} from "./lib/askQueries.ts";
import {
  emptyAsksCacheEntry,
  fromCachedAsk,
  loadAsksCache,
  markCachedAnswered,
  nextPersistedEntry,
  recordCachedProgress,
  saveAsksCache,
  type AsksCacheEntry,
} from "./lib/askCache.ts";

/**
 * The shell-level owner of the Asks inbox (D-035 follow-on).
 *
 * ## Why one provider at the shell
 *
 * The sidebar badge must be visible on EVERY view, and `useInboxMessages`'s
 * subscriptions must not be duplicated per pane — so this mounts exactly once,
 * inside `ChannelBrowser`, with the same mount discipline as
 * `NotificationRuntime` / `RemindMeLaterProvider`. It takes `channels` and
 * `selfPubkey` as props rather than opening a second kind:39000 REQ.
 *
 * ## What it owns
 *
 * - The mention+DM discovery feed (`useInboxMessages`, reused verbatim — the
 *   inbox view reads this same feed through the context, so the subscription
 *   count does not change while the inbox is open).
 * - Answer detection: the `#e` REQ families from `askQueries` — a global
 *   history REQ for the tracked (unanswered) card ids, `#h`-chunked live REQs,
 *   a 5-minute heartbeat, and a targeted REQ when a row is tapped. Every
 *   re-subscribe is keyed on the tracked-id SET (debounced 2s), never per
 *   render.
 * - Badge persistence (`askCache`): the cache paints the badge on reload
 *   before discovery lands, and `answered` survives reloads so a cleared
 *   badge stays cleared.
 *
 * It never writes into the per-channel timeline caches: the asks feed is
 * derived state over the same signed events the channel view renders, so the
 * two views cannot disagree.
 */

const ANSWER_HEARTBEAT_MS = 5 * 60 * 1_000;
/**
 * One early re-run of the answer-history REQs after the settled set opens
 * them. A REQ that races the relay's AUTH processing is served an EMPTY EOSE
 * (scoped to zero accessible channels) rather than `CLOSED("auth-required")`,
 * so the session's auth-race retry never fires — measured on the live relay
 * 2026-09-17: mount REQ answered `EOSE` with zero events in 17ms while the
 * answer existed; the same filter post-auth returned it. The second shot
 * closes the reload-resurrect window to seconds instead of the heartbeat's
 * five minutes.
 */
const ANSWER_SECOND_SHOT_MS = 10_000;
/** Burst coalescing: many asks arriving together re-open the REQs once. */
const TRACKED_SET_DEBOUNCE_MS = 2_000;

interface AsksContextValue {
  /** The discovery feed (mentions + DMs) — `HomeInboxRoute` reads this. */
  feed: TimelineMessage[];
  /** True until the relay has replayed discovery history. */
  loading: boolean;
  /** Asks still waiting on the viewer, newest first. */
  asks: AskItem[];
  /** The sidebar badge: unanswered asks only. */
  badge: number;
  /**
   * Fire the targeted answer REQ for one card — called when an ask row is
   * tapped, so a missed historical answer clears the badge at the moment of
   * attention.
   */
  probeAsk: (cardId: string) => void;
}

const AsksContext = createContext<AsksContextValue>({
  feed: [],
  loading: false,
  asks: [],
  badge: 0,
  probeAsk: () => {},
});

/** Shell-level asks state; requires {@link AsksProvider} above the caller. */
export function useAsks(): AsksContextValue {
  return useContext(AsksContext);
}

/** Channel info ask detection reads; the 2-party-DM leniency uses the count. */
function askChannelInfos(
  channels: readonly ChannelSummary[],
): AskChannelInfo[] {
  return channels.map((channel) => ({
    id: channel.id,
    type: channel.type,
    participantCount: channel.participantPubkeys.length,
  }));
}

export function AsksProvider({
  channels,
  selfPubkey,
  children,
}: {
  channels: ChannelSummary[];
  selfPubkey: string | null;
  children: ReactNode;
}) {
  const { session } = useRelaySession();
  const { messages: feed, loading } = useInboxMessages({
    selfPubkey,
    channels,
  });

  // ---- persisted state (paint before discovery reconciles) ----------------
  const [cache, setCache] = useState<AsksCacheEntry | null>(null);
  /** Content of the last entry actually written to disk (null = never). */
  const savedEntryRef = useRef<AsksCacheEntry | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadAsksCache().then((entry) => {
      if (cancelled || !entry) {
        return;
      }
      // If an answer landed before the disk read resolved (fast live REQ,
      // slow idb), the fresh load must not clobber it — the in-memory
      // answered map wins over the older snapshot.
      setCache((previous) => {
        if (!previous) {
          // The loaded entry IS the disk content — record it as such so the
          // persist step does not write identical bytes back on every load.
          savedEntryRef.current = entry;
          return entry;
        }
        return {
          ...entry,
          answered: { ...entry.answered, ...previous.answered },
        };
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const answered = cache?.answered ?? {};

  // ---- asks: derived from the feed once it lands, cache-painted before ----
  const channelInfos = useMemo(() => askChannelInfos(channels), [channels]);
  const asks = useMemo(() => {
    const discovered = extractAsks(feed, selfPubkey, channelInfos);
    if (discovered.length === 0 && loading && cache) {
      // Discovery has not replayed yet: paint the badge from disk rather
      // than flashing to zero. First-visit (no cache) shows nothing, which
      // is honest — there is nothing tracked. fromCachedAsk re-validates
      // every payload through the CURRENT parser.
      return cache.asks.flatMap((cached) => {
        const item = fromCachedAsk(cached);
        return item ? [item] : [];
      });
    }
    return discovered;
  }, [feed, selfPubkey, channelInfos, loading, cache]);

  const unanswered = useMemo(
    () => unansweredAsks(asks, answered),
    [asks, answered],
  );
  const badge = asksBadgeCount(asks, answered);

  // ---- answer-REQ wiring, keyed on the tracked-id SET ----------------------
  const trackedIds = useMemo(
    () => unanswered.map((ask) => ask.id).sort(),
    [unanswered],
  );
  const trackedKey = trackedIds.join(",");
  const [settledTrackedKey, setSettledTrackedKey] = useState(trackedKey);
  useEffect(() => {
    const timer = setTimeout(
      () => setSettledTrackedKey(trackedKey),
      TRACKED_SET_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [trackedKey]);

  // The handler reads the CURRENT tracked set through a ref so the callback
  // identity is stable and the subscriptions do not churn per event.
  const trackedSetRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    trackedSetRef.current = new Set(trackedIds);
  }, [trackedIds]);
  // cardId → question count. The `M` of the inbox's `N/M` chip lives on the
  // CARD, and a partial answer carries only the questions it answered — so
  // the total can only come from the ask, never from the answer event.
  const trackedTotalsRef = useRef<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    trackedTotalsRef.current = new Map(
      unanswered.map((ask) => [ask.id, ask.card.questions.length]),
    );
  }, [unanswered]);
  const selfRef = useRef(selfPubkey);
  useEffect(() => {
    selfRef.current = selfPubkey;
  }, [selfPubkey]);

  const onAnswerEvent = useCallback((event: SignedNostrEvent) => {
    const message = timelineMessageFromEvent(event);
    const cardId = message?.replyToId;
    if (!message || !cardId || !trackedSetRef.current.has(cardId)) {
      return;
    }
    const self = selfRef.current ?? "";
    // My reply to this card — answered or NOT. A partial gets this far on
    // purpose: it updates progress and must not touch `answered`.
    if (!myReplyToCard(message, cardId, self)) {
      return;
    }
    const answer = message.cardAnswer;
    const total = trackedTotalsRef.current.get(cardId);
    const complete = answeredByMe(message, cardId, self);
    setCache((previous) => {
      let next: AsksCacheEntry = previous ?? emptyAsksCacheEntry();
      if (answer && total !== undefined) {
        next = recordCachedProgress(next, cardId, {
          answered: answeredQuestionCount(answer),
          total,
          at: message.createdAt,
        });
      }
      // ONLY a complete answer clears the badge. `answered` is the map the
      // badge reads, so a partial reaching it would be the bug this whole
      // phase exists to prevent.
      return complete ? markCachedAnswered(next, cardId, message.id) : next;
    });
  }, []);

  // History answers: global #e REQs over the tracked set, on every settled
  // set change + a 5-minute heartbeat (the missed-answer safety net).
  useEffect(() => {
    if (!session || !selfPubkey || settledTrackedKey === "") {
      return;
    }
    const ids = settledTrackedKey.split(",");
    let active: Unsubscribe[] = [];
    const run = () => {
      for (const unsubscribe of active) {
        unsubscribe();
      }
      active = [];
      for (const request of answerHistoryRequests(ids)) {
        active.push(session.subscribe(request, { onEvent: onAnswerEvent }));
      }
    };
    run();
    const secondShot = setTimeout(run, ANSWER_SECOND_SHOT_MS);
    const heartbeat = setInterval(run, ANSWER_HEARTBEAT_MS);
    return () => {
      clearTimeout(secondShot);
      clearInterval(heartbeat);
      for (const unsubscribe of active) {
        unsubscribe();
      }
    };
  }, [session, selfPubkey, settledTrackedKey, onAnswerEvent]);

  // Live answers: #h-chunked REQs that re-open only when the tracked SET or
  // the channel list changes. DMs are in the chunk list — an answer can land
  // in the DM the card was asked in.
  const watchedChannelKey = useMemo(
    () =>
      channels
        .filter((channel) => !channel.archived)
        .map((channel) => channel.id)
        .sort()
        .join(","),
    [channels],
  );
  useEffect(() => {
    if (!session || !selfPubkey || settledTrackedKey === "") {
      return;
    }
    const channelIds = watchedChannelKey ? watchedChannelKey.split(",") : [];
    const unsubs = answerLiveRequests(
      settledTrackedKey.split(","),
      channelIds,
      Math.floor(Date.now() / 1_000),
    ).map((request) => session.subscribe(request, { onEvent: onAnswerEvent }));
    return () => {
      for (const unsubscribe of unsubs) {
        unsubscribe();
      }
    };
  }, [
    session,
    selfPubkey,
    settledTrackedKey,
    watchedChannelKey,
    onAnswerEvent,
  ]);

  // Targeted query on row tap — history-only, unsubscribed on EOSE.
  const probeAsk = useCallback(
    (cardId: string) => {
      if (!session || !selfPubkey) {
        return;
      }
      const unsubscribe = session.subscribe(targetedAnswerRequest(cardId), {
        onEvent: onAnswerEvent,
        onEose: () => unsubscribe(),
      });
    },
    [session, selfPubkey, onAnswerEvent],
  );

  // ---- persist: asks snapshot + answered map + cursor ----------------------
  // Content-gated through nextPersistedEntry (see its doc for why identity
  // cannot work here): every fold that changes what disk holds gets written,
  // including answered-only folds, and state only updates when the merged
  // content actually moved so the effect cannot feed itself.
  useEffect(() => {
    if (!cache) {
      return;
    }
    const decision = nextPersistedEntry(cache, savedEntryRef.current, asks);
    if (!decision) {
      return;
    }
    if (decision.persist) {
      savedEntryRef.current = decision.entry;
      void saveAsksCache(decision.entry);
    }
    if (decision.stateChanges) {
      setCache(decision.entry);
    }
  }, [asks, cache]);

  const value = useMemo(
    () => ({ feed, loading, asks: unanswered, badge, probeAsk }),
    [feed, loading, unanswered, badge, probeAsk],
  );

  return <AsksContext.Provider value={value}>{children}</AsksContext.Provider>;
}
