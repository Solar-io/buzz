import { useSyncExternalStore } from "react";
import type { ReadState } from "@/features/channels/lib/readState.ts";
import type { InboxReadState } from "@/features/home/lib/inboxReadState.ts";
import {
  getChannelMarkers,
  getInboxMarkers,
  subscribeReadMarkers,
} from "./readMarkers.ts";

/** Per-conversation read markers, live (local, NIP-RS and other tabs). */
export function useChannelMarkers(): ReadState {
  return useSyncExternalStore(
    subscribeReadMarkers,
    getChannelMarkers,
    getChannelMarkers,
  );
}

/** The inbox's per-message overlay, live. */
export function useInboxMarkers(): InboxReadState {
  return useSyncExternalStore(
    subscribeReadMarkers,
    getInboxMarkers,
    getInboxMarkers,
  );
}
