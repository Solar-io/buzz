import { useEffect, useMemo, useState } from "react";
import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  reduceStageSession,
  stageHistoryFilter,
  type StageEventLike,
  type StageSession,
} from "./lib/stageSession.ts";
import { buildStageTag } from "./lib/stageTag.ts";

/** How long the view waits for the open event before calling it missing. */
const OPEN_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * Adapt a live timeline message to the reducer's event shape. The buffer
 * keeps the PARSED stage tag, not the raw tags, so the canonical tag is
 * rebuilt (it re-parses identically) together with `h` and the imeta urls.
 * Edited content (kind 40003 overlay) flows through `content`, so an edit
 * changes the chat text but never the image or index (§4.3).
 */
export function stageEventFromTimeline(
  message: TimelineMessage,
): StageEventLike | null {
  if (!message.stage || message.deleted) return null;
  let stageTag: [string, string];
  try {
    stageTag = buildStageTag(message.stage);
  } catch {
    return null;
  }
  const tags: string[][] = [["h", message.channelId]];
  for (const url of message.imetaByUrl.keys())
    tags.push(["imeta", `url ${url}`]);
  tags.push(stageTag);
  return {
    id: message.id,
    pubkey: message.authorPubkey,
    created_at: message.createdAt,
    kind: message.kind,
    content: message.content,
    tags,
  };
}

export type StageSessionStatus = "loading" | "ready" | "missing";

export interface StageSessionState {
  session: StageSession | null;
  status: StageSessionStatus;
  /** True once the §4.4 history query reached EOSE (seed the pacer then). */
  historyLoaded: boolean;
  /** History events (raw) — the chat pane shows rows the buffer lacks. */
  historyEvents: readonly SignedNostrEvent[];
}

/**
 * One Stage session: the open event (live buffer, else `{ids:[S]}`), the
 * §4.4 history window query, and the live channel buffer, merged and
 * reduced. Live wins over history for the same id (edits land live).
 */
export function useStageSession(
  openId: string | null,
  liveMessages: readonly TimelineMessage[],
): StageSessionState {
  const { session: relay } = useRelaySession();
  const [openFetched, setOpenFetched] = useState<SignedNostrEvent | null>(null);
  const [openMissing, setOpenMissing] = useState(false);
  const [history, setHistory] = useState<SignedNostrEvent[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  const liveOpen = useMemo(() => {
    const message = liveMessages.find((m) => m.id === openId);
    return message ? stageEventFromTimeline(message) : null;
  }, [liveMessages, openId]);
  const open: StageEventLike | null = liveOpen ?? openFetched;
  // Only PRESENCE matters for the lookup below — not every buffer change.
  const haveLiveOpen = liveOpen !== null;

  // 1. The open event, when the buffer does not have it.
  useEffect(() => {
    setOpenFetched(null);
    setOpenMissing(false);
    if (!openId || haveLiveOpen) return;
    let done = false;
    const unsubscribe = relay.subscribe(
      { ids: [openId], kinds: [9] },
      {
        onEvent: (event) => {
          if (event.id === openId) setOpenFetched(event);
        },
        onEose: () => {
          done = true;
        },
      },
    );
    const timer = setTimeout(() => {
      if (!done) setOpenMissing(true);
    }, OPEN_LOOKUP_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [openId, relay, haveLiveOpen]);

  // 2. The history window (h + authors + 24 h), once the open is known.
  const channelId = open?.tags.find((t) => t[0] === "h")?.[1] ?? null;
  const author = open?.pubkey ?? null;
  const openedAt = open?.created_at ?? null;
  useEffect(() => {
    setHistory([]);
    setHistoryLoaded(false);
    if (!channelId || !author || openedAt === null) return;
    const collected: SignedNostrEvent[] = [];
    let flushed = false;
    const flush = () => {
      if (flushed) return;
      flushed = true;
      setHistory(collected.slice());
      setHistoryLoaded(true);
    };
    const unsubscribe = relay.subscribe(
      stageHistoryFilter({ pubkey: author, created_at: openedAt, channelId }),
      {
        onEvent: (event) => {
          if (flushed) setHistory((previous) => [...previous, event]);
          else collected.push(event);
        },
        onEose: flush,
      },
    );
    // A lost EOSE must not keep the pacer unseeded forever.
    const timer = setTimeout(flush, OPEN_LOOKUP_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [relay, channelId, author, openedAt]);

  const session = useMemo(() => {
    if (!open) return null;
    const byId = new Map<string, StageEventLike>();
    for (const event of history) byId.set(event.id, event);
    for (const message of liveMessages) {
      const event = stageEventFromTimeline(message);
      if (event) byId.set(event.id, event);
    }
    return reduceStageSession(open, Array.from(byId.values()));
  }, [open, history, liveMessages]);

  const status: StageSessionStatus = session
    ? "ready"
    : openMissing || (open && !session)
      ? "missing"
      : "loading";
  return { session, status, historyLoaded, historyEvents: history };
}
