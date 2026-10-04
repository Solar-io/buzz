import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { ownPubkey } from "@/shared/lib/nostr-signer";
import {
  noteOwnMessage,
  OWN_MESSAGE_KINDS,
  type OwnLastSent,
} from "./ownActivity.ts";
import type { RankFacts } from "./sectionOrder.ts";
import {
  loadVisitScores,
  recordVisit,
  saveVisitScores,
  type VisitScores,
} from "./visitFrequency.ts";

/*
 * React glue for the Favorites / Channels ordering. The ranking itself is
 * pure (sectionOrder.ts, visitFrequency.ts); this file only holds state.
 */

// One in-memory copy shared by every sidebar instance (the shell mounts a
// desktop and a phone copy), persisted on each write.
let scores: VisitScores | null = null;
const listeners = new Set<() => void>();

function currentScores(): VisitScores {
  if (scores === null) scores = loadVisitScores();
  return scores;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Count one open of a sidebar item (channel/DM/forum id or `link:<id>`). */
export function noteSidebarVisit(key: string, now = Date.now()): void {
  scores = recordVisit(currentScores(), key, now);
  saveVisitScores(scores);
  for (const listener of listeners) listener();
}

/** Live visit scores; re-renders on every recorded visit. */
export function useVisitScores(): VisitScores {
  return useSyncExternalStore(subscribe, currentScores, currentScores);
}

/**
 * Count a visit each time the open conversation changes — whatever path
 * opened it (sidebar, toast, search, permalink, landing). Mounted ONCE, at
 * the shell, so the two sidebar copies never double-count.
 */
export function useRecordConversationVisits(selectedId: string | undefined) {
  useEffect(() => {
    if (selectedId) noteSidebarVisit(selectedId);
  }, [selectedId]);
}

/**
 * The open item's rank facts as they were when it was opened. Captured
 * during the render that first sees the new id — before the route's
 * read-marker effect clears its unread state and before the visit above
 * bumps its score — so the row stays exactly where it was clicked.
 */
export function useOpenItemSnapshot(
  selectedId: string | undefined,
  factsOf: (key: string) => RankFacts | undefined,
): { key: string; facts: RankFacts } | null {
  const [snapshot, setSnapshot] = useState<{
    key: string | undefined;
    facts: RankFacts | undefined;
  }>(() => ({
    key: selectedId,
    facts: selectedId ? factsOf(selectedId) : undefined,
  }));
  let current = snapshot;
  // A new selection, or one whose row only just appeared: capture now.
  if (
    current.key !== selectedId ||
    (selectedId !== undefined && current.facts === undefined)
  ) {
    const facts = selectedId ? factsOf(selectedId) : undefined;
    if (current.key !== selectedId || facts !== undefined) {
      current = { key: selectedId, facts };
      setSnapshot(current);
    }
  }
  return current.key !== undefined && current.facts !== undefined
    ? { key: current.key, facts: current.facts }
    : null;
}

/**
 * Pointer-hold for a list's order: while `holding`, the returned keys are the
 * ones last shown before the hold began; otherwise the live keys (which also
 * become the next hold's baseline).
 */
export function useHeldKeys(
  liveKeys: readonly string[],
  holding: boolean,
): readonly string[] | null {
  const last = useRef<readonly string[]>(liveKeys);
  if (!holding) {
    last.current = liveKeys;
    return null;
  }
  return last.current;
}

/**
 * Newest own message per conversation, live from the relay (ownActivity.ts).
 * Author-scoped, so sends from any device land here; the subscription stays
 * open after the backlog, so a new send re-ranks immediately.
 */
export function useOwnLastSent(): OwnLastSent {
  const { session, status } = useRelaySession();
  const [last, setLast] = useState<OwnLastSent>(() => new Map());
  useEffect(() => {
    if (!session || status !== "open") {
      return;
    }
    let alive = true;
    let cleanup: (() => void) | null = null;
    void ownPubkey().then((pubkey) => {
      if (!alive || !pubkey) {
        return;
      }
      cleanup = session.subscribe(
        { kinds: [...OWN_MESSAGE_KINDS], authors: [pubkey], limit: 500 },
        {
          onEvent: (event) => {
            setLast((previous) => noteOwnMessage(previous, event));
          },
        },
      );
    });
    return () => {
      alive = false;
      cleanup?.();
    };
  }, [session, status]);
  return last;
}
