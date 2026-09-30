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
import {
  type BridgeCalibration,
  type CalibrationStorage,
  calFor,
  createCalibration,
  oracleOffset,
  saveCalibration,
  startAt,
  type TimedArrival,
  updateCalibration,
} from "./bridgeJitterBuffer.ts";

/** The bridge's output format: PCM16LE mono 24 kHz. */
export const BRIDGE_SAMPLE_RATE = 24_000;

/** Build the bridge synthesis URL from the hostname the app is served from. */
export function ttsBridgeUrl(hostname: string): string {
  return `https://${hostname}:6366/tts`;
}

/** What one selection asks the bridge for. */
export interface BridgeSpeakRequest {
  engine: "pocket" | "chatterbox" | "eleven";
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
 *  - `chatterbox:<slug>` → Chatterbox roster slug;
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
  if (selection.engine === "chatterbox") {
    return {
      engine: "chatterbox",
      voice: selection.key.slice("chatterbox:".length),
    };
  }
  if (selection.engine === "eleven") {
    return { engine: "eleven", voice: selection.key.slice("eleven:".length) };
  }
  return null;
}

/**
 * The voice slugs an agent with NO selection draws from — the shipped 11
 * Pocket presets minus `eve` (and never `evie`), each of which also exists
 * as a Chatterbox voice cloned from the SAME clip, so the draw keeps every
 * agent's identity across the engine switch. Order mirrors
 * `crates/buzz-voice/src/bundled.rs` and must NEVER be reordered or grown:
 * either reshuffles every agent's voice (design §4.5). Pinned by test.
 */
export const DERIVED_VOICE_SLUGS: readonly string[] = [
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

/** @deprecated legacy name — the same table, see {@link DERIVED_VOICE_SLUGS}. */
export const DERIVED_POCKET_PRESETS = DERIVED_VOICE_SLUGS;

/**
 * The bridge request for an agent that never published a selection.
 *
 * Before 2026-09-18 these agents spoke through local `speechSynthesis` —
 * the "crap robot" Sam hit in a live huddle — while every agent WITH a
 * selection had already moved to the bridge. The derived default is now a
 * Pocket preset, drawn deterministically from the pubkey so co-speakers
 * still sound different without anyone configuring anything (the same
 * differentiation intent as the derived pitch-spread, one level up).
 * Since 2026-09-27 the engine is Chatterbox (same slug, same clip).
 */
export function derivedBridgeVoice(pubkey: string): BridgeSpeakRequest {
  let h = 5381;
  for (let i = 0; i < pubkey.length; i++) {
    h = ((h << 5) + h + pubkey.charCodeAt(i)) | 0;
  }
  const index = Math.abs(h) % DERIVED_VOICE_SLUGS.length;
  return { engine: "chatterbox", voice: DERIVED_VOICE_SLUGS[index] };
}

/**
 * Split one network chunk into ALIGNED Int16 pieces of at most `maxSamples`.
 *
 * Two hardening rules earned the hard way (tts-lab, 2026-09-18):
 *  1. `new Int16Array(buffer, byteOffset, …)` THROWS on an odd byteOffset —
 *     fetch chunk boundaries are byte-aligned to nothing, so every chunk is
 *     COPIED into a fresh (offset-0) buffer before framing. A trailing odd
 *     byte is ignored HERE; the stream loop must carry it into the next
 *     chunk via {@link alignPcmChunk} (dropping it misframes every later
 *     sample into full-scale static — the "random hiss", 2026-09-27).
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

/**
 * Join a carried-over byte (if any) with the next network chunk and split
 * off the new odd trailing byte, so PCM16 framing stays aligned across
 * reads. Returns the even-length bytes to frame and the byte to carry.
 */
export function alignPcmChunk(
  carry: Uint8Array | null,
  value: Uint8Array,
): { aligned: Uint8Array; carry: Uint8Array | null } {
  let joined = value;
  if (carry && carry.byteLength > 0) {
    joined = new Uint8Array(carry.byteLength + value.byteLength);
    joined.set(carry, 0);
    joined.set(value, carry.byteLength);
  }
  const usable = joined.byteLength - (joined.byteLength % 2);
  return {
    aligned: joined.subarray(0, usable),
    carry: usable < joined.byteLength ? joined.slice(usable) : null,
  };
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
  /** Real contexts close; test doubles may omit it. */
  close?(): Promise<void>;
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

/** One network read, stamped with the audio clock when it ARRIVED. */
export interface TimedChunk {
  bytes: Uint8Array;
  at: number;
}

/**
 * A response body being read AHEAD of playback, each chunk timestamped on
 * arrival. The jitter policy needs TRUE arrival times: a prefetched
 * sentence's body that sat unread until its turn would otherwise look like
 * one instant burst, hiding exactly the generation speed the policy plans
 * from.
 */
export interface TimedDrain {
  /** The next chunk, or null at end of stream. Rejects on a stream error. */
  next(): Promise<TimedChunk | null>;
  /** Stop reading and release the body. */
  cancel(): void;
}

/**
 * Unconsumed bytes a drain may hold before it pauses reading (~6 s of
 * 24 kHz PCM16 — above one server sentence on the bridge route, which
 * `chunkBridgeText` caps at 200 chars).
 */
export const DRAIN_MAX_BUFFERED_BYTES = 300_000;

/**
 * Start reading `response` NOW (call it on headers), stamping each chunk
 * with `clock.currentTime`. Bounded: past `maxBufferedBytes` unconsumed it
 * stops reading until the consumer catches up. Cancelable.
 */
export function drainTimed(
  response: Pick<Response, "body">,
  clock: { readonly currentTime: number },
  maxBufferedBytes = DRAIN_MAX_BUFFERED_BYTES,
): TimedDrain {
  const queue: TimedChunk[] = [];
  let queuedBytes = 0;
  let ended = false;
  let cancelled = false;
  let failure: unknown = null;
  let wakeConsumer: (() => void) | null = null;
  let resumeReader: (() => void) | null = null;
  const reader = response.body?.getReader() ?? null;
  const notify = () => {
    const wake = wakeConsumer;
    wakeConsumer = null;
    wake?.();
  };
  const pump = async () => {
    if (reader === null) return;
    while (!cancelled) {
      if (queuedBytes >= maxBufferedBytes) {
        await new Promise<void>((resolve) => {
          resumeReader = resolve;
        });
        continue;
      }
      const { done, value } = await reader.read();
      if (done) return;
      if (!value || value.byteLength === 0) continue;
      queue.push({ bytes: value, at: clock.currentTime });
      queuedBytes += value.byteLength;
      notify();
    }
  };
  void pump()
    .catch((error: unknown) => {
      failure = error;
    })
    .finally(() => {
      ended = true;
      notify();
    });
  return {
    async next() {
      while (queue.length === 0 && !ended && !cancelled) {
        await new Promise<void>((resolve) => {
          wakeConsumer = resolve;
        });
      }
      const chunk = queue.shift();
      if (chunk) {
        queuedBytes -= chunk.bytes.byteLength;
        const resume = resumeReader;
        resumeReader = null;
        resume?.();
        return chunk;
      }
      if (failure !== null && !cancelled) throw failure;
      return null;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      queue.length = 0;
      queuedBytes = 0;
      reader?.cancel().catch(() => {});
      const resume = resumeReader;
      resumeReader = null;
      resume?.();
      notify();
    },
  };
}

function isTimedDrain(source: unknown): source is TimedDrain {
  return (
    typeof source === "object" &&
    source !== null &&
    typeof (source as TimedDrain).next === "function" &&
    typeof (source as TimedDrain).cancel === "function"
  );
}

/** One finished stream, kept for diagnostics (last 50). */
export interface BridgeStreamResult {
  voiceKey: string | null;
  chars: number;
  audioSeconds: number;
  /** First scheduled start minus first arrival (s), null if never started. */
  startDelay: number | null;
  /** Oracle gapless start delay (s). */
  idealDelay: number;
  underruns: number;
  completed: boolean;
  at: number;
}

const STREAM_LOG_LIMIT = 50;
const streamLog: BridgeStreamResult[] = [];

/** The most recent bridge streams (oldest first, at most 50). */
export function recentBridgeStreams(): readonly BridgeStreamResult[] {
  return streamLog;
}

/** Jitter-buffer inputs for one stream (see `bridgeJitterBuffer.ts`). */
export interface BridgeJitterOptions {
  /** Characters of the text this stream speaks (length prior). */
  chars?: number;
  /** `engine:voice` — the calibration key. */
  voiceKey?: string;
  /** Shared calibration; updated (and saved) when the stream completes. */
  calibration?: BridgeCalibration;
  /** Where to persist; defaults to localStorage in a browser, null = don't. */
  storage?: CalibrationStorage | null;
}

/**
 * Play a bridge PCM stream as it arrives, resolving when the last
 * scheduled piece has finished sounding.
 *
 * `source` is either a Response (drained here) or a {@link TimedDrain}
 * the caller started on headers — the prefetch path, so a sentence's
 * arrivals keep their true timestamps while the previous one plays.
 *
 * Arrivals are held in an adaptive JITTER BUFFER: the policy
 * ({@link startAt}) predicts the earliest clock time from which the rest
 * of the sentence plays gapless; the loop races the next read against a
 * wake timer at that time and flushes once `currentTime >= startAt`. If
 * the scheduled tail runs dry before more audio arrives (an underrun),
 * scheduling pauses and the policy re-plans with a larger margin. Stream
 * end always flushes. An interrupt stops scheduled sources and never
 * schedules held audio.
 */
export async function playBridgeResponse(
  source: Pick<Response, "body"> | TimedDrain,
  audioContext: BridgeAudioContextLike,
  options: {
    /** Called if the scheduler must abort (stop token bumped). */
    shouldStop?: () => boolean;
    /** Injected timer so tests don't wait wall-clock. Returns a cancel fn. */
    scheduleSettle?: (delayMs: number, fn: () => void) => () => void;
    /** Injected jitter-buffer wake timer (same shape). */
    scheduleWake?: (delayMs: number, fn: () => void) => () => void;
    /**
     * Where the audio goes. Defaults to the context's own output; the
     * huddle passes a gain node so the speaker mute covers agent speech
     * the same way it covers peers.
     */
    destination?: AudioNode;
    jitter?: BridgeJitterOptions;
  } = {},
): Promise<{ seconds: number }> {
  const shouldStop = options.shouldStop ?? (() => false);
  const timer = (delayMs: number, fn: () => void) => {
    const t = setTimeout(fn, delayMs);
    return () => clearTimeout(t);
  };
  const settleAfter = options.scheduleSettle ?? timer;
  const wakeAfter = options.scheduleWake ?? timer;

  let drain: TimedDrain;
  if (isTimedDrain(source)) {
    drain = source;
  } else {
    if (source.body === null) {
      return { seconds: 0 };
    }
    drain = drainTimed(source, audioContext);
  }
  const destination = options.destination ?? audioContext.destination;
  const chars = options.jitter?.chars ?? 0;
  const voiceKey = options.jitter?.voiceKey ?? null;
  const calibration = options.jitter?.calibration ?? createCalibration();
  const calView = calFor(calibration, voiceKey ?? "");
  let queueAt = audioContext.currentTime + 0.02;
  let samples = 0;
  /**
   * Every source handed to the clock, so an abort can silence the ones
   * already scheduled — see {@link BridgeBufferSourceLike.stop}.
   */
  const scheduled: BridgeBufferSourceLike[] = [];
  const stopScheduled = () => {
    for (const src of scheduled) {
      try {
        src.stop?.();
      } catch {
        // A source that already ended throws on stop(); nothing to do.
      }
    }
    scheduled.length = 0;
  };

  // Jitter-buffer state. `pending` is received-but-unscheduled audio;
  // `flowing` is true while arrivals go straight to the clock.
  const pending: Int16Array[] = [];
  let pendingSamples = 0;
  let underruns = 0;
  let flowing = false;
  let firstStart: number | null = null;
  const arrivals: TimedArrival[] = [];

  const flushPending = () => {
    if (!flowing) {
      // (Re)starting after a hold: begin a fresh schedule at the clock.
      queueAt = Math.max(queueAt, audioContext.currentTime + 0.02);
      firstStart ??= queueAt;
      flowing = true;
    }
    for (const piece of pending) {
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
    pending.length = 0;
    pendingSamples = 0;
  };

  const plannedStart = (): number | null =>
    startAt({
      arrivals,
      now: audioContext.currentTime,
      done: false,
      chars,
      scheduled: samples / BRIDGE_SAMPLE_RATE,
      underruns,
      cal: calView,
    });

  let carry: Uint8Array | null = null;
  let completed = false;
  let read: Promise<TimedChunk | null> | null = null;
  // An interrupt must not wait for the next read or wake to notice it.
  let stopPoll: ReturnType<typeof setInterval> | null = null;
  let wakeOnStop: (() => void) | null = null;
  const stopped = new Promise<"stop">((resolve) => {
    wakeOnStop = () => resolve("stop");
    stopPoll = setInterval(() => {
      if (shouldStop()) resolve("stop");
    }, 50);
  });
  try {
    while (true) {
      if (shouldStop()) {
        drain.cancel();
        // Held (unscheduled) audio is simply never scheduled; only what
        // already reached the clock needs stopping.
        stopScheduled();
        break;
      }
      if (!flowing && pendingSamples > 0) {
        const at = plannedStart();
        if (at !== null && audioContext.currentTime >= at - 1e-9) {
          flushPending();
        }
      }
      read ??= drain.next();
      let cancelWake = () => {};
      const racers: Array<Promise<TimedChunk | null | "wake" | "stop">> = [
        read,
        stopped,
      ];
      if (!flowing && pendingSamples > 0) {
        const at = plannedStart();
        if (at !== null && Number.isFinite(at)) {
          const delayMs = Math.max(0, (at - audioContext.currentTime) * 1000);
          racers.push(
            new Promise<"wake">((resolve) => {
              cancelWake = wakeAfter(delayMs, () => resolve("wake"));
            }),
          );
        }
      }
      const result = await Promise.race(racers);
      cancelWake();
      if (result === "wake" || result === "stop") continue;
      read = null;
      if (result === null) {
        completed = true;
        if (pendingSamples > 0 && !shouldStop()) flushPending();
        break;
      }
      const framed = alignPcmChunk(carry, result.bytes);
      carry = framed.carry;
      const pieces = chunkToInt16Pieces(framed.aligned, BRIDGE_PIECE_SAMPLES);
      let arrived = 0;
      for (const piece of pieces) {
        pending.push(piece);
        arrived += piece.length;
      }
      if (arrived === 0) continue;
      pendingSamples += arrived;
      arrivals.push({ t: result.at, s: arrived / BRIDGE_SAMPLE_RATE });
      if (flowing && queueAt <= audioContext.currentTime) {
        // UNDERRUN: the schedule sounded out before this audio arrived.
        // Hold it and re-plan rather than play it the moment it lands.
        flowing = false;
        underruns += 1;
      }
      if (flowing) flushPending();
    }
  } finally {
    if (stopPoll !== null) clearInterval(stopPoll);
    (wakeOnStop as (() => void) | null)?.();
    if (read !== null) {
      // A read left racing after an abort must not surface unhandled.
      read.catch(() => {});
    }
  }

  const audioSeconds = arrivals.reduce((sum, a) => sum + a.s, 0);
  if (completed && voiceKey !== null && arrivals.length > 0) {
    updateCalibration(calibration, voiceKey, arrivals, chars);
    saveCalibration(calibration, options.jitter?.storage);
  }
  if (arrivals.length > 0) {
    streamLog.push({
      voiceKey,
      chars,
      audioSeconds,
      startDelay: firstStart === null ? null : firstStart - arrivals[0].t,
      idealDelay: oracleOffset(arrivals),
      underruns,
      completed,
      at: Date.now(),
    });
    if (streamLog.length > STREAM_LOG_LIMIT) streamLog.shift();
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
