/**
 * Pure client-side logic for the server-side STT bridge.
 *
 * The bridge replaces the browser's SpeechRecognition, which failed fatally
 * (`network`) on the target browser: Brave's speech engine cannot reach its
 * backing service. Instead the client streams raw mic PCM over one
 * WebSocket per session and receives JSON transcript events:
 *
 *   client → server : BINARY frames of PCM16 little-endian 16 kHz MONO,
 *                     batched at ~100 ms (1600 samples = 3200 bytes);
 *                     text frames are JSON controls — {"type":"stop"} ends
 *                     the session.
 *   server → client : {"type":"ready","model":…}   session live — audio may
 *                                                 flow only after this
 *                     {"type":"partial","text":…}  live interim text
 *                     {"type":"final","text":…}    one per VAD-delimited
 *                                                 utterance — publishable
 *                     {"type":"done"}              clean end after stop
 *                     {"type":"error","message":…} FATAL; server closes
 *
 * The bridge's wss listener is crichton 6361 (infra/port-registry.json:
 * buzz → stt_bridge_https) — always built from the hostname the web app is
 * served from, never hardcoded to one host.
 *
 * Import-free, so `node --test` loads it.
 */

/** The bridge's input format: 16 kHz mono PCM16. */
export const STT_TARGET_RATE = 16_000;
/** One batch = 100 ms of 16 kHz audio = 1600 samples = 3200 bytes. */
export const STT_BATCH_SAMPLES = 1_600;

/** Build the bridge URL from the hostname the app is served from. */
export function sttBridgeUrl(hostname: string): string {
  return `wss://${hostname}:6361/stt`;
}

export type SttBridgeEvent =
  | { type: "ready"; model?: string }
  | { type: "partial"; text: string }
  | { type: "final"; text: string; language?: string }
  | { type: "done" }
  | { type: "error"; message?: string };

/**
 * Parse one server text frame. Returns null for anything that is not JSON
 * or not one of the five documented event shapes, so a malformed frame can
 * never masquerade as a transcript.
 */
export function parseBridgeEvent(raw: string): SttBridgeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const event = parsed as Record<string, unknown>;
  switch (event.type) {
    case "ready":
      return typeof event.model === "string"
        ? { type: "ready", model: event.model }
        : { type: "ready" };
    case "partial":
    case "final":
      if (typeof event.text !== "string") {
        return null;
      }
      return event.type === "partial"
        ? { type: "partial", text: event.text }
        : {
            type: "final",
            text: event.text,
            ...(typeof event.language === "string"
              ? { language: event.language }
              : {}),
          };
    case "done":
      return { type: "done" };
    case "error":
      return typeof event.message === "string"
        ? { type: "error", message: event.message }
        : { type: "error" };
    default:
      return null;
  }
}

/** Human message for a fatal bridge error event (or its absence). */
export function bridgeErrorMessage(event: SttBridgeEvent | null): string {
  if (
    event?.type === "error" &&
    typeof event.message === "string" &&
    event.message.trim().length > 0
  ) {
    return event.message.trim();
  }
  return "Speech recognition failed.";
}

/** Euclidean gcd on positive integers. */
function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

/**
 * Accumulates mic frames at the capture rate and emits them as 16 kHz mono
 * PCM16 little-endian batches for the STT bridge.
 *
 * Downsampling is a box filter with EXACT rational arithmetic: with
 * g = gcd(inputRate, 16000), each output sample averages the input samples
 * it covers, weighted by fractional coverage, over a group of p/q input
 * samples (p = inputRate/g, q = 16000/g). Positions are tracked in 1/q
 * input-sample units so no float drift accumulates across pushes, and the
 * group alignment survives arbitrary frame sizes. For the two rates that
 * actually occur — 48 kHz (p=3, q=1) and 16 kHz (p=1, q=1) — this is
 * exactly "average each adjacent group of 3" and "pass through untouched".
 *
 * `push` returns one full batch once at least 100 ms of 16 kHz audio is
 * pending (extra output stays pending for the next push), or null.
 * `flush` returns whatever has not reached a full batch (for the final,
 * short batch before a stop) and resets the batcher. An incomplete input
 * group at the tail is discarded — it is under one output sample of audio.
 */
export class PcmBatcher {
  /** Input-rate samples not yet consumed by a complete group. */
  private tail = new Float32Array(0);
  private tailLength = 0;
  /** Start of the next group inside `tail`, in 1/q input-sample units. */
  private carry = 0;
  /** Resampled 16 kHz samples waiting to be emitted as a batch. */
  private out = new Float32Array(0);
  private outLength = 0;

  push(frame: Float32Array, inputRate: number): ArrayBuffer | null {
    if (Number.isFinite(inputRate) && inputRate > 0 && frame.length > 0) {
      this.resample(frame, Math.round(inputRate));
    }
    if (this.outLength >= STT_BATCH_SAMPLES) {
      return this.emitBatch();
    }
    return null;
  }

  /** Emit the sub-batch remainder and reset all state. */
  flush(): ArrayBuffer | null {
    if (this.outLength === 0) {
      this.tailLength = 0;
      this.carry = 0;
      return null;
    }
    const bytes = this.toInt16(this.out, this.outLength);
    this.outLength = 0;
    this.tailLength = 0;
    this.carry = 0;
    return bytes;
  }

  /** Append a frame at `rate` Hz and drain every complete group out. */
  private resample(frame: Float32Array, rate: number): void {
    const g = gcd(rate, STT_TARGET_RATE);
    const p = rate / g;
    const q = STT_TARGET_RATE / g;

    this.ensureTailCapacity(this.tailLength + frame.length);
    this.tail.set(frame, this.tailLength);
    this.tailLength += frame.length;

    const availableUnits = this.tailLength * q;
    while (this.carry + p <= availableUnits) {
      const end = this.carry + p;
      // Weighted average over the half-open group [carry, end): each input
      // sample contributes its covered fraction of the group.
      let acc = 0;
      let pos = this.carry;
      while (pos < end) {
        const index = Math.floor(pos / q);
        const intoSample = pos - index * q;
        const take = Math.min(q - intoSample, end - pos);
        acc += take * this.tail[index];
        pos += take;
      }
      this.appendOut(acc / p);
      this.carry = end;
    }

    // Drop the consumed prefix; `carry` stays relative to tail[0].
    const consumed = Math.floor(this.carry / q);
    if (consumed > 0) {
      this.tail.copyWithin(0, consumed, this.tailLength);
      this.tailLength -= consumed;
      this.carry -= consumed * q;
    }
  }

  private ensureTailCapacity(needed: number): void {
    if (this.tail.length >= needed) {
      return;
    }
    const grown = new Float32Array(Math.max(needed, this.tail.length * 2, 256));
    grown.set(this.tail.subarray(0, this.tailLength));
    this.tail = grown;
  }

  private appendOut(sample: number): void {
    if (this.out.length === this.outLength) {
      const grown = new Float32Array(
        Math.max(this.outLength + 1, this.out.length * 2, STT_BATCH_SAMPLES),
      );
      grown.set(this.out.subarray(0, this.outLength));
      this.out = grown;
    }
    this.out[this.outLength] = sample;
    this.outLength += 1;
  }

  /** Take the first STT_BATCH_SAMPLES pending samples as one PCM16 batch. */
  private emitBatch(): ArrayBuffer {
    const bytes = this.toInt16(this.out, STT_BATCH_SAMPLES);
    this.out.copyWithin(0, STT_BATCH_SAMPLES, this.outLength);
    this.outLength -= STT_BATCH_SAMPLES;
    return bytes;
  }

  /** Float32 [-1, 1] → clamped PCM16 little-endian bytes. */
  private toInt16(samples: Float32Array, count: number): ArrayBuffer {
    const pcm = new Int16Array(count);
    for (let i = 0; i < count; i += 1) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = Math.round(clamped * 32767);
    }
    return pcm.buffer;
  }
}
