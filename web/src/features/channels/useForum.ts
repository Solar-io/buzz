/**
 * Forum reads: the post list and one post's thread.
 *
 * Split out of `features/channels/hooks.ts` when that file reached the
 * repository's 1000-line ceiling. `hooks.ts` re-exports everything here, so
 * every existing `from "@/features/channels/hooks"` import still resolves.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { SignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  applyOverlay,
  editTargetFromEvent,
  timelineMessageFromEvent,
  upsertMessage,
  type MessageBuffer,
  type TimelineMessage,
} from "./lib/messageBuffer.ts";
import {
  FORUM_COMMENT_KIND,
  FORUM_POST_KIND,
  forumThreadReplies,
  isForumThreadRoot,
} from "./lib/forum.ts";
import {
  mergeRelayThreadSummary,
  relayThreadSummaryFromEvent,
  THREAD_SUMMARY_KIND,
  type RelayThreadSummaryMap,
} from "./lib/threadSummaryEvent.ts";

export interface ForumPostsFeed {
  messages: MessageBuffer;
  /** True until the relay has replayed the channel history (first EOSE). */
  loading: boolean;
  /** Relay thread counters for the posts in view (kind 39005, by root id). */
  threadSummaries: RelayThreadSummaryMap;
  /** Fetch one older page of posts. No-op while busy or exhausted. */
  loadOlder: () => void;
  loadingOlder: boolean;
  /** An older page came back short — the forum's first post is loaded. */
  exhausted: boolean;
}

/**
 * Forum page size. The desktop's `useForumPostsQuery` asks for 50 and pages
 * with `next_cursor`; the web read side pages with a NIP-01 `until` window
 * instead, because the cursor lives on the HTTP bridge and this client
 * speaks only the WebSocket.
 */
const FORUM_PAGE = 50;

/**
 * Forum posts history for one channel: a dedicated roots-deep subscription.
 * Desktop's forum list REQs kind 45001 only; the read side here widens to
 * the chat root kinds (9, 40002, 40008) so live kind-9 thread traffic (the
 * #alerts engine) renders as posts while writes stay desktop-exact 45001.
 * Overlay kinds (5 delete, 40003 edit) ride along so deleting or editing a
 * post tombstones/patches it in this list, not just the main feed window.
 */
export function useForumPosts(channelId: string | null): ForumPostsFeed {
  const { session } = useRelaySession();
  const [buffer, setBuffer] = useState<MessageBuffer>([]);
  const [loading, setLoading] = useState(true);
  const [threadSummaries, setThreadSummaries] = useState<RelayThreadSummaryMap>(
    () => new Map(),
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const loadingOlderRef = useRef(false);

  const applyForumEvent = useCallback(
    (event: SignedNostrEvent) => {
      if (event.kind === THREAD_SUMMARY_KIND) {
        const summary = relayThreadSummaryFromEvent(event);
        if (
          summary &&
          (summary.channelId === null || summary.channelId === channelId)
        ) {
          setThreadSummaries((previous) =>
            mergeRelayThreadSummary(previous, summary),
          );
        }
        return;
      }
      if (event.kind === 40003 || event.kind === 5) {
        const targetId = editTargetFromEvent(event);
        if (targetId) {
          setBuffer((previous) =>
            applyOverlay(
              previous,
              event.kind,
              targetId,
              event.kind === 40003 ? event.content : null,
            ),
          );
        }
        return;
      }
      const message = timelineMessageFromEvent(event);
      if (!message || message.channelId !== channelId) {
        return;
      }
      setBuffer((previous) => upsertMessage(previous, message));
    },
    [channelId],
  );

  useEffect(() => {
    setBuffer([]);
    setLoading(true);
    setThreadSummaries(new Map());
    setExhausted(false);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    if (!channelId) {
      return;
    }
    return session.subscribe(
      {
        kinds: [
          9,
          40002,
          40008,
          FORUM_POST_KIND,
          5,
          40003,
          THREAD_SUMMARY_KIND,
        ],
        "#h": [channelId],
        limit: FORUM_PAGE * 2,
      },
      {
        onEose: () => setLoading(false),
        onEvent: applyForumEvent,
      },
    );
  }, [session, channelId, applyForumEvent]);

  /**
   * One older page. The forum list is newest-first, so "older" walks the
   * `until` window down from the oldest POST on screen — not the oldest
   * event, which could be a recent reply to an ancient post.
   */
  const loadOlder = useCallback(() => {
    if (!channelId || loadingOlderRef.current || exhausted) {
      return;
    }
    const oldestPost = buffer.reduce<number | null>(
      (oldest, message) =>
        isForumThreadRoot(message) &&
        (oldest === null || message.createdAt < oldest)
          ? message.createdAt
          : oldest,
      null,
    );
    if (oldestPost === null || oldestPost <= 1) {
      return;
    }
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    let postCount = 0;
    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      loadingOlderRef.current = false;
      setLoadingOlder(false);
      if (postCount < FORUM_PAGE) {
        setExhausted(true);
      }
    };
    const unsubscribe = session.subscribe(
      {
        kinds: [9, 40002, 40008, FORUM_POST_KIND, 5, 40003],
        "#h": [channelId],
        until: Math.max(0, oldestPost - 1),
        limit: FORUM_PAGE,
      },
      {
        onEvent: (event: SignedNostrEvent) => {
          if (event.kind !== 5 && event.kind !== 40003) {
            postCount++;
          }
          applyForumEvent(event);
        },
        onEose: () => {
          finish();
          unsubscribe();
        },
      },
    );
    // A lost EOSE must not wedge the guard shut forever.
    setTimeout(finish, 10_000);
  }, [channelId, session, buffer, exhausted, applyForumEvent]);

  return {
    messages: buffer,
    loading,
    threadSummaries,
    loadOlder,
    loadingOlder,
    exhausted,
  };
}

export interface ForumThread {
  root: TimelineMessage | null;
  /** Replies in order — kind-9 appends and kind-45003 comments alike. */
  replies: TimelineMessage[];
}

/**
 * One forum thread, fetched with desktop's two REQs (messages/forum.rs): the
 * root by id, then everything referencing it inside the channel. The #e
 * match catches both marker shapes — a nested reply's root marker names the
 * post, as does a first-level comment's reply marker.
 */
export function useForumThread(
  channelId: string | null,
  postId: string | null,
): ForumThread {
  const { session } = useRelaySession();
  const [buffer, setBuffer] = useState<MessageBuffer>([]);

  useEffect(() => {
    setBuffer([]);
    if (!channelId || !postId) {
      return;
    }
    const onEvent = (event: SignedNostrEvent) => {
      const message = timelineMessageFromEvent(event);
      if (!message || message.channelId !== channelId) {
        return;
      }
      setBuffer((previous) => upsertMessage(previous, message));
    };
    const unsubscribeRoot = session.subscribe(
      {
        ids: [postId],
        kinds: [9, 40002, FORUM_POST_KIND, FORUM_COMMENT_KIND],
        limit: 1,
      },
      { onEvent },
    );
    const unsubscribeReplies = session.subscribe(
      {
        kinds: [9, FORUM_COMMENT_KIND],
        "#e": [postId],
        "#h": [channelId],
        limit: 200,
      },
      { onEvent },
    );
    return () => {
      unsubscribeRoot();
      unsubscribeReplies();
    };
  }, [session, channelId, postId]);

  return {
    root: postId ? (buffer.find((m) => m.id === postId) ?? null) : null,
    replies: postId ? forumThreadReplies(buffer, postId) : [],
  };
}
