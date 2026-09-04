/**
 * Relay and storage wiring for the home inbox. The derivations themselves are
 * pure and live in `lib/` — this file only opens subscriptions and owns state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import { timelineMessageFromEvent } from "@/features/channels/lib/messageBuffer.ts";
import {
  loadReadState,
  type ReadState,
} from "@/features/channels/lib/readState.ts";
import { inboxRequests } from "./lib/inboxQuery.ts";
import {
  loadInboxReadState,
  markInboxMessagesRead,
  markInboxMessagesUnread,
  saveInboxReadState,
  type InboxReadState,
} from "./lib/inboxReadState.ts";

/**
 * Coalesce relay bursts into one render. The initial replay delivers up to a
 * few hundred events back to back; without this each one re-sorts the list.
 */
const FLUSH_MS = 80;

export interface InboxFeed {
  /** Every inbox-eligible message seen, unordered — `buildInboxItems` sorts. */
  messages: TimelineMessage[];
  /** True until the relay has replayed history (first EOSE on any request). */
  loading: boolean;
}

/**
 * Messages addressed to the viewer across every channel.
 *
 * Populated by {@link inboxRequests} — a global `#p` query for stored
 * mentions, an `#h`-scoped `#p` query for live ones, and an `#h` query over
 * the viewer's DM channels. Read that module before changing the filters:
 * the split into separate REQs is what keeps the live half alive.
 */
export function useInboxMessages(options: {
  selfPubkey: string | null;
  channels: ChannelSummary[];
}): InboxFeed {
  const { selfPubkey, channels } = options;
  const { session } = useRelaySession();

  const bufferRef = useRef(new Map<string, TimelineMessage>());
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Channel ids are UUIDs, so a joined string is a lossless set key: the REQs
  // reopen when the SET changes, not on every channel-list re-render.
  const watchedKey = useMemo(
    () =>
      channels
        .filter((channel) => !channel.archived)
        .map((channel) => channel.id)
        .sort()
        .join(","),
    [channels],
  );
  const dmKey = useMemo(
    () =>
      channels
        .filter((channel) => channel.type === "dm" && !channel.archived)
        .map((channel) => channel.id)
        .sort()
        .join(","),
    [channels],
  );

  useEffect(() => {
    bufferRef.current = new Map();
    setMessages([]);
    setLoading(true);
    if (!selfPubkey) {
      setLoading(false);
      return;
    }

    const scheduleFlush = () => {
      if (flushTimer.current) {
        return;
      }
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        setMessages(Array.from(bufferRef.current.values()));
      }, FLUSH_MS);
    };

    const onEvent = (event: SignedNostrEvent) => {
      const message = timelineMessageFromEvent(event);
      if (!message) {
        return;
      }
      const existing = bufferRef.current.get(message.id);
      if (existing && existing.createdAt === message.createdAt) {
        return;
      }
      bufferRef.current.set(message.id, message);
      scheduleFlush();
    };

    const requests = inboxRequests({
      selfPubkey,
      channelIds: watchedKey ? watchedKey.split(",") : [],
      dmChannelIds: dmKey ? dmKey.split(",") : [],
      since: Math.floor(Date.now() / 1_000),
    });
    const unsubscribes = requests.map((request) =>
      session.subscribe(request, {
        onEvent,
        onEose: () => setLoading(false),
      }),
    );
    // A relay that never answers must not leave the pane on a skeleton.
    const loadingGuard = setTimeout(() => setLoading(false), 10_000);

    return () => {
      clearTimeout(loadingGuard);
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [session, selfPubkey, watchedKey, dmKey]);

  return { messages, loading };
}

export interface InboxReadStateApi {
  /** Per-channel markers, shared with the sidebar and channel timeline. */
  channelRead: ReadState;
  /** Per-message overlay owned by the inbox. */
  inboxRead: InboxReadState;
  markRead: (messages: readonly TimelineMessage[]) => void;
  markUnread: (messages: readonly TimelineMessage[]) => void;
}

/**
 * The inbox's read state.
 *
 * The channel markers are re-read when the tab regains focus because the
 * channel view writes them from a different route; without that, opening a
 * channel in another tab (or navigating back) would leave the inbox claiming
 * messages are unread that the viewer has plainly read.
 */
export function useInboxReadState(): InboxReadStateApi {
  const [channelRead, setChannelRead] = useState<ReadState>(() =>
    loadReadState(),
  );
  const [inboxRead, setInboxRead] = useState<InboxReadState>(() =>
    loadInboxReadState(),
  );

  useEffect(() => {
    const reread = () => {
      setChannelRead(loadReadState());
      setInboxRead(loadInboxReadState());
    };
    window.addEventListener("focus", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      window.removeEventListener("focus", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, []);

  const markRead = useCallback((messages: readonly TimelineMessage[]) => {
    setInboxRead((previous) => {
      const next = markInboxMessagesRead(previous, messages);
      if (next !== previous) {
        saveInboxReadState(next);
      }
      return next;
    });
  }, []);

  const markUnread = useCallback((messages: readonly TimelineMessage[]) => {
    setInboxRead((previous) => {
      const next = markInboxMessagesUnread(previous, messages);
      if (next !== previous) {
        saveInboxReadState(next);
      }
      return next;
    });
  }, []);

  return { channelRead, inboxRead, markRead, markUnread };
}
