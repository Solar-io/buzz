import { useEffect, useMemo, useRef, useState } from "react";

import type { RelaySession } from "@/shared/api/relay-session";
import type { StatusInput } from "./lib/workFeed.ts";
import {
  EMPTY_STATUS_STORE,
  foldStatus,
  parseTaskStatus,
  pruneStatus,
  STATUS_LOOKBACK_S,
  type StatusStore,
  type TaskStatusHead,
} from "./lib/taskStatus.ts";
import { taskStatusFilters } from "./lib/workQueries.ts";

/** No EOSE by then: the REQ is not being served (an older relay) — "unavailable". */
const STATUS_EOSE_TIMEOUT_MS = 15_000;
/**
 * Heads arriving within this window fold in one render. A history replay is
 * hundreds of separate socket messages, each its own task; one state update
 * per message would re-run the whole Work join hundreds of times on load.
 */
const FLUSH_MS = 60;

/**
 * Kind-30624 task status for every channel the viewer is in (Phase 8), held
 * by WorkProvider beside its other subscriptions.
 *
 * One REQ per 128-channel chunk with `#h` — history and live in one, since
 * the relay never fans a channel-scoped event out to a global subscription.
 * Re-keyed on the settled channel set like the reaction REQs; the store
 * survives a re-subscribe (a replayed head folds to the same store), so the
 * rows never blink when the viewer joins a channel.
 */
export function useTaskStatus(options: {
  session: RelaySession;
  live: boolean;
  /** Sorted, settled, comma-joined channel ids ("" = none). */
  channelKey: string;
  /** Local midnight — the floor for Done today. */
  sinceS: number;
}): StatusInput {
  const { session, live, channelKey, sinceS } = options;
  const [store, setStore] = useState<StatusStore>(EMPTY_STATUS_STORE);
  const [phase, setPhase] = useState<StatusInput["state"]>("loading");
  const pending = useRef<TaskStatusHead[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!live) {
      return;
    }
    if (channelKey === "") {
      // In no channel: nothing to read, and that is a settled answer.
      setPhase((previous) => (previous === "loading" ? "ready" : previous));
      return;
    }
    const flush = () => {
      timer.current = null;
      const heads = pending.current;
      pending.current = [];
      if (heads.length > 0) {
        setStore((previous) => foldStatus(previous, heads));
      }
    };
    const filters = taskStatusFilters(
      channelKey.split(","),
      Math.floor(Date.now() / 1000),
    );
    let waiting = filters.length;
    const timeout = setTimeout(() => {
      setPhase((previous) =>
        previous === "loading" ? "unavailable" : previous,
      );
    }, STATUS_EOSE_TIMEOUT_MS);
    const unsubscribes = filters.map((filter) =>
      session.subscribe(filter, {
        onEvent: (event) => {
          const head = parseTaskStatus(event);
          if (!head) {
            return;
          }
          pending.current.push(head);
          timer.current ??= setTimeout(flush, FLUSH_MS);
        },
        onEose: () => {
          waiting -= 1;
          if (waiting === 0) {
            // Fold what the history delivered BEFORE calling it ready, so
            // Done today never renders a count the replay is still adding to.
            if (timer.current) {
              clearTimeout(timer.current);
            }
            flush();
            setPhase("ready");
          }
        },
      }),
    );
    return () => {
      clearTimeout(timeout);
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [session, live, channelKey]);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  // Ended turns and details older than the lookback cannot reach any row.
  useEffect(() => {
    const prune = setInterval(() => {
      const floor = Math.floor(Date.now() / 1000) - STATUS_LOOKBACK_S;
      setStore((previous) => pruneStatus(previous, floor));
    }, 60_000);
    return () => clearInterval(prune);
  }, []);

  return useMemo(
    () => ({ state: phase, store, sinceS }),
    [phase, store, sinceS],
  );
}
