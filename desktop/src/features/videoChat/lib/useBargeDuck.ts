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
 * The slice of the Anam client the duck loop needs, stated structurally so
 * tests can pass a recording fake instead of the real SDK client.
 */
export interface DuckMuteClient {
  muteInputAudio: () => unknown;
  unmuteInputAudio: () => unknown;
}

/**
 * Barge-in auto-duck for the video-chat persona.
 *
 * While `enabled` (state === "live"), the persona <audio> element is routed
 * through a WebAudio analyser (source → analyser → destination: the element
 * MUST be re-connected to the destination or playback can stop in some
 * webviews) and its RMS drives the `duckGate` state machine. Gate close =
 * the persona is speaking → `client.muteInputAudio()`; gate open = she is
 * done → `client.unmuteInputAudio()`.
 *
 * The manual mute button is the user's floor: a manually muted mic is never
 * unmuted by the gate. The SDK client's real mute state always converges to
 * `!micOn || gateDucked` — see `applyDesiredMute`, the single writer.
 *
 * Outside a live call this hook does nothing: no loop, no AudioContext, no
 * client calls.
 */
export function useBargeDuck(params: {
  /** True only while the call is live. */
  enabled: boolean;
  /** Manual mute state — false is the user's floor over the gate. */
  micOn: boolean;
  /** The persona audio element to analyse. */
  audioElement: HTMLAudioElement | null;
  /** Live Anam client, or null whenever there is nothing to drive. */
  client: DuckMuteClient | null;
  config?: DuckGateConfig;
}): boolean {
  const { enabled, micOn, audioElement, client } = params;
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

  // The duck loop — mounted only for a live call.
  React.useEffect(() => {
    if (!enabled) return;

    // A fresh session means a fresh SDK client (input unmuted) and a
    // fresh gate. Reconcile both up front: this is what restores mute
    // on a restarted call whose manual mute survived (micOn stays
    // false), and what leaves an open mic untouched.
    gateRef.current = createDuckGate();
    gateDuckedRef.current = false;
    appliedMutedRef.current = false;
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
      // Analyser unavailable — degrade to manual mute only.
      void ctx?.close().catch(() => undefined);
      return;
    }

    let raf = 0;
    let lastSampleAt = Number.NEGATIVE_INFINITY;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
      lastSampleAt = now;

      const analyserNode = analyser;
      const samples = buffer;
      if (!analyserNode || !samples) return;
      analyserNode.getFloatTimeDomainData(samples);
      const step = stepDuckGate(
        gateRef.current,
        computeRms(samples),
        now,
        configRef.current,
      );
      gateRef.current = step.state;
      if (step.changed) {
        gateDuckedRef.current = step.ducked;
        setDucked(step.ducked);
        applyDesiredMute(micOnRef.current, step.ducked);
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
  }, [enabled, audioElement, applyDesiredMute]);

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
    setDucked(false);
  }, [enabled]);

  return ducked;
}
