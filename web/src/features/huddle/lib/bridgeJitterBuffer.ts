/**
 * Adaptive jitter-buffer POLICY for the TTS bridge stream scheduler
 * (`bridgeSpeech.ts` → `playBridgeResponse`). Pure: no clock, no audio —
 * the scheduler feeds it numbers and asks "may I start scheduling now?".
 *
 * Why it exists (2026-09-29): with the GPU contended, Chatterbox generated
 * SLOWER than real time (RTF 1.3–1.9 — 6.2 s of audio took 7.9 s to
 * stream). The scheduler played every piece the moment it arrived, so the
 * tail kept running dry: ~0.5 s of speech, silence, 0.5 s, silence. The
 * fix trades a little up-front delay for continuous speech.
 *
 * The live shape that shaped these rules (QA traces, fixtures under
 * `__fixtures__/bridge-traces/`): ~0.45 s chunks arriving at roughly real
 * time at FIRST, then slowing to 0.6–0.7 s spacing. Chatterbox decelerates
 * within a sentence, so the rate measured at the start of a stream is the
 * OPTIMISTIC end of it. Every rule below is pessimistic for that reason:
 *
 *  1. The start target is `remaining × (1 − rate) × SAFETY` of buffered
 *     audio (while B seconds play, rate·B more arrive; B + rate·T ≥ T for
 *     T = remaining gives the bound), floored at
 *     {@link INITIAL_PREBUFFER_SECONDS}.
 *
 *  2. The rate is the PESSIMISTIC combination of what is known: with a
 *     remembered rate, `min(observed, history)`; with none (the first
 *     sentence of a session), the observed rate divided by
 *     {@link COLD_START_DERATE} to allow for the deceleration still to
 *     come — and no start at all before the rate is measurable
 *     ({@link MIN_RATE_WINDOW_SECONDS}), unless the stream has ended.
 *
 *  3. History remembers the rate a finished stream actually NEEDED
 *     ({@link sufficientRate}) — not its average, which hides the slow
 *     tail — smoothed with an EWMA that moves quickly toward slower and
 *     slowly toward faster, and only from streams long enough to measure
 *     ({@link MIN_HISTORY_AUDIO_SECONDS}; a "Sure." must not wipe it). It
 *     also calibrates the text-length estimate against real durations.
 *
 *  4. REBUFFER on underrun (a mis-estimate): same target, with a floor
 *     that doubles per underrun so it converges instead of stuttering.
 *
 *  5. Stream end ALWAYS flushes — the worst case is "play after download".
 *
 * Healthy path: a stream several times faster than real time stays above
 * 1 even after the derate, so the target is the 0.4 s floor and playback
 * starts as soon as the rate window closes (~0.25–0.35 s after first byte).
 */

/** Minimum buffered audio before the first start (seconds). */
export const INITIAL_PREBUFFER_SECONDS = 0.4;

/** Floor for the first rebuffer; doubles with each further underrun. */
export const REBUFFER_FLOOR_SECONDS = 0.4;

/** Headroom on the rate-derived target. */
export const REBUFFER_SAFETY = 1.1;

/**
 * Minimum wall time over which an in-stream arrival rate is trusted, and
 * (with no history) the minimum wait before the first start.
 */
export const MIN_RATE_WINDOW_SECONDS = 0.25;

/**
 * First-sentence pessimism: with no history, the observed early rate is
 * divided by this to allow for Chatterbox's in-sentence deceleration
 * (live: ~1.05 early → ~0.7 by the tail).
 */
export const COLD_START_DERATE = 1.25;

/**
 * Speaking-rate prior for the length estimate before any calibration.
 * Chatterbox measured ~22 chars/s (voice `jared`); 15 is the typical
 * English rate — an over-estimate costs only delay, an under-estimate a
 * gap. History's `lengthScale` replaces the guess after one real stream.
 */
export const ESTIMATE_CHARS_PER_SECOND = 15;

/** Streams shorter than this (audio) never update history. */
export const MIN_HISTORY_AUDIO_SECONDS = 1.5;

/** EWMA weights: move fast toward a slower rate, slowly toward faster. */
export const HISTORY_ALPHA_SLOWER = 0.7;
export const HISTORY_ALPHA_FASTER = 0.3;

/** Cross-stream memory. */
export interface BridgeRateHistory {
  /** Smoothed sufficient rate (audio s per wall s), null if never measured. */
  rate: number | null;
  /** Smoothed actual/estimated length ratio, null if never measured. */
  lengthScale: number | null;
}

export function createRateHistory(): BridgeRateHistory {
  return { rate: null, lengthScale: null };
}

/** Rough audio length a text chunk will synthesize to (uncalibrated). */
export function estimateSpeechSeconds(text: string): number {
  return text.trim().length / ESTIMATE_CHARS_PER_SECOND;
}

export interface JitterState {
  /** Audio received but not yet handed to the clock. */
  bufferedSeconds: number;
  /** All audio received this stream (scheduled + buffered). */
  receivedSeconds: number;
  /** Audio already handed to the clock. */
  scheduledSeconds: number;
  /**
   * Audio received AFTER the first read. The rate numerator: the first
   * read lands at elapsed 0 (and may be a prefetched backlog), so counting
   * it would overstate the rate early in the stream — exactly when the
   * start decision is made.
   */
  arrivedAfterFirstSeconds: number;
  /** Wall seconds since this stream's first read. */
  elapsedSeconds: number;
  /** Underruns observed so far this stream (0 = still on initial start). */
  underruns: number;
  /** Estimated total audio for this stream, if the caller knows the text. */
  expectedSeconds?: number | null;
  /** Remembered sufficient rate from earlier streams. */
  historyRate?: number | null;
  /** Remembered actual/estimated length ratio. */
  lengthScale?: number | null;
  /** The server has closed the body. */
  streamDone: boolean;
}

/** In-stream arrival rate (audio s per wall s) once measurable, else null. */
export function observedRate(state: JitterState): number | null {
  if (state.elapsedSeconds < MIN_RATE_WINDOW_SECONDS) return null;
  return state.arrivedAfterFirstSeconds / state.elapsedSeconds;
}

/**
 * The pessimistic rate the target is computed from: min(observed,
 * history) when history exists, observed / COLD_START_DERATE when it does
 * not, null when neither is known.
 */
export function planningRate(state: JitterState): number | null {
  const observed = observedRate(state);
  const history = state.historyRate ?? null;
  if (history !== null) {
    return observed === null ? history : Math.min(observed, history);
  }
  return observed === null ? null : observed / COLD_START_DERATE;
}

/**
 * How many seconds must be buffered before (re)starting playback.
 * Returns 0 when the stream is done (flush everything).
 */
export function prebufferTarget(state: JitterState): number {
  if (state.streamDone) return 0;
  const floor =
    state.underruns === 0
      ? INITIAL_PREBUFFER_SECONDS
      : REBUFFER_FLOOR_SECONDS * 2 ** (state.underruns - 1);
  const rate = planningRate(state);
  if (rate === null || rate >= 1) return floor;
  // Audio still to be played from the moment we (re)start. With a text
  // estimate: what's left of it (calibrated by history). Without one, or
  // once the estimate is exhausted after an underrun: assume at least as
  // much again as has arrived — sentence chunks are similar in length.
  const expected =
    state.expectedSeconds == null
      ? null
      : state.expectedSeconds * (state.lengthScale ?? 1);
  let remaining =
    expected !== null ? expected - state.scheduledSeconds : Number.NaN;
  if (!(remaining > 0) && state.underruns > 0) {
    remaining = state.receivedSeconds;
  }
  if (!(remaining > 0)) return floor;
  return Math.max(floor, remaining * (1 - rate) * REBUFFER_SAFETY);
}

/** May the scheduler hand the buffered audio to the clock now? */
export function shouldStartPlayback(state: JitterState): boolean {
  if (state.bufferedSeconds <= 0) return false;
  if (state.streamDone) return true;
  // Cold start: no history and no measurable rate yet — a fast-looking
  // first chunk says nothing about the stream, so wait for the window.
  if (
    state.underruns === 0 &&
    state.historyRate == null &&
    observedRate(state) === null
  ) {
    return false;
  }
  return state.bufferedSeconds >= prebufferTarget(state);
}

/** One network arrival: wall time (s) and audio length (s). */
export interface Arrival {
  t: number;
  seconds: number;
}

/**
 * The rate a finished stream actually NEEDED, in the terms of the start
 * formula: the start delay S that would have made it gapless is
 * max_i(t_i − t_0 − audio before i); the audio buffered by then is B; and
 * the rate r with `total × (1 − r) = B` is returned. A stream that never
 * needed more than its first read returns its (≥ 1) average rate. Null
 * when there is nothing to measure.
 */
export function sufficientRate(arrivals: readonly Arrival[]): number | null {
  if (arrivals.length < 2) return null;
  const t0 = arrivals[0].t;
  let total = 0;
  let requiredDelay = 0;
  for (const a of arrivals) {
    requiredDelay = Math.max(requiredDelay, a.t - t0 - total);
    total += a.seconds;
  }
  if (total <= 0) return null;
  const elapsed = arrivals[arrivals.length - 1].t - t0;
  if (requiredDelay <= 1e-3) {
    const avg = elapsed > 0 ? (total - arrivals[0].seconds) / elapsed : 1;
    return Math.max(1, avg);
  }
  let buffered = 0;
  for (const a of arrivals) {
    if (a.t - t0 > requiredDelay + 1e-9) break;
    buffered += a.seconds;
  }
  return Math.max(0, 1 - buffered / total);
}

/**
 * Fold a finished stream into history. Streams with too little audio or
 * too few arrivals to measure are ignored.
 */
export function updateRateHistory(
  history: BridgeRateHistory,
  stream: { arrivals: readonly Arrival[]; expectedSeconds?: number | null },
): void {
  const total = stream.arrivals.reduce((sum, a) => sum + a.seconds, 0);
  if (total < MIN_HISTORY_AUDIO_SECONDS || stream.arrivals.length < 3) return;
  const rate = sufficientRate(stream.arrivals);
  if (rate !== null) {
    if (history.rate === null) {
      history.rate = rate;
    } else {
      const alpha =
        rate < history.rate ? HISTORY_ALPHA_SLOWER : HISTORY_ALPHA_FASTER;
      history.rate = history.rate + alpha * (rate - history.rate);
    }
  }
  const expected = stream.expectedSeconds ?? null;
  if (expected !== null && expected > 0) {
    const scale = total / expected;
    history.lengthScale =
      history.lengthScale === null
        ? scale
        : history.lengthScale + 0.5 * (scale - history.lengthScale);
  }
}
