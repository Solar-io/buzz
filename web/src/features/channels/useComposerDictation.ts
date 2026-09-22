import { useCallback, useEffect, useRef, useState } from "react";
import {
  bridgeErrorMessage,
  parseBridgeEvent,
  PcmBatcher,
} from "@/features/huddle/lib/sttBridge.ts";
import {
  micConstraints,
  WORKLET_SOURCE,
} from "@/features/huddle/lib/huddleAudioGraph.ts";
import { speechServiceUrl } from "@/shared/lib/relay-url";

/**
 * Composer dictation: the mic button on the composer's action row (Sam,
 * 2026-09-22). One click opens the mic and streams speech through the SAME
 * server-side STT bridge the huddle's voice mode uses (`sttBridge.ts` /
 * `speechServiceUrl("stt")`); finalized utterances are appended to the
 * composer draft by the caller, a second click stops.
 *
 * This is a deliberate miniaturization of `useHuddleVoiceMode`, not a reuse
 * of it: the huddle hook taps the call's already-captured mic, publishes
 * transcripts as channel messages, and carries echo suppression for the
 * avatar's own voice — none of which apply to a composer that owns no call
 * and no agent speech. What IS shared is the wire contract (ready-gated PCM16
 * batches, final/partial events, stop-then-close teardown), which is why the
 * batcher, parser and error mapping are imported from `sttBridge.ts` rather
 * than restated here.
 *
 * Simplifications that are honest about their scope:
 *  - one connection per activation — an unexpected drop stops dictation with
 *    the error on the toast, rather than the huddle's reconnect ladder;
 *  - no VAD gating or duplicate window — the composer's finals are editable
 *    text a wrong transcript can be fixed in, unlike a published message.
 */

export interface ComposerDictation {
  /** False where the browser offers no mic capture (render no button). */
  supported: boolean;
  /** Connecting or listening — the button's pressed state. */
  active: boolean;
  /** Live interim transcript, for display only. */
  interimText: string;
  /** Last fatal error, surfaced by the caller as a toast. */
  error: string | null;
  /** The toggle: start when idle, stop otherwise. */
  toggle: () => void;
}

interface DictationSession {
  ctx: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  worklet: AudioWorkletNode;
  socket: WebSocket;
  batcher: PcmBatcher;
  /** The bridge acked the upstream session — audio may flow only after. */
  ready: boolean;
  workletUrl: string;
}

export function useComposerDictation(options: {
  /** Append one finalized utterance to the composer draft. */
  onFinalTranscript: (text: string) => void;
}): ComposerDictation {
  const [supported] = useState(
    () =>
      typeof navigator !== "undefined" &&
      navigator.mediaDevices?.getUserMedia !== undefined &&
      typeof window !== "undefined" &&
      typeof window.AudioContext !== "undefined",
  );
  const [active, setActive] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<DictationSession | null>(null);
  /**
   * Bumped by every stop/unmount. `start()` captures the value before its
   * first await and abandons its work if it changed — a stop that lands while
   * the permission prompt is still up must not leave an orphan session
   * running (a mic the user thinks is closed is a privacy bug, not a UX one).
   */
  const generationRef = useRef(0);
  const onFinalRef = useRef(options.onFinalTranscript);
  onFinalRef.current = options.onFinalTranscript;

  const teardownSession = useCallback((session: DictationSession) => {
    session.worklet.port.onmessage = null;
    session.socket.onmessage = null;
    session.socket.onclose = null;
    session.socket.onerror = null;
    try {
      session.worklet.port.close();
      session.worklet.disconnect();
      session.source.disconnect();
    } catch {
      // A node that never finished connecting — nothing to disconnect.
    }
    if (session.socket.readyState === WebSocket.OPEN) {
      // Flush the sub-batch tail of a live utterance, exactly like the
      // huddle's teardown: without it, stopping mid-sentence clips the
      // final <100 ms of speech the batcher is still holding.
      const tail = session.batcher.flush();
      if (tail && session.ready) {
        session.socket.send(tail);
      }
      session.socket.send(JSON.stringify({ type: "stop" }));
    }
    session.socket.close();
    for (const track of session.stream.getTracks()) {
      track.stop();
    }
    void session.ctx.close().catch(() => {});
    URL.revokeObjectURL(session.workletUrl);
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    const session = sessionRef.current;
    sessionRef.current = null;
    setActive(false);
    setInterimText("");
    if (session) {
      teardownSession(session);
    }
  }, [teardownSession]);

  const start = useCallback(async () => {
    const generation = generationRef.current;
    setError(null);
    setActive(true);
    let partial: Partial<DictationSession> | null = {};
    const abandonPartial = () => {
      if (!partial) {
        return;
      }
      for (const track of partial.stream?.getTracks() ?? []) {
        track.stop();
      }
      void partial.ctx?.close().catch(() => {});
      if (partial.workletUrl) {
        URL.revokeObjectURL(partial.workletUrl);
      }
      partial.socket?.close();
      partial = null;
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micConstraints(""),
      });
      if (generationRef.current !== generation) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
      const ctx = new AudioContext();
      partial = { ...partial, ctx, stream };
      const workletUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
      );
      partial = { ...partial, workletUrl };
      await ctx.audioWorklet.addModule(workletUrl);
      const worklet = new AudioWorkletNode(ctx, "uplink-tap");
      const source = ctx.createMediaStreamSource(stream);
      const socket = new WebSocket(speechServiceUrl("stt"));
      socket.binaryType = "arraybuffer";
      const batcher = new PcmBatcher();
      const session: DictationSession = {
        ctx,
        stream,
        source,
        worklet,
        socket,
        batcher,
        ready: false,
        workletUrl,
      };
      partial = null;

      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") {
          return;
        }
        const bridgeEvent = parseBridgeEvent(event.data);
        if (!bridgeEvent) {
          return;
        }
        switch (bridgeEvent.type) {
          case "ready":
            session.ready = true;
            return;
          case "partial":
            setInterimText(bridgeEvent.text);
            return;
          case "final":
            setInterimText("");
            onFinalRef.current(bridgeEvent.text);
            return;
          case "done":
            return;
          case "error":
            setError(bridgeErrorMessage(bridgeEvent));
            if (sessionRef.current === session) {
              stop();
            }
            return;
        }
      };

      socket.onclose = () => {
        // A close we did not order (our stop nulls the session first) ends
        // dictation with the failure said out loud — never a live button
        // over a dead socket.
        if (sessionRef.current === session) {
          setError("Speech recognition connection closed.");
          stop();
        }
      };

      worklet.port.onmessage = (event: MessageEvent) => {
        const frame = event.data as Float32Array;
        const batch = batcher.push(frame, ctx.sampleRate);
        if (!batch || !session.ready) {
          return;
        }
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(batch);
        }
      };

      // Source → worklet and nothing else: the dictation mic must never
      // loop back to the speakers.
      source.connect(worklet);
      sessionRef.current = session;
    } catch (cause) {
      abandonPartial();
      if (generationRef.current !== generation) {
        return;
      }
      const message =
        cause instanceof Error && cause.message
          ? cause.message
          : "Could not start dictation.";
      setError(
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Microphone access was denied."
          : message,
      );
      setActive(false);
    }
  }, [stop]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) {
        teardownSession(session);
      }
    };
  }, [teardownSession]);

  return {
    supported,
    active,
    interimText,
    error,
    toggle: () => {
      if (sessionRef.current === null && !active) {
        void start();
      } else {
        stop();
      }
    },
  };
}
