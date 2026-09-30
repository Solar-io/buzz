import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { queryOnce } from "@/features/pulse/lib/relayQuery.ts";
import {
  parseSummaryResponse,
  type SummaryState,
  summaryBridgeUrl,
} from "@/features/reminders/lib/reminderSummary.ts";
import { newestRoster } from "@/features/scratch/lib/scratchChannel.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { ItemHead } from "./lib/itemEvent.ts";
import { rostersFilter, sourceMessagesFilter } from "./lib/itemQueries.ts";
import {
  capturedText,
  type ItemSource,
  type SummaryLine,
  summaryLine,
  summaryRequestText,
} from "./lib/itemSummary.ts";

/** Ids per source-message REQ. */
const SOURCE_BATCH = 200;

/**
 * The messages the listed items were captured from, fetched once per id in
 * batched `ids` REQs. Ids the relay does not return (a deleted message, a
 * channel the viewer has since left) simply stay absent.
 */
export function useItemSources(
  eventIds: readonly string[],
): ReadonlyMap<string, ItemSource> {
  const { session, status } = useRelaySession();
  const [sources, setSources] = useState<ReadonlyMap<string, ItemSource>>(
    () => new Map(),
  );
  const [asked, setAsked] = useState<ReadonlySet<string>>(() => new Set());
  const key = useMemo(
    () => [...new Set(eventIds)].sort().join(","),
    [eventIds],
  );
  useEffect(() => {
    if (status !== "open" || key === "") {
      return;
    }
    const missing = key.split(",").filter((id) => !asked.has(id));
    if (missing.length === 0) {
      return;
    }
    setAsked((previous) => new Set([...previous, ...missing]));
    for (let start = 0; start < missing.length; start += SOURCE_BATCH) {
      void queryOnce(
        session,
        sourceMessagesFilter(missing.slice(start, start + SOURCE_BATCH)),
      ).then((events) => {
        if (events.length === 0) {
          return;
        }
        setSources((previous) => {
          const next = new Map(previous);
          for (const event of events) {
            next.set(event.id, event);
          }
          return next;
        });
      });
    }
  }, [session, status, key, asked]);
  return sources;
}

async function fetchSummary(
  text: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(summaryBridgeUrl(window.location.hostname), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`summary bridge HTTP ${response.status}`);
  }
  const summary = parseSummaryResponse(await response.json());
  if (summary === null) {
    throw new Error("summary bridge returned a malformed reply");
  }
  return summary;
}

/**
 * The line under an item's title: its own summary tag, else the captured
 * text — verbatim when short, summarised by buzz-summary-bridge when long.
 * Only the captured text is ever sent; the answer lives in the query cache.
 */
export function useItemSummary(
  item: ItemHead,
  source: ItemSource | null,
  reporterIsAgent: boolean,
): SummaryLine | null {
  const captured = capturedText(item, source);
  const text = summaryRequestText(item, captured);
  const query = useQuery<string>({
    enabled: text !== null,
    queryKey: ["item-summary", text],
    queryFn: ({ signal }) => fetchSummary(text ?? "", signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60 * 1_000,
    retry: false,
  });
  const state: SummaryState | null =
    text === null
      ? null
      : query.isError
        ? { status: "error" }
        : query.data
          ? { status: "ready", summary: query.data }
          : { status: "loading" };
  return summaryLine({ item, captured, reporterIsAgent, state });
}

/**
 * The member rosters (kind 39002) of `channelIds`, read once when `enabled`
 * turns on — the Hand-to-an-agent and Assign pickers offer only people who
 * can see the item (an assignee outside the channel could not).
 */
export function useRosters(
  channelIds: readonly string[],
  enabled: boolean,
): { rosters: ReadonlyMap<string, ReadonlySet<string>>; loading: boolean } {
  const { session } = useRelaySession();
  const key = useMemo(
    () => [...new Set(channelIds)].sort().join(","),
    [channelIds],
  );
  const [state, setState] = useState<{
    key: string;
    rosters: ReadonlyMap<string, ReadonlySet<string>>;
  } | null>(null);
  useEffect(() => {
    if (!enabled || key === "") {
      return;
    }
    let alive = true;
    const ids = key.split(",");
    void queryOnce(session, rostersFilter(ids), 8_000).then((events) => {
      if (!alive) {
        return;
      }
      const rosters = new Map<string, ReadonlySet<string>>();
      for (const id of ids) {
        const roster = newestRoster(events, id);
        rosters.set(id, new Set(roster ? roster.keys() : []));
      }
      setState({ key, rosters });
    });
    return () => {
      alive = false;
    };
  }, [session, key, enabled]);
  const ready = state !== null && state.key === key;
  return {
    rosters: ready ? state.rosters : EMPTY_ROSTERS,
    loading: enabled && key !== "" && !ready,
  };
}

const EMPTY_ROSTERS: ReadonlyMap<string, ReadonlySet<string>> = new Map();
