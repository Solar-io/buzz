import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelSummary } from "@/features/channels/lib/channelFromEvent.ts";
import type { ReadState } from "@/features/channels/lib/readState.ts";
import { useDms } from "@/features/dms/hooks";
import {
  timelineStore,
  warmTap,
} from "@/features/channels/lib/timelineStore.ts";
import {
  type ActivitySession,
  type ConversationActivitySnapshot,
  type ConversationActivityStore,
  createConversationActivityStore,
} from "./conversationActivity.ts";

/** Warm tap: every kind-9 the feed carries lands in the timeline store. */
const warmFromActivity = warmTap(timelineStore, "activity");

/**
 * Mount THE conversation-activity feed. Called once, at the shell
 * (repos.tsx); everything else reads the returned store.
 *
 * Re-subscribes only when the session, either id set or the viewer change —
 * never on a marker move: a move zeroes and recounts the moved
 * conversations against the windows already open (the per-move re-REQ of
 * every window cost ~1.1 MB per channel switch, background-sync plan §4.1).
 */
export function useConversationActivityFeed({
  session,
  dmIds,
  channelIds,
  selfPubkey,
  readMarkers,
}: {
  session: ActivitySession | null;
  /** DM ids: opened first (the landing pick waits on them). */
  dmIds: readonly string[];
  /** Every other conversation the rail can show. */
  channelIds: readonly string[];
  selfPubkey: string | null;
  readMarkers: ReadState;
}): ConversationActivityStore {
  const markersRef = useRef(readMarkers);
  markersRef.current = readMarkers;
  const [store] = useState(() =>
    createConversationActivityStore({
      readMarkers: () => markersRef.current,
      onRawEvent: warmFromActivity,
    }),
  );
  const dmKey = [...dmIds].sort().join(",");
  const channelKey = [...channelIds].sort().join(",");
  useEffect(() => {
    store.setFeed({
      session,
      criticalIds: dmKey ? dmKey.split(",") : [],
      ids: channelKey ? channelKey.split(",") : [],
      selfPubkey,
    });
  }, [store, session, dmKey, channelKey, selfPubkey]);
  useEffect(() => () => store.dispose(), [store]);

  const previousMarkers = useRef(readMarkers);
  useEffect(() => {
    const previous = previousMarkers.current;
    previousMarkers.current = readMarkers;
    if (previous !== readMarkers) {
      store.markersMoved(previous, readMarkers);
    }
  }, [store, readMarkers]);
  return store;
}

/**
 * The shell's whole activity wiring in one call: THE feed over every
 * conversation the rail can show (DMs first; archived channels stay out of
 * the REQ — same filter NotificationRuntime applies), its live state, and
 * the DM list derived from it.
 */
export function useShellConversationActivity({
  session,
  channels,
  selfPubkey,
  readMarkers,
}: {
  session: ActivitySession | null;
  channels: ChannelSummary[];
  selfPubkey: string | null;
  readMarkers: ReadState;
}) {
  const { dmIds, channelIds } = useMemo(
    () => ({
      dmIds: channels.filter((c) => c.type === "dm").map((c) => c.id),
      channelIds: channels
        .filter((c) => c.type !== "dm" && !c.archived)
        .map((c) => c.id),
    }),
    [channels],
  );
  const store = useConversationActivityFeed({
    session,
    dmIds,
    channelIds,
    selfPubkey,
    readMarkers,
  });
  const state = useConversationActivity(store);
  const { dms, channelsWithoutDms } = useDms(channels, state.activity);
  return { store, state, dms, channelsWithoutDms };
}

/** The store's current state, re-rendering on every change. */
export function useConversationActivity(
  store: ConversationActivityStore,
): ConversationActivitySnapshot {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
