import * as React from "react";

import {
  computeRms,
  createDuckGate,
  DEFAULT_DUCK_GATE_CONFIG,
  stepDuckGate,
  type DuckGateConfig,
  type DuckGateState,
} from "./duckGate";

/**
 * How often the persona-audio analyser is sampled. Well under the 300ms
 * attack window, cheap enough to run for the whole call.
 */
const SAMPLE_INTERVAL_MS = 50;

/**
 * SDK turn-stream events, as their literal wire values (verified against
 * `AnamEvent` in @anam-ai/js-sdk). Kept as literals so this module — and its
 * node-run unit tests — stay free of an SDK import; `DuckMuteClient` stays
 * structural for the same reason.
 */
export const PERSONA_TURN_STREAM_EVENT = "MESSAGE_STREAM_EVENT_RECEIVED";
export const PERSONA_INTERRUPTED_EVENT = "TALK_STREAM_INTERRUPTED";

/**
 * The slice of the Anam client the duck loop needs, stated structurally so
 * tests can pass a recording fake instead of the real SDK client. The
 * optional listener pair is the SDK's public event subscription; the real
 * `AnamClient` satisfies it.
 */
export interface DuckMuteClient {
  muteInputAudio: () => unknown;
  unmuteInputAudio: () => unknown;
  addListener?(event: string, cb: (payload: unknown) => void): unknown;
  removeListener?(event: string, cb: (payload: unknown) => void): unknown;
}

/**
 * Barge-in auto-duck for the video-chat persona.
 *
 * Turn-keyed first: while `enabled` (state === "live") and the client exposes
 * the SDK event surface, the persona's message-stream events key the duck —
 * a persona event without endOfSpeech opens her turn (mic muted at the SDK
 * layer), endOfSpeech or a talk-stream interruption closes it. A
 * `turnFailsafeMs` window reopens the mic when events stop arriving, so a
 * dropped endOfSpeech can never strand the mute.
 *
 * The WebAudio RMS gate is the fallback floor under the turn signal: the
 * persona <audio> element is routed through an analyser (source → analyser →
 * destination: the element MUST be re-connected to the destination or
 * playback can stop in some webviews) and its RMS drives the `duckGate`
 * state machine. The loop runs even when the analyser graph cannot be built,
 * degrading to turn-only ducking. The effective mute is the COMBINED value —
 * turn-active OR gate-closed — fed to a single writer.
 *
 * The manual mute button is the user's floor: a manually muted mic is never
 * unmuted by the gate. The SDK client's real mute state always converges to
 * `!micOn || combinedDucked` — see `applyDesiredMute`, the single writer.
 *
 * `duckingEnabled` is the user's setting and is deliberately separate from
 * `enabled` (whose false means "no live call", a state where client calls
 * are pointless): turning ducking off mid-call must actively restore the
 * mic, which a settings flip inside `enabled` would never do.
 *
 * Outside a live call this hook does nothing: no loop, no AudioContext, no
 * client calls.
 */
export function useBargeDuck(params: {
  /** True only while the call is live. */
  enabled: boolean;
  /** The user's auto-duck setting; false stands the gate down mid-call. */
  duckingEnabled?: boolean;
  /** Manual mute state — false is the user's floor over the gate. */
  micOn: boolean;
  /** The persona audio element to analyse. */
  audioElement: HTMLAudioElement | null;
  /** Live Anam client, or null whenever there is nothing to drive. */
  client: DuckMuteClient | null;
  config?: DuckGateConfig;
}): boolean {
  const { enabled, duckingEnabled = true, micOn, audioElement, client } =
    params;
  const [ducked, setDucked] = React.useState(false);

  // Ref mirrors so the rAF loop and the mute writer never run against a
  // stale closure, and so the mute floor survives across renders.
  const micOnRef = React.useRef(micOn);
  micOnRef.current = micOn;
  const configRef = React.useRef<DuckGateConfig>(
    params.config ?? DEFAULT_DUCK_GATE_CONFIG,
  );
  configRef.current = params.config ?? DEFAULT_DUCK_GATE_CONFIG;
  const gateRef = React.useRef<DuckGateState>(createDuckGate());
  const gateDuckedRef = React.useRef(false);
  // Turn-keyed state: is the persona's turn open (no endOfSpeech yet), and
  // when her last stream event arrived (drives the dropped-event failsafe).
  const turnOpenRef = React.useRef(false);
  const lastPersonaEventAtRef = React.useRef(Number.NEGATIVE_INFINITY);
  // What we last told the SDK client to be — the dedupe guard that keeps
  // every transition a single SDK call.
  const appliedMutedRef = React.useRef(false);

  const applyDesiredMute = React.useCallback(
    (micOnNow: boolean, gateDucked: boolean) => {
      const wantMuted = !micOnNow || gateDucked;
      if (appliedMutedRef.current === wantMuted) return;
      appliedMutedRef.current = wantMuted;
      if (!client) return;
      try {
        if (wantMuted) client.muteInputAudio();
        else client.unmuteInputAudio();
      } catch {
        // Mic state changes outside a live session are harmless to
        // ignore (same posture as the manual toggle).
        appliedMutedRef.current = !wantMuted;
      }
    },
    [client],
  );

  // Turn-keyed ducking: the SDK announces the persona's turn boundaries.
  // Mounted whenever a live, duck-enabled call has a client that exposes the
  // event surface; purely structural, so tests can fire the callbacks.
  React.useEffect(() => {
    if (!enabled || !duckingEnabled) return;
    const { addListener, removeListener } = client ?? {};
    if (!addListener || !removeListener) return;
    const onStreamEvent = (payload: unknown) => {
      const evt = payload as { role?: string; endOfSpeech?: boolean } | null;
      if (!evt || typeof evt.role !== "string") return;
      if (evt.role.toLowerCase() !== "persona") return;
      turnOpenRef.current = !evt.endOfSpeech;
      // Same clock the rAF timestamps use, so the failsafe window in the
      // tick compares like against like.
      lastPersonaEventAtRef.current = performance.now();
    };
    const onInterrupted = () => {
      turnOpenRef.current = false;
    };
    addListener(PERSONA_TURN_STREAM_EVENT, onStreamEvent);
    addListener(PERSONA_INTERRUPTED_EVENT, onInterrupted);
    return () => {
      removeListener(PERSONA_TURN_STREAM_EVENT, onStreamEvent);
      removeListener(PERSONA_INTERRUPTED_EVENT, onInterrupted);
    };
  }, [enabled, duckingEnabled, client]);

  // The duck loop — mounted only for a live call with the setting on.
  React.useEffect(() => {
    if (!enabled) return;

    if (!duckingEnabled) {
      // Setting off mid-call: undo the gate's mute NOW (a settings flip
      // inside `enabled` would leave the mic SDK-muted with no loop left
      // to reopen it) and stand down. Converges to `!micOn` THROUGH the
      // dedupe guard — resetting it here would re-issue a mute the SDK
      // is already in, and the guard is also what keeps a manual mute
      // from being unmuted by this restore.
      gateRef.current = createDuckGate();
      gateDuckedRef.current = false;
      turnOpenRef.current = false;
      lastPersonaEventAtRef.current = Number.NEGATIVE_INFINITY;
      setDucked(false);
      applyDesiredMute(micOnRef.current, false);
      return;
    }

    // A fresh session means a fresh SDK client (input unmuted) and a
    // fresh gate. Reconcile both up front: this is what restores mute
    // on a restarted call whose manual mute survived (micOn stays
    // false), and what leaves an open mic untouched.
    gateRef.current = createDuckGate();
    gateDuckedRef.current = false;
    appliedMutedRef.current = false;
    turnOpenRef.current = false;
    lastPersonaEventAtRef.current = Number.NEGATIVE_INFINITY;
    setDucked(false);
    applyDesiredMute(micOnRef.current, false);

    if (!audioElement) return;

    let ctx: AudioContext | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let buffer: Float32Array<ArrayBuffer> | null = null;
    try {
      ctx = new AudioContext();
      source = ctx.createMediaElementSource(audioElement);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      // Keep the element audible: WebAudio does not tap a media
      // element's existing output, so the graph must reach the
      // destination or the persona goes silent.
      analyser.connect(ctx.destination);
      buffer = new Float32Array(analyser.fftSize);
    } catch {
      // Analyser unavailable — degrade to turn-only ducking: the loop
      // below still runs so SDK turn events keep driving the mute.
      void ctx?.close().catch(() => undefined);
      ctx = null;
      source = null;
      analyser = null;
      buffer = null;
    }

    let raf = 0;
    let lastSampleAt = Number.NEGATIVE_INFINITY;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
      lastSampleAt = now;

      // Turn state is primary: her turn is open AND a stream event arrived
      // within the failsafe window. An open turn that goes silent past
      // turnFailsafeMs reopens anyway — a dropped endOfSpeech must never
      // strand the mic closed.
      const turnActive =
        turnOpenRef.current &&
        now - lastPersonaEventAtRef.current <
          configRef.current.turnFailsafeMs;

      const analyserNode = analyser;
      const samples = buffer;
      // The RMS machine stays a pure function of audio energy; the turn
      // signal combines above it, never inside it.
      let combined: boolean;
      if (analyserNode && samples) {
        analyserNode.getFloatTimeDomainData(samples);
        const step = stepDuckGate(
          gateRef.current,
          computeRms(samples),
          now,
          configRef.current,
        );
        gateRef.current = step.state;
        combined = step.ducked || turnActive;
      } else {
        combined = turnActive;
      }

      if (combined !== gateDuckedRef.current) {
        gateDuckedRef.current = combined;
        setDucked(combined);
        applyDesiredMute(micOnRef.current, combined);
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      try {
        source?.disconnect();
        analyser?.disconnect();
      } catch {
        // Node already gone with a closed context.
      }
      void ctx?.close().catch(() => undefined);
    };
  }, [enabled, duckingEnabled, audioElement, applyDesiredMute]);

  // Manual mute is the floor: whenever it flips during a live call,
  // re-apply the (unchanged) gate decision through the new micOn.
  React.useEffect(() => {
    if (!enabled) return;
    applyDesiredMute(micOn, gateDuckedRef.current);
  }, [enabled, micOn, applyDesiredMute]);

  // Leaving a live call (or unmounting with it already torn down) clears
  // the bookkeeping; the next live entry re-initialises everything.
  React.useEffect(() => {
    if (enabled) return;
    gateRef.current = createDuckGate();
    gateDuckedRef.current = false;
    appliedMutedRef.current = false;
    turnOpenRef.current = false;
    lastPersonaEventAtRef.current = Number.NEGATIVE_INFINITY;
    setDucked(false);
  }, [enabled]);

  return ducked;
}
