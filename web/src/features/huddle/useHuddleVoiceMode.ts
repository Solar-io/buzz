import { useCallback, useEffect, useRef, useState } from "react";
import {
  bridgeErrorMessage,
  parseBridgeEvent,
  PcmBatcher,
  sttBridgeUrl,
} from "./lib/sttBridge.ts";
import {
  DUPLICATE_WINDOW,
  gateFinalTranscript,
  nextVoiceStatus,
  type VoiceModeStatus,
} from "./lib/voiceTranscript.ts";

/**
 * Huddle voice mode: the viewer's speech becomes channel messages.
 *
 * Engine: the server-side STT bridge (`lib/sttBridge.ts` holds the pure
 * client logic — URL, PCM batching, event parsing, error mapping). One
 * WebSocket per session carries mic PCM upstream — tapped from
 * `useHuddleAudio`'s uplink worklet via `subscribeMicFrames` and batched
 * to PCM16 16 kHz mono — and JSON transcript events downstream. The
 * browser's SpeechRecognition this replaces failed fatally (`network`) on
 * the target browser: Brave's speech engine cannot reach its backing
 * service, so recognition moved server-side.
 *
 * Outgoing audio is held until the bridge's first `{"type":"ready"}` (the
 * upstream session ack) and is sent only while the huddle mic is live
 * (`micLive`: not muted, and push-to-talk held in PTT mode). Frames that
 * arrive while the mic is dark still flow through the batcher — that
 * keeps batch boundaries aligned — but are never sent, and a rising
 * mic-live edge starts a fresh batcher so nothing captured while dark can
 * ride into the first live batch. Muted must never publish transcripts;
 * the old browser engine ignored huddle mute, which was a latent privacy
 * bug, not parity to preserve.
 *
 * Finals run through `gateFinalTranscript` + the DUPLICATE_WINDOW dedupe
 * (`lib/voiceTranscript.ts`) and then `onFinalTranscript` — the caller
 * owns the publish path and error surfacing. Partials surface as
 * `interimText` for display and never publish. The dedupe window survives
 * reconnects, because a resumed session can replay the previous final.
 *
 * Drop handling: a close without a fatal error reconnects after 250 ms,
 * up to 3 attempts per incident (a successful `ready` resets the budget);
 * beyond that the error is surfaced and the toggle latches off — the same
 * UX as a fatal bridge error. A fatal `{"type":"error"}` is terminal: the
 * server closes the connection itself.
 *
 * WebSocket wiring is code-read covered (no component harness exists for
 * React hooks in this app); the batcher, parser, and error mapping are
 * unit-tested in `lib/sttBridge.test.mjs` and the publish gate in
 * `lib/voiceTranscript.test.mjs`. This hook stays thin: connect, gate,
 * reconnect, and clean up on toggle-off/unmount/channel change.
 */

/** Delay before an unexpected drop reconnects (ms). */
const RECONNECT_DELAY_MS = 250;
/** Reconnect attempts per incident before the drop becomes fatal. */
const RECONNECT_ATTEMPTS = 3;

export interface HuddleVoiceMode {
  /**
   * Always true now — the bridge needs only a WebSocket and the huddle's
   * existing mic capture. Kept (and kept honest) so the UI's toggle
   * contract stays stable.
   */
  supported: boolean;
  /** The toggle. Turning it off stops the session and clears interim text. */
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  status: VoiceModeStatus;
  /** Latest interim transcript text, for display only. */
  interimText: string;
  /** Human message for the last fatal bridge error, if any. */
  error: string | null;
}

export function useHuddleVoiceMode(options: {
  /** The huddle channel; null (not connected) disables the hook entirely. */
  channelId: string | null;
  /**
   * Publish one gated final transcript. Called synchronously per final; the
   * caller owns the send path and error surfacing.
   */
  onFinalTranscript: (text: string) => void;
  /**
   * Subscribe to the huddle's mic tap (the uplink worklet's frames, with
   * the capture sample rate). Supplied by `useHuddleAudio`.
   */
  subscribeMicFrames: (
    listener: (frame: Float32Array, sampleRate: number) => void,
  ) => () => void;
  /**
   * Is the huddle mic live (not muted, and push-to-talk held in PTT mode)?
   * While false the hook drains frames but sends nothing to the bridge.
   */
  micLive: boolean;
}): HuddleVoiceMode {
  const { channelId, onFinalTranscript, subscribeMicFrames, micLive } = options;
  const [enabled, setEnabledState] = useState(false);
  const [status, setStatus] = useState<VoiceModeStatus>("idle");
  const [interimText, setInterimText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Live values the socket callbacks read without re-subscribing.
  const onFinalRef = useRef(onFinalTranscript);
  onFinalRef.current = onFinalTranscript;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const micLiveRef = useRef(micLive);
  micLiveRef.current = micLive;

  const transition = useCallback(
    (event: Parameters<typeof nextVoiceStatus>[1]) => {
      setStatus((current) => nextVoiceStatus(current, event));
    },
    [],
  );

  useEffect(() => {
    if (!channelId || !enabled) {
      return;
    }

    let disposed = false;
    let fatal = false;
    /** Audio flows only after the bridge acked the upstream session. */
    let ready = false;
    let attempts = 0;
    let reconnectTimer: number | null = null;
    let batcher = new PcmBatcher();
    let wasMicLive = micLiveRef.current;
    let ws: WebSocket | null = null;
    let recentFinals: string[] = [];

    const connect = () => {
      if (disposed) {
        return;
      }
      transition({ type: "start" });
      const socket = new WebSocket(sttBridgeUrl(window.location.hostname));
      ws = socket;

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
            ready = true;
            // A live session resets the drop budget: a later drop is a new
            // incident, not a continuation of the failed one.
            attempts = 0;
            transition({ type: "audio_started" });
            return;
          case "partial":
            setInterimText(bridgeEvent.text);
            return;
          case "final": {
            const gate = gateFinalTranscript(bridgeEvent.text, recentFinals);
            if (!gate.ok) {
              return;
            }
            recentFinals.push(gate.text);
            if (recentFinals.length > DUPLICATE_WINDOW) {
              recentFinals = recentFinals.slice(-DUPLICATE_WINDOW);
            }
            onFinalRef.current(gate.text);
            return;
          }
          case "done":
            // Clean end after our stop; the server closes next.
            return;
          case "error":
            fatal = true;
            setError(bridgeErrorMessage(bridgeEvent));
            transition({ type: "errored", code: "bridge" });
            // Fatal means the bridge is unusable — clear the UI state so
            // the toggle stops claiming to listen, instead of reconnecting
            // into the same wall. This flips `enabled`, running cleanup.
            setEnabledState(false);
            return;
        }
      };

      socket.onclose = () => {
        if (disposed || fatal || socket !== ws) {
          return;
        }
        transition({ type: "ended" });
        setInterimText("");
        // One connection = one session: the next socket starts cold.
        ready = false;
        batcher = new PcmBatcher();
        if (attempts >= RECONNECT_ATTEMPTS) {
          fatal = true;
          setError(
            "Speech recognition could not reconnect — try turning voice mode on again.",
          );
          transition({ type: "errored", code: "reconnect" });
          setEnabledState(false);
          return;
        }
        attempts += 1;
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          if (disposed || !enabledRef.current) {
            return;
          }
          connect();
        }, RECONNECT_DELAY_MS);
      };

      socket.onerror = () => {
        // A failed connection also fires onclose; the drop policy there is
        // the single place reconnects are decided.
      };
    };

    const unsubscribe = subscribeMicFrames((frame, sampleRate) => {
      // A rising mic-live edge starts a clean batcher, so nothing captured
      // while the mic was dark can ride into the first live batch.
      const live = micLiveRef.current;
      if (live && !wasMicLive) {
        batcher = new PcmBatcher();
      }
      wasMicLive = live;
      const batch = batcher.push(frame, sampleRate);
      if (!batch || !live || !ready) {
        return;
      }
      const socket = ws;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(batch);
      }
    });

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      unsubscribe();
      const socket = ws;
      ws = null;
      if (socket) {
        // Drop handlers first so teardown cannot fire the reconnect path.
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        if (socket.readyState === WebSocket.OPEN) {
          // Flush the sub-batch tail of a live utterance before ending the
          // session — otherwise stopping mid-sentence clips the final <100 ms
          // of speech the batcher is still holding. Only when the mic was
          // live: frames captured while dark never leave the browser.
          if (wasMicLive) {
            const tail = batcher.flush();
            if (tail) {
              socket.send(tail);
            }
          }
          socket.send(JSON.stringify({ type: "stop" }));
        }
        socket.close();
      }
      setInterimText("");
    };
  }, [channelId, enabled, transition, subscribeMicFrames]);

  const setEnabled = useCallback((on: boolean) => {
    if (on) {
      setError(null);
    } else {
      setStatus((current) => nextVoiceStatus(current, { type: "stop" }));
    }
    setEnabledState(on);
  }, []);

  // Leaving the huddle (channelId → null) must latch voice mode off: the
  // toggle unmounts with the call controls, and a rejoin must not resume
  // listening on its own.
  useEffect(() => {
    if (channelId === null) {
      setEnabledState(false);
      setStatus("idle");
    }
  }, [channelId]);

  return { supported: true, enabled, setEnabled, status, interimText, error };
}
