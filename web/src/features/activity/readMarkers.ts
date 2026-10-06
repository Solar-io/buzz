/**
 * THE read-marker store (LEFT_NAV_ARCHITECTURE_REVIEW.md §3, phase 2).
 *
 * One copy of "how far have I read" per conversation, plus the inbox's
 * per-message overlay, for the whole app. It replaces three copies that
 * were reconciled through localStorage and a window event: repos.tsx's
 * React state, useInboxReadState's re-read-on-focus copy, and the NIP-RS
 * merge writing storage behind both of their backs.
 *
 * Every write goes through here, and every move is recorded in the unread
 * trace with who made it (I3). Local moves are announced to the NIP-RS
 * publisher (readStateSync.ts registers through {@link onLocalChange}), so
 * read state keeps converging across every device — the PWA on a Mac, the
 * iPhone app (same web code) and the desktop app — max-merge, with the
 * relay as the shared copy.
 *
 * Framework-free; React reads it through useReadMarkers.ts.
 */

import {
  forgetChannel,
  loadReadState,
  markSeen as markSeenIn,
  type ReadState,
  saveReadState,
} from "@/features/channels/lib/readState.ts";
import {
  type InboxReadState,
  loadInboxReadState,
  saveInboxReadState,
} from "@/features/home/lib/inboxReadState.ts";
import { type MarkerSource, traceUnread } from "./unreadTrace.ts";

const READ_STATE_STORAGE_KEY = "buzz.read-state.v1";

/** What changed, for listeners that care (the store's own subscribers). */
export type ReadMarkersChange = "local" | "remote" | "storage";

interface State {
  channels: ReadState;
  inbox: InboxReadState;
}

let state: State | null = null;
const listeners = new Set<(change: ReadMarkersChange) => void>();
const localChangeListeners = new Set<() => void>();
let storageListening = false;

function current(): State {
  if (state === null) {
    state = { channels: loadReadState(), inbox: loadInboxReadState() };
    listenToOtherTabs();
  }
  return state;
}

function emit(change: ReadMarkersChange): void {
  for (const listener of listeners) listener(change);
  if (change === "local") {
    for (const listener of localChangeListeners) listener();
  }
}

/** Per-conversation markers (stable reference until one moves). */
export function getChannelMarkers(): ReadState {
  return current().channels;
}

/** The inbox's per-message read/unread overlay. */
export function getInboxMarkers(): InboxReadState {
  return current().inbox;
}

/** Re-render on every change. The listener hears what kind it was. */
export function subscribeReadMarkers(
  listener: (change: ReadMarkersChange) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The NIP-RS publisher's hook: every LOCAL change, persisted. */
export function onLocalChange(listener: () => void): () => void {
  localChangeListeners.add(listener);
  return () => {
    localChangeListeners.delete(listener);
  };
}

/**
 * Advance one conversation's marker to `createdAt` (never backwards).
 * Returns whether it moved.
 */
export function markSeen(
  channelId: string,
  createdAt: number,
  source: MarkerSource,
): boolean {
  const before = current();
  const next = markSeenIn(before.channels, channelId, createdAt);
  if (next === before.channels) {
    return false;
  }
  state = { ...before, channels: next };
  saveReadState(next);
  traceUnread({
    type: "markerMoved",
    id: channelId,
    from: before.channels[channelId] ?? null,
    to: createdAt,
    source,
  });
  emit("local");
  return true;
}

/** Drop a deleted conversation's marker. */
export function forgetMarker(channelId: string): void {
  const before = current();
  const next = forgetChannel(before.channels, channelId);
  if (next === before.channels) {
    return;
  }
  state = { ...before, channels: next };
  saveReadState(next);
  traceUnread({
    type: "markerMoved",
    id: channelId,
    from: before.channels[channelId] ?? null,
    to: null,
    source: "evict",
  });
  emit("local");
}

/** Apply a local change to the inbox overlay (mark read / unread). */
export function updateInboxMarkers(
  update: (previous: InboxReadState) => InboxReadState,
): void {
  const before = current();
  const next = update(before.inbox);
  if (next === before.inbox) {
    return;
  }
  state = { ...before, inbox: next };
  saveInboxReadState(next);
  emit("local");
}

/**
 * Apply an NIP-RS merge (already max-merged by the caller against
 * {@link getChannelMarkers} / {@link getInboxMarkers}). `sources` names the
 * install behind each advanced conversation marker, for the trace.
 * Returns whether anything advanced.
 */
export function applyRemoteMarkers(
  merged: { channels: ReadState; inbox: InboxReadState },
  sources: Record<string, string>,
): boolean {
  const before = current();
  const channelsMoved = merged.channels !== before.channels;
  const inboxMoved = merged.inbox !== before.inbox;
  if (!channelsMoved && !inboxMoved) {
    return false;
  }
  state = { channels: merged.channels, inbox: merged.inbox };
  if (channelsMoved) {
    saveReadState(merged.channels);
    traceMoves(before.channels, merged.channels, (id) =>
      sourceLabel(sources[id]),
    );
  }
  if (inboxMoved) {
    saveInboxReadState(merged.inbox);
  }
  emit("remote");
  return true;
}

function sourceLabel(source: string | undefined): MarkerSource {
  return (source ?? "sync:unknown") as `sync:${string}`;
}

function traceMoves(
  before: ReadState,
  after: ReadState,
  sourceOf: (id: string) => MarkerSource,
): void {
  for (const [id, to] of Object.entries(after)) {
    const from = before[id];
    if (from === to) {
      continue;
    }
    traceUnread({
      type: "markerMoved",
      id,
      from: from ?? null,
      to,
      source: sourceOf(id),
    });
  }
}

/**
 * Another tab of this browser wrote localStorage: max-merge its markers in
 * (they are grow-only, so taking the larger value is always right) and
 * take its inbox overlay as written.
 */
function listenToOtherTabs(): void {
  if (storageListening || typeof window === "undefined") {
    return;
  }
  if (typeof window.addEventListener !== "function") {
    return;
  }
  storageListening = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    if (state === null) {
      return;
    }
    if (event.key === READ_STATE_STORAGE_KEY) {
      const theirs = loadReadState();
      let merged: ReadState | null = null;
      for (const [id, marker] of Object.entries(theirs)) {
        if (marker > (state.channels[id] ?? 0)) {
          merged ??= { ...state.channels };
          merged[id] = marker;
        }
      }
      if (merged !== null) {
        traceMoves(state.channels, merged, () => "storage");
        state = { ...state, channels: merged };
        emit("storage");
      }
      return;
    }
    if (event.key?.startsWith("buzz.inbox-read")) {
      state = { ...state, inbox: loadInboxReadState() };
      emit("storage");
    }
  });
}

/** Tests only: drop the cached copy so the next read reloads storage. */
export function resetReadMarkersForTests(): void {
  state = null;
  storageListening = false;
}
