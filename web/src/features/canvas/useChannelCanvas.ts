import { useEffect, useState } from "react";

import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import {
  type ChannelCanvasDoc,
  type ChannelCanvasPhase,
  canvasFromEvent,
  channelCanvasFilter,
  newerCanvas,
} from "./lib/channelCanvas.ts";

/**
 * Last known canvas per conversation, for this page's lifetime: coming back
 * to a channel shows its canvas at once while the REQ refreshes it.
 */
const known = new Map<string, ChannelCanvasDoc | null>();

interface CanvasState {
  channelId: string | null;
  doc: ChannelCanvasDoc | null;
  phase: ChannelCanvasPhase;
}

function initial(channelId: string | null): CanvasState {
  if (channelId === null) {
    return { channelId, doc: null, phase: "idle" };
  }
  return known.has(channelId)
    ? { channelId, doc: known.get(channelId) ?? null, phase: "ready" }
    : { channelId, doc: null, phase: "loading" };
}

/**
 * The conversation's channel canvas (kind 40100), live: one REQ per
 * conversation, scoped by `#h` so a `buzz canvas set` lands while the
 * viewer is reading. `channelId` null (no conversation, or the pane is not
 * docked) asks nothing.
 */
export function useChannelCanvas(channelId: string | null): {
  doc: ChannelCanvasDoc | null;
  phase: ChannelCanvasPhase;
} {
  const { session, status } = useRelaySession();
  const [state, setState] = useState<CanvasState>(() => initial(channelId));

  useEffect(() => {
    setState(initial(channelId));
    if (channelId === null || status === "idle") {
      return;
    }
    const ready = () =>
      setState((previous) => {
        if (previous.channelId !== channelId) {
          return previous;
        }
        known.set(channelId, previous.doc);
        return previous.phase === "ready"
          ? previous
          : { ...previous, phase: "ready" };
      });
    const unsubscribe = session.subscribe(channelCanvasFilter(channelId), {
      onEvent: (event) => {
        const doc = canvasFromEvent(event, channelId);
        if (doc === null) {
          return;
        }
        setState((previous) => {
          if (previous.channelId !== channelId) {
            return previous;
          }
          const next = newerCanvas(previous.doc, doc);
          if (next === previous.doc) {
            return previous;
          }
          if (previous.phase === "ready") {
            known.set(channelId, next);
          }
          return { ...previous, doc: next };
        });
      },
      onEose: ready,
    });
    const fallback = setTimeout(ready, 8_000);
    return () => {
      clearTimeout(fallback);
      unsubscribe();
    };
  }, [session, status, channelId]);

  // Between a switch and the effect, the state still belongs to the last
  // conversation: answer for this one instead.
  return state.channelId === channelId ? state : initial(channelId);
}
