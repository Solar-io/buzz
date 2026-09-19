/**
 * Server-side TTS bridge client — the engine behind pocket and eleven
 * selections in a browser huddle.
 *
 * The bridge is the tts sibling of `lib/sttBridge.ts`: a Bun service on
 * crichton (tailscale serve https 6366 → 127.0.0.1:6365) holding the engine
 * access the browser cannot have — the local pocket-tts process and the
 * ElevenLabs key. One POST returns a PCM16LE mono 24 kHz stream; this module
 * maps a kind-30182 selection onto that POST and plays the stream through
 * WebAudio as it arrives.
 *
 * Import-free apart from the TYPE-only selection import, so `node --test`
 * loads it.
 */

import type { AgentVoiceSelection } from "../../voice/lib/agentVoiceSelection.ts";

/** The bridge's output format: PCM16LE mono 24 kHz. */
export const BRIDGE_SAMPLE_RATE = 24_000;

/** Build the bridge synthesis URL from the hostname the app is served from. */
export function ttsBridgeUrl(hostname: string): string {
  return `https://${hostname}:6366/tts`;
}

/** What one selection asks the bridge for. */
export interface BridgeSpeakRequest {
  engine: "pocket" | "eleven";
  voice: string;
}

/**
 * Map a kind-30182 selection onto a bridge request, or null when the
 * selection names something the bridge cannot run:
 *
 *  - `pocket:<slug>` → preset voice (one of the 12 bundled presets);
 *  - `pocket:imported:<hash>` → null — the bridge's pocket adapter
 *    accepts preset names and http(s) voice URLs, not imported-hash keys.
 *    `speakRoute` intercepts that null and executes the derived-bridge
 *    Pocket default instead (disposition
 *    `pocket-selected-pending-engine`), so the OS robot is never the
 *    fallback for an imported selection.
 *  - `eleven:<voiceid>` → ElevenLabs voice id.
 */
export function selectionToBridgeRequest(
  selection: AgentVoiceSelection,
): BridgeSpeakRequest | null {
  if (selection.engine === "pocket") {
    if (selection.key.startsWith("pocket:imported:")) {
      return null;
    }
    return { engine: "pocket", voice: selection.key.slice("pocket:".length) };
  }
  if (selection.engine === "eleven") {
    return { engine: "eleven", voice: selection.key.slice("eleven:".length) };
  }
  return null;
}

/**
 * The bundled Pocket presets an agent with NO published selection draws
 * from — the shipped 11 minus `pocket:eve`, which is excluded from the
 * default draw for consistency with its catalog-publication ban. Order
 * mirrors `crates/buzz-voice/src/bundled.rs`.
 */
export const DERIVED_POCKET_PRESETS: readonly string[] = [
  "anna",
  "vera",
  "fantine",
  "charles",
  "paul",
  "eponine",
  "azelma",
  "george",
  "mary",
  "jane",
  "michael",
];

/**
 * The bridge request for an agent that never published a selection.
 *
 * Before 2026-09-18 these agents spoke through local `speechSynthesis` —
 * the "crap robot" Sam hit in a live huddle — while every agent WITH a
 * selection had already moved to the bridge. The derived default is now a
 * Pocket preset, drawn deterministically from the pubkey so co-speakers
 * still sound different without anyone configuring anything (the same
 * differentiation intent as the derived pitch-spread, one level up).
 */
export function derivedBridgeVoice(pubkey: string): BridgeSpeakRequest {
  let h = 5381;
  for (let i = 0; i < pubkey.length; i++) {
    h = ((h << 5) + h + pubkey.charCodeAt(i)) | 0;
  }
  const index = Math.abs(h) % DERIVED_POCKET_PRESETS.length;
  return { engine: "pocket", voice: DERIVED_POCKET_PRESETS[index] };
}

/**
 * Split one network chunk into ALIGNED Int16 pieces of at most `maxSamples`.
 *
 * Two hardening rules earned the hard way (tts-lab, 2026-09-18):
 *  1. `new Int16Array(buffer, byteOffset, …)` THROWS on an odd byteOffset —
 *     fetch chunk boundaries are byte-aligned to nothing, so every chunk is
 *     COPIED into a fresh (offset-0) buffer before framing.
 *  2. A giant single-chunk buffer (qwen serves whole files; pocket streams,
 *     eleven streams) scheduled as one source is the loud-garbage failure
 *     shape — pieces of ≤0.25 s schedule and settle like streaming audio.
 */
export function chunkToInt16Pieces(
  value: Uint8Array,
  maxSamples: number,
): Int16Array[] {
  const usable = value.byteLength - (value.byteLength % 2);
  const copy = new Uint8Array(usable);
  copy.set(value.subarray(0, usable));
  const view = new Int16Array(copy.buffer);
  const pieces: Int16Array[] = [];
  for (let off = 0; off < view.length; off += maxSamples) {
    pieces.push(view.subarray(off, Math.min(off + maxSamples, view.length)));
  }
  return pieces;
}

/** The scheduling piece size: 0.25 s of 24 kHz audio. */
export const BRIDGE_PIECE_SAMPLES = Math.floor(BRIDGE_SAMPLE_RATE / 4);

/** The minimal AudioContext surface the player needs (tests stub it). */
export interface BridgeAudioContextLike {
  currentTime: number;
  destination: AudioNode;
  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): AudioBufferLike;
  createBufferSource(): BridgeBufferSourceLike;
}

export interface AudioBufferLike {
  copyToChannel(source: Float32Array, channelNumber: number): void;
}

export interface BridgeBufferSourceLike {
  buffer: AudioBufferLike | null;
  connect(destination: AudioNode): void;
  start(when: number): void;
  /**
   * Cancel a source that is playing or still scheduled.
   *
   * Optional only because the contract predates barge-in; every real
   * `AudioBufferSourceNode` has it. Without it an "interrupt" would abort
   * the fetch and leave up to a whole reply's worth of already-scheduled
   * buffers to play out — which is not an interrupt, it is a delay.
   */
  stop?(when?: number): void;
}

/** Convert an aligned Int16 piece to the Float32 WebAudio consumes. */
export function int16ToFloat32(piece: Int16Array): Float32Array {
  const f32 = new Float32Array(piece.length);
  for (let i = 0; i < piece.length; i++) {
    f32[i] = piece[i] / 32768;
  }
  return f32;
}

/**
 * Play a bridge PCM response as it arrives, resolving when the last
 * scheduled piece has finished sounding.
 *
 * `fetchImpl` and `audioContext` are injected so tests can drive the pure
 * scheduling logic; production passes `fetch` and a lazily-created
 * AudioContext (sampleRate 24 kHz with a fallback to the default — buffers
 * carry their own rate and the context resamples on playback).
 */
export async function playBridgeResponse(
  response: Response,
  audioContext: BridgeAudioContextLike,
  options: {
    /** Called if the scheduler must abort (stop token bumped). */
    shouldStop?: () => boolean;
    /** Injected timer so tests don't wait wall-clock. Returns a cancel fn. */
    scheduleSettle?: (delayMs: number, fn: () => void) => () => void;
    /**
     * Where the audio goes. Defaults to the context's own output; the
     * huddle passes a gain node so the speaker mute covers agent speech
     * the same way it covers peers.
     */
    destination?: AudioNode;
  } = {},
): Promise<{ seconds: number }> {
  const shouldStop = options.shouldStop ?? (() => false);
  const settleAfter =
    options.scheduleSettle ??
    ((delayMs: number, fn: () => void) => {
      const t = setTimeout(fn, delayMs);
      return () => clearTimeout(t);
    });

  const body = response.body;
  if (body === null) {
    return { seconds: 0 };
  }
  const reader = body.getReader();
  const destination = options.destination ?? audioContext.destination;
  let queueAt = audioContext.currentTime + 0.02;
  let samples = 0;
  /**
   * Every source handed to the clock, so an abort can silence the ones
   * already scheduled — see {@link BridgeBufferSourceLike.stop}.
   */
  const scheduled: BridgeBufferSourceLike[] = [];
  const stopScheduled = () => {
    for (const source of scheduled) {
      try {
        source.stop?.();
      } catch {
        // A source that already ended throws on stop(); nothing to do.
      }
    }
    scheduled.length = 0;
  };

  while (true) {
    if (shouldStop()) {
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
      stopScheduled();
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    for (const piece of chunkToInt16Pieces(value, BRIDGE_PIECE_SAMPLES)) {
      const f32 = int16ToFloat32(piece);
      const buf = audioContext.createBuffer(1, f32.length, BRIDGE_SAMPLE_RATE);
      buf.copyToChannel(f32, 0);
      const src = audioContext.createBufferSource();
      src.buffer = buf;
      src.connect(destination);
      const when = Math.max(queueAt, audioContext.currentTime);
      src.start(when);
      scheduled.push(src);
      queueAt = when + f32.length / BRIDGE_SAMPLE_RATE;
      samples += piece.length;
    }
  }

  // Settle when the tail of the schedule has sounded (setTimeout is the
  // portable backstop; the sources stop themselves at their stop times).
  const remainingMs = Math.max(0, (queueAt - audioContext.currentTime) * 1000);
  await new Promise<void>((resolveRaw) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(check);
      cancelSettle();
      resolveRaw();
    };
    const cancelSettle = settleAfter(remainingMs + 30, finish);
    const check = setInterval(() => {
      if (shouldStop()) {
        // An interrupt during the tail must silence the queue, not merely
        // stop waiting for it.
        stopScheduled();
        finish();
      }
    }, 50);
  });

  return { seconds: samples / BRIDGE_SAMPLE_RATE };
}
